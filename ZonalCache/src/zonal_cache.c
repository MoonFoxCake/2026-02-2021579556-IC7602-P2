/* zonal_cache.c — servidor de la Zonal Cache (IC7602 P2). GNU C, HTTP/1.1, hilos POSIX.
 *
 * Por cada conexión:
 *   1. (HTTPS) SSL termination con OpenSSL (zc_tls, con SNI).
 *   2. Lee la petición (línea, encabezados, cuerpo con Content-Length; soporta "Expect: 100-continue").
 *   3. zc_gate_handle(): busca dominio/URL en la config que vino de Firebase (API Node.js), atiende
 *      /__zc/login|callback|logout y valida seguridad (x-api-key o usuario/contraseña + sesión).
 *   4. Si la petición se permite:
 *        - si es cacheable y está en disco y vigente  -> se sirve desde disco      (X-Cache: HIT)
 *        - si no, se pide al ORIGEN real con libcurl (HTTP o HTTPS), se responde al cliente y,
 *          si es GET 200 cacheable, se guarda en disco y se registra en el índice de políticas
 *          (LRU/LFU/FIFO/MRU/Random, TTL, límite por dominio y por URL)            (X-Cache: MISS)
 *        - si no es cacheable (POST/PUT/DELETE, tipo no configurado, etc.)         (X-Cache: BYPASS)
 *
 * Formato del objeto en disco: <ZC_CACHE_DIR>/<dominio>/<sha256>
 *     "ZC1\n" <Content-Type> "\n" <cuerpo>
 * Un solo archivo por objeto: el callback de expulsión de la biblioteca (zc_gate_evict_file) lo borra entero.
 *
 * Variables de entorno (además de las de zc_gate: ZC_CONFIG_*, ZC_ZONE, ZC_LOGIN_*, ZC_CACHE_DIR, ZC_TLS_*):
 *   ZC_HTTP_PORT (8080)            ZC_HTTPS_PORT (8443, solo si hay ZC_TLS_CERT_FILE/ZC_TLS_KEY_FILE)
 *   ZC_MAX_REQUEST_BODY (10 MiB)   ZC_MAX_OBJECT_BYTES (50 MiB: respuesta máxima del origen)
 *   ZC_ORIGIN_TIMEOUT_SECS (30)    ZC_ORIGIN_CONNECT_TIMEOUT_SECS (10)
 *   ZC_ORIGIN_TLS_VERIFY (1)       ZC_ORIGIN_CA_FILE (opcional: CA extra para orígenes HTTPS)
 *   ZC_CLIENT_TIMEOUT_SECS (15)    ZC_STARTUP_RETRIES (30: reintentos de 2 s si el API aún no responde)
 *   ZC_BIND_ADDR (opcional: IPv4 donde escuchar; por defecto todas)
 */
#define _GNU_SOURCE
#include "zc_gate.h"
#include "zc_tls.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <signal.h>
#include <unistd.h>
#include <errno.h>
#include <pthread.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <curl/curl.h>

#define MAX_HEAD    32768
#define MAX_HEADERS 100
#define OBJ_MAGIC   "ZC1\n"

/* ---------------------------------------------------------------- configuración */
static struct {
    size_t max_req_body, max_object;
    long   origin_timeout, origin_connect_timeout, client_timeout;
    int    origin_verify;
    const char *origin_ca, *zone;
} O;

static long env_long(const char *name, long def) {
    const char *s = getenv(name);
    if (!s || !*s) return def;
    char *end; long v = strtol(s, &end, 10);
    return (*end || v < 0) ? def : v;
}

static void load_options(void) {
    O.max_req_body           = (size_t)env_long("ZC_MAX_REQUEST_BODY", 10L * 1024 * 1024);
    O.max_object             = (size_t)env_long("ZC_MAX_OBJECT_BYTES", 50L * 1024 * 1024);
    O.origin_timeout         = env_long("ZC_ORIGIN_TIMEOUT_SECS", 30);
    O.origin_connect_timeout = env_long("ZC_ORIGIN_CONNECT_TIMEOUT_SECS", 10);
    O.client_timeout         = env_long("ZC_CLIENT_TIMEOUT_SECS", 15);
    O.origin_verify          = (int)env_long("ZC_ORIGIN_TLS_VERIFY", 1) != 0;
    O.origin_ca              = getenv("ZC_ORIGIN_CA_FILE");
    O.zone                   = getenv("ZC_ZONE") ? getenv("ZC_ZONE") : "";
}

/* ---------------------------------------------------------------- conexión */
typedef struct { int fd; SSL *ssl; int want_tls; char ip[64]; } conn_t;

static SSL_CTX *TLS;
static volatile sig_atomic_t STOP;

static int c_read(conn_t *c, void *b, int n) {
    return c->ssl ? zc_tls_read(c->ssl, b, n) : (int)recv(c->fd, b, (size_t)n, 0);
}
static int c_write_all(conn_t *c, const void *b, size_t n) {
    const char *p = b;
    while (n) {
        int chunk = n > (1u << 30) ? (1 << 30) : (int)n;
        int w = c->ssl ? zc_tls_write(c->ssl, p, chunk) : (int)send(c->fd, p, (size_t)chunk, MSG_NOSIGNAL);
        if (w <= 0) return -1;
        p += w; n -= (size_t)w;
    }
    return 0;
}

static const char *reason(int s) {
    switch (s) {
        case 100: return "Continue"; case 200: return "OK"; case 201: return "Created"; case 202: return "Accepted";
        case 204: return "No Content"; case 206: return "Partial Content";
        case 301: return "Moved Permanently"; case 302: return "Found"; case 303: return "See Other";
        case 304: return "Not Modified"; case 307: return "Temporary Redirect"; case 308: return "Permanent Redirect";
        case 400: return "Bad Request"; case 401: return "Unauthorized"; case 403: return "Forbidden";
        case 404: return "Not Found"; case 405: return "Method Not Allowed"; case 409: return "Conflict";
        case 411: return "Length Required"; case 413: return "Payload Too Large"; case 415: return "Unsupported Media Type";
        case 422: return "Unprocessable Entity"; case 429: return "Too Many Requests";
        case 500: return "Internal Server Error"; case 501: return "Not Implemented"; case 502: return "Bad Gateway";
        case 503: return "Service Unavailable"; case 504: return "Gateway Timeout";
        default:  return s < 300 ? "OK" : s < 400 ? "Redirect" : s < 500 ? "Client Error" : "Server Error";
    }
}

/* status sin cuerpo según RFC 9110 */
static int status_has_body(int s) { return !(s == 204 || s == 304 || (s >= 100 && s < 200)); }

static void send_resp(conn_t *c, int status, const char *ctype, const char *extra,
                      const char *body, size_t blen, int head_only) {
    char *h = NULL;
    int has_body = status_has_body(status);
    int n = asprintf(&h, "HTTP/1.1 %d %s\r\n%s%s%sContent-Length: %zu\r\nConnection: close\r\n"
                         "Server: zonal-cache\r\n%s\r\n",
                     status, reason(status),
                     has_body && ctype ? "Content-Type: " : "", has_body && ctype ? ctype : "", has_body && ctype ? "\r\n" : "",
                     has_body ? blen : 0, extra ? extra : "");
    if (n < 0) return;
    c_write_all(c, h, (size_t)n);
    free(h);
    if (!head_only && has_body && body && blen) c_write_all(c, body, blen);
}

static void send_error(conn_t *c, int status, const char *msg) {
    char *b = NULL;
    if (asprintf(&b, "<!doctype html><html lang=\"es\"><meta charset=\"utf-8\"><title>%d %s</title>"
                     "<body style=\"font-family:system-ui,sans-serif;margin:3rem\"><h1>%d %s</h1><p>%s</p>"
                     "<p><small>zonal-cache %s</small></p></body></html>",
                 status, reason(status), status, reason(status), msg, O.zone) < 0) b = NULL;
    send_resp(c, status, "text/html; charset=utf-8", "Cache-Control: no-store\r\n", b, b ? strlen(b) : 0, 0);
    free(b);
}

/* ---------------------------------------------------------------- petición */
typedef struct { char *name, *value; } hdr_t;

typedef struct {
    char    method[16];
    char    target[2048];   /* forma origen: "/ruta?query" */
    char    host[300];
    hdr_t   h[MAX_HEADERS];
    int     nh;
    char   *body;           /* apunta dentro de buf o a un malloc propio */
    size_t  body_len;
    char   *buf;            /* bloque leído (encabezados + inicio del cuerpo) */
    char   *body_owned;
} req_t;

static const char *req_header(const req_t *r, const char *name) {
    for (int i = 0; i < r->nh; i++) if (!strcasecmp(r->h[i].name, name)) return r->h[i].value;
    return NULL;
}

static void req_free(req_t *r) { free(r->buf); free(r->body_owned); }

static char *trim(char *s) {
    while (*s == ' ' || *s == '\t') s++;
    char *e = s + strlen(s);
    while (e > s && (e[-1] == ' ' || e[-1] == '\t' || e[-1] == '\r')) *--e = '\0';
    return s;
}

/* Lee y parsea la petición. 0 ok; si falla, devuelve el status HTTP a responder (o -1 = cerrar sin responder). */
static int read_request(conn_t *c, req_t *r) {
    memset(r, 0, sizeof(*r));
    r->buf = malloc(MAX_HEAD + 1);
    if (!r->buf) return 500;
    size_t n = 0; char *eoh = NULL;
    while (!(eoh = memmem(r->buf, n, "\r\n\r\n", 4))) {
        if (n >= MAX_HEAD) return 431;
        int k = c_read(c, r->buf + n, (int)(MAX_HEAD - n));
        if (k <= 0) return n ? 400 : -1;
        n += (size_t)k;
    }
    r->buf[n] = '\0';
    *eoh = '\0';
    char *rest = eoh + 4; size_t have = n - (size_t)(rest - r->buf);

    /* línea de petición */
    char *line = r->buf, *nl = strstr(line, "\r\n");
    if (nl) *nl = '\0';
    char version[16] = "";
    if (sscanf(line, "%15s %2047s %15s", r->method, r->target, version) != 3 || strncmp(version, "HTTP/1.", 7)) return 400;

    /* encabezados */
    for (char *p = nl ? nl + 2 : NULL; p && *p && r->nh < MAX_HEADERS; ) {
        char *e = strstr(p, "\r\n"); if (e) *e = '\0';
        char *colon = strchr(p, ':');
        if (colon && colon != p) {
            *colon = '\0';
            r->h[r->nh].name = trim(p); r->h[r->nh].value = trim(colon + 1); r->nh++;
        }
        p = e ? e + 2 : NULL;
    }
    const char *host = req_header(r, "host");
    snprintf(r->host, sizeof(r->host), "%s", host ? host : "");

    /* forma absoluta (cliente que usa la caché como proxy explícito: curl -x) */
    if (!strncasecmp(r->target, "http://", 7) || !strncasecmp(r->target, "https://", 8)) {
        char *hs = strstr(r->target, "://") + 3;
        size_t hl = strcspn(hs, "/?#");
        if (hl == 0 || hl >= sizeof(r->host)) return 400;
        memcpy(r->host, hs, hl); r->host[hl] = '\0';
        char tmp[2048]; snprintf(tmp, sizeof(tmp), "%s%s", hs[hl] == '/' ? "" : "/", hs + hl);
        snprintf(r->target, sizeof(r->target), "%s", tmp);
    }

    /* cuerpo */
    const char *te = req_header(r, "transfer-encoding");
    if (te && strcasecmp(te, "identity")) return 411;              /* chunked no soportado: pedir Content-Length */
    const char *cl = req_header(r, "content-length");
    size_t want = 0;
    if (cl) {
        char *end; unsigned long long v = strtoull(cl, &end, 10);
        if (*end || *cl == '-') return 400;
        want = (size_t)v;
    }
    if (want > O.max_req_body) return 413;
    if (want > have) {
        const char *ex = req_header(r, "expect");
        if (ex && !strcasecmp(ex, "100-continue")) c_write_all(c, "HTTP/1.1 100 Continue\r\n\r\n", 25);
        r->body_owned = malloc(want ? want : 1);
        if (!r->body_owned) return 500;
        memcpy(r->body_owned, rest, have);
        while (have < want) {
            int k = c_read(c, r->body_owned + have, (int)((want - have) > (1u << 30) ? (1u << 30) : (want - have)));
            if (k <= 0) return 400;
            have += (size_t)k;
        }
        r->body = r->body_owned;
    } else r->body = rest;
    r->body_len = want;
    return 0;
}

/* ---------------------------------------------------------------- objetos en disco */
static int obj_write(const char *dir, const char *key, const char *ctype, const char *body, size_t len) {
    char path[1400], tmp[1500];
    snprintf(path, sizeof(path), "%s/%s", dir, key);
    snprintf(tmp, sizeof(tmp), "%s.tmp.%lu", path, (unsigned long)pthread_self());
    FILE *f = fopen(tmp, "wb");
    if (!f) return -1;
    int ok = fputs(OBJ_MAGIC, f) >= 0 && fprintf(f, "%s\n", ctype) >= 0 && (len == 0 || fwrite(body, 1, len, f) == len);
    if (fclose(f) != 0) ok = 0;
    if (!ok || rename(tmp, path) != 0) { unlink(tmp); return -1; }
    return 0;
}

/* Lee el objeto: devuelve el cuerpo (malloc) y su Content-Type. NULL si no existe o está dañado. */
static char *obj_read(const char *dir, const char *key, char *ctype, size_t ccap, size_t *len) {
    char path[1400]; snprintf(path, sizeof(path), "%s/%s", dir, key);
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    char magic[8] = "", ct[512] = "";
    if (!fgets(magic, sizeof(magic), f) || strcmp(magic, OBJ_MAGIC) || !fgets(ct, sizeof(ct), f)) { fclose(f); return NULL; }
    ct[strcspn(ct, "\r\n")] = '\0';
    long start = ftell(f);
    if (fseek(f, 0, SEEK_END) != 0) { fclose(f); return NULL; }
    long end = ftell(f);
    if (start < 0 || end < start) { fclose(f); return NULL; }
    size_t n = (size_t)(end - start);
    fseek(f, start, SEEK_SET);
    char *b = malloc(n ? n : 1);
    if (!b || fread(b, 1, n, f) != n) { free(b); fclose(f); return NULL; }
    fclose(f);
    snprintf(ctype, ccap, "%s", ct);
    *len = n;
    return b;
}

/* ---------------------------------------------------------------- proxy al origen */
typedef struct { char *data; size_t len, cap, max; int too_big; } buf_t;

static int buf_add(buf_t *b, const char *p, size_t n) {
    if (b->len + n + 1 > b->cap) {
        size_t nc = b->cap ? b->cap : 8192;
        while (nc < b->len + n + 1) nc *= 2;
        char *d = realloc(b->data, nc);
        if (!d) return -1;
        b->data = d; b->cap = nc;
    }
    memcpy(b->data + b->len, p, n); b->len += n; b->data[b->len] = '\0';
    return 0;
}

typedef struct {
    buf_t body;
    buf_t hdrs;            /* encabezados del origen ya filtrados, "Nombre: valor\r\n" */
    char  ctype[512];
    const char *origin;    /* para reescribir Location absolutas del origen */
    int   drop_cache_control;
} up_t;

static size_t on_body(char *p, size_t sz, size_t nm, void *ud) {
    up_t *u = ud; size_t n = sz * nm;
    if (u->body.len + n > u->body.max) { u->body.too_big = 1; return 0; }  /* aborta la transferencia */
    return buf_add(&u->body, p, n) == 0 ? n : 0;
}

static int is_hop_or_managed(const char *name) {
    static const char *skip[] = { "connection", "keep-alive", "proxy-connection", "proxy-authenticate",
        "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "content-length",
        "content-encoding", "server", NULL };
    for (int i = 0; skip[i]; i++) if (!strcasecmp(name, skip[i])) return 1;
    return 0;
}

static size_t on_header(char *p, size_t sz, size_t nm, void *ud) {
    up_t *u = ud; size_t n = sz * nm;
    if (n >= 5 && !strncmp(p, "HTTP/", 5)) {          /* nueva línea de estado (p.ej. tras 100 Continue) */
        u->hdrs.len = 0; if (u->hdrs.data) u->hdrs.data[0] = '\0'; u->ctype[0] = '\0';
        return n;
    }
    char line[8192];
    size_t k = n < sizeof(line) - 1 ? n : sizeof(line) - 1;
    memcpy(line, p, k); line[k] = '\0';
    line[strcspn(line, "\r\n")] = '\0';
    char *colon = strchr(line, ':');
    if (!colon) return n;
    *colon = '\0';
    char *name = trim(line), *val = trim(colon + 1);
    if (!*name || is_hop_or_managed(name)) return n;
    if (!strcasecmp(name, "content-type")) { snprintf(u->ctype, sizeof(u->ctype), "%s", val); return n; }
    if (u->drop_cache_control && !strcasecmp(name, "cache-control")) return n;
    if (!strcasecmp(name, "location") && u->origin) {   /* Location absoluta al origen -> relativa al dominio */
        size_t ol = strlen(u->origin);
        while (ol && u->origin[ol - 1] == '/') ol--;
        if (!strncasecmp(val, u->origin, ol) && (val[ol] == '/' || val[ol] == '\0' || val[ol] == '?'))
            val = val[ol] ? val + ol : "/";
    }
    char out[8300];
    int w = snprintf(out, sizeof(out), "%s: %s\r\n", name, val);
    if (w > 0 && (size_t)w < sizeof(out)) buf_add(&u->hdrs, out, (size_t)w);
    return n;
}

/* Hace la petición al origen. Devuelve el status HTTP del origen, o 502/504 si falló. */
static int fetch_origin(const req_t *r, const zc_gate_res_t *g, conn_t *c, up_t *u, char *err, size_t errlen) {
    CURL *h = curl_easy_init();
    if (!h) { snprintf(err, errlen, "curl_easy_init"); return 502; }
    size_t ol = strlen(g->origin);
    while (ol && g->origin[ol - 1] == '/') ol--;
    char *url = NULL;
    if (asprintf(&url, "%.*s%s", (int)ol, g->origin, r->target) < 0) { curl_easy_cleanup(h); return 502; }

    struct curl_slist *hl = NULL;
    for (int i = 0; i < r->nh; i++) {
        const char *nm = r->h[i].name;
        if (is_hop_or_managed(nm) || !strcasecmp(nm, "host") || !strcasecmp(nm, "x-api-key") ||
            !strcasecmp(nm, "cookie") || !strcasecmp(nm, "accept-encoding") || !strcasecmp(nm, "expect") ||
            !strncasecmp(nm, "x-forwarded-", 12)) continue;
        char *line = NULL;
        if (asprintf(&line, "%s: %s", nm, r->h[i].value) >= 0) { hl = curl_slist_append(hl, line); free(line); }
    }
    char line[2600];
    if (g->upstream_cookie[0]) { snprintf(line, sizeof(line), "Cookie: %s", g->upstream_cookie); hl = curl_slist_append(hl, line); }
    const char *xff = req_header(r, "x-forwarded-for");
    snprintf(line, sizeof(line), "X-Forwarded-For: %s%s%s", xff ? xff : "", xff ? ", " : "", c->ip); hl = curl_slist_append(hl, line);
    snprintf(line, sizeof(line), "X-Forwarded-Proto: %s", c->ssl ? "https" : "http");               hl = curl_slist_append(hl, line);
    snprintf(line, sizeof(line), "X-Forwarded-Host: %s", r->host);                                  hl = curl_slist_append(hl, line);
    hl = curl_slist_append(hl, "Expect:");                         /* sin 100-continue hacia el origen */

    curl_easy_setopt(h, CURLOPT_URL, url);
#if LIBCURL_VERSION_NUM >= 0x075500
    curl_easy_setopt(h, CURLOPT_PROTOCOLS_STR, "http,https");
#else
    curl_easy_setopt(h, CURLOPT_PROTOCOLS, CURLPROTO_HTTP | CURLPROTO_HTTPS);
#endif
    curl_easy_setopt(h, CURLOPT_HTTPHEADER, hl);
    curl_easy_setopt(h, CURLOPT_FOLLOWLOCATION, 0L);               /* las redirecciones se pasan al cliente */
    curl_easy_setopt(h, CURLOPT_ACCEPT_ENCODING, "");              /* curl descomprime: se guarda el objeto plano */
    curl_easy_setopt(h, CURLOPT_NOSIGNAL, 1L);
    curl_easy_setopt(h, CURLOPT_TIMEOUT, O.origin_timeout);
    curl_easy_setopt(h, CURLOPT_CONNECTTIMEOUT, O.origin_connect_timeout);
    curl_easy_setopt(h, CURLOPT_SSL_VERIFYPEER, (long)O.origin_verify);
    curl_easy_setopt(h, CURLOPT_SSL_VERIFYHOST, O.origin_verify ? 2L : 0L);
    if (O.origin_ca && *O.origin_ca) curl_easy_setopt(h, CURLOPT_CAINFO, O.origin_ca);
    curl_easy_setopt(h, CURLOPT_WRITEFUNCTION, on_body);
    curl_easy_setopt(h, CURLOPT_WRITEDATA, u);
    curl_easy_setopt(h, CURLOPT_HEADERFUNCTION, on_header);
    curl_easy_setopt(h, CURLOPT_HEADERDATA, u);

    if (!strcasecmp(r->method, "GET"))       curl_easy_setopt(h, CURLOPT_HTTPGET, 1L);
    else if (!strcasecmp(r->method, "HEAD")) curl_easy_setopt(h, CURLOPT_NOBODY, 1L);
    else {
        curl_easy_setopt(h, CURLOPT_CUSTOMREQUEST, r->method);
        if (r->body_len || !strcasecmp(r->method, "POST") || !strcasecmp(r->method, "PUT") || !strcasecmp(r->method, "PATCH")) {
            curl_easy_setopt(h, CURLOPT_POSTFIELDS, r->body ? r->body : "");
            curl_easy_setopt(h, CURLOPT_POSTFIELDSIZE_LARGE, (curl_off_t)r->body_len);
        }
    }

    CURLcode rc = curl_easy_perform(h);
    long status = 0;
    curl_easy_getinfo(h, CURLINFO_RESPONSE_CODE, &status);
    curl_slist_free_all(hl); curl_easy_cleanup(h); free(url);
    if (u->body.too_big) { snprintf(err, errlen, "la respuesta del origen supera ZC_MAX_OBJECT_BYTES"); return 502; }
    if (rc != CURLE_OK) {
        snprintf(err, errlen, "%s", curl_easy_strerror(rc));
        return rc == CURLE_OPERATION_TIMEDOUT ? 504 : 502;
    }
    return (int)status;
}

/* ---------------------------------------------------------------- manejo de una petición */
static void healthz(conn_t *c, int head_only) {
    zc_cfg_handle_t *h = zc_cfg_acquire();
    const zc_config_t *cfg = zc_cfg_get(h);
    char b[256];
    int n = snprintf(b, sizeof(b), "{\"ok\":%s,\"zone\":\"%s\",\"domains\":%zu}\n",
                     cfg ? "true" : "false", O.zone, cfg ? cfg->n_domains : (size_t)0);
    zc_cfg_release(h);
    send_resp(c, cfg ? 200 : 503, "application/json", "Cache-Control: no-store\r\n", b, (size_t)n, head_only);
}

static double ms_since(const struct timeval *t0) {
    struct timeval t1; gettimeofday(&t1, NULL);
    return (double)(t1.tv_sec - t0->tv_sec) * 1000.0 + (double)(t1.tv_usec - t0->tv_usec) / 1000.0;
}

static void handle(conn_t *c) {
    struct timeval t0; gettimeofday(&t0, NULL);
    req_t r;
    int perr = read_request(c, &r);
    if (perr) {
        if (perr > 0) send_error(c, perr, perr == 411 ? "Use Content-Length (no se acepta chunked)."
                                         : perr == 413 ? "Cuerpo demasiado grande." : "Petici&oacute;n inv&aacute;lida.");
        req_free(&r); return;
    }
    int head_only = !strcasecmp(r.method, "HEAD");
    char path[2048]; snprintf(path, sizeof(path), "%s", r.target); path[strcspn(path, "?#")] = '\0';
    if (!strcmp(path, "/__zc/healthz")) { healthz(c, head_only); req_free(&r); return; }

    zc_req_t zq = { .method = r.method, .host = r.host, .target = r.target,
                    .x_api_key = req_header(&r, "x-api-key"), .cookie = req_header(&r, "cookie"),
                    .body = r.body, .body_len = r.body_len, .client_ip = c->ip, .is_tls = c->ssl != NULL };
    time_t now = time(NULL);
    zc_gate_res_t g;
    zc_gate_handle(&zq, now, &g);

    if (g.action == ZC_GATE_RESPOND) {
        send_resp(c, g.status, g.content_type, g.headers, g.body, g.body_len, head_only);
        printf("%s %s %s%s -> %d (gate) %.1fms\n", c->ip, r.method, r.host, path, g.status, ms_since(&t0));
        goto done;
    }

    if (!g.origin || !*g.origin) {
        send_error(c, 502, "El dominio no tiene un origen configurado.");
        printf("%s %s %s%s -> 502 sin origen\n", c->ip, r.method, r.host, r.target);
        goto done;
    }

    char extra[4096], meta[1024];
    const char *xc = "BYPASS";
    snprintf(meta, sizeof(meta), "X-ZC-Zone: %s\r\nX-ZC-Rule: %s\r\nX-ZC-Policy: %s\r\nX-ZC-TTL: %ld\r\nX-ZC-Domain-Bytes: %zu\r\n%s",
             *O.zone ? O.zone : "-", g.rule ? g.rule->pattern : "-", g.ft ? zc_policy_name(g.ft->policy) : "-", g.ft ? g.ft->ttl : 0L,
             g.index ? zc_index_bytes(g.index) : (size_t)0, g.authenticated ? "Cache-Control: private\r\n" : "");

    /* 1) HIT desde disco */
    if (g.cacheable && g.domain_dir[0] && zc_gate_cache_lookup(&g, now) == 1) {
        char ctype[512]; size_t len = 0;
        char *body = obj_read(g.domain_dir, g.cache_key, ctype, sizeof(ctype), &len);
        if (body) {
            snprintf(extra, sizeof(extra), "X-Cache: HIT\r\n%s", meta);
            send_resp(c, 200, ctype, extra, body, len, head_only);
            printf("%s %s %s%s -> 200 HIT %zuB %.1fms\n", c->ip, r.method, r.host, r.target, len, ms_since(&t0));
            free(body);
            goto done;
        }
        zc_index_remove(g.index, g.cache_key);       /* índice sin archivo (o dañado): tratar como miss */
    }

    /* 2) MISS / BYPASS: pedir al origen */
    up_t u; memset(&u, 0, sizeof(u));
    u.body.max = O.max_object; u.origin = g.origin; u.drop_cache_control = g.authenticated;
    char err[256] = "";
    int st = fetch_origin(&r, &g, c, &u, err, sizeof(err));
    if (st == 502 || st == 504) {
        if (err[0]) {                                  /* fallo de conexión (no un 502 que respondió el origen) */
            char msg[600]; snprintf(msg, sizeof(msg), "No se pudo obtener el recurso del origen (%s).", err);
            send_error(c, st, msg);
            printf("%s %s %s%s -> %d origen %s: %s\n", c->ip, r.method, r.host, r.target, st, g.origin, err);
            free(u.body.data); free(u.hdrs.data);
            goto done;
        }
    }
    const char *ctype = u.ctype[0] ? u.ctype : "application/octet-stream";
    if (g.cacheable && !strcasecmp(r.method, "GET") && st == 200) {
        xc = "MISS";
        if (!g.domain_dir[0] || obj_write(g.domain_dir, g.cache_key, ctype, u.body.data, u.body.len) != 0)
            xc = "MISS-NOSTORE";
        else if (zc_gate_cache_store(&g, u.body.len, now) != 0) {      /* no cabe en el límite: no se guarda */
            char p[1400]; snprintf(p, sizeof(p), "%s/%s", g.domain_dir, g.cache_key); unlink(p);
            xc = "MISS-NOSTORE";
        }
    }
    snprintf(extra, sizeof(extra), "X-Cache: %s\r\n%s%s", xc, meta, u.hdrs.data ? u.hdrs.data : "");
    send_resp(c, st, u.ctype[0] ? u.ctype : (u.body.len ? ctype : NULL), extra, u.body.data, u.body.len, head_only);
    printf("%s %s %s%s -> %d %s %zuB %.1fms\n", c->ip, r.method, r.host, r.target, st, xc, u.body.len, ms_since(&t0));
    free(u.body.data); free(u.hdrs.data);

done:
    fflush(stdout);
    zc_gate_done(&g);
    req_free(&r);
}

/* ---------------------------------------------------------------- red */
static void *conn_main(void *arg) {
    conn_t *c = arg;
    struct timeval tv = { .tv_sec = O.client_timeout };
    setsockopt(c->fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    setsockopt(c->fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
    if (c->want_tls) { c->ssl = zc_tls_accept(TLS, c->fd); if (!c->ssl) goto out; }
    handle(c);
    zc_tls_close(c->ssl);
out:
    close(c->fd); free(c);
    return NULL;
}

typedef struct { int fd; int tls; } lst_t;

static void *accept_loop(void *arg) {
    lst_t *l = arg;
    while (!STOP) {
        struct sockaddr_storage a; socklen_t al = sizeof(a);
        int fd = accept(l->fd, (struct sockaddr *)&a, &al);
        if (fd < 0) { if (errno == EINTR || errno == ECONNABORTED) continue; if (STOP) break; usleep(10000); continue; }
        conn_t *c = calloc(1, sizeof(*c));
        if (!c) { close(fd); continue; }
        c->fd = fd; c->want_tls = l->tls;
        if (a.ss_family == AF_INET6) {
            struct sockaddr_in6 *s6 = (struct sockaddr_in6 *)&a;
            inet_ntop(AF_INET6, &s6->sin6_addr, c->ip, sizeof(c->ip));
            if (!strncmp(c->ip, "::ffff:", 7)) memmove(c->ip, c->ip + 7, strlen(c->ip + 7) + 1);
        } else inet_ntop(AF_INET, &((struct sockaddr_in *)&a)->sin_addr, c->ip, sizeof(c->ip));
        pthread_attr_t at; pthread_attr_init(&at);
        pthread_attr_setdetachstate(&at, PTHREAD_CREATE_DETACHED);
        pthread_t t;
        if (pthread_create(&t, &at, conn_main, c) != 0) { close(fd); free(c); }
        pthread_attr_destroy(&at);
    }
    return NULL;
}

/* Escucha en IPv6 dual-stack (acepta también IPv4); si no hay IPv6, solo IPv4.
 * Con ZC_BIND_ADDR=<IPv4> escucha solo en esa IP (p.ej. varias zonas en una misma máquina de pruebas). */
static int listen_on(int port) {
    int one = 1, zero = 0;
    const char *bind_addr = getenv("ZC_BIND_ADDR");
    if (bind_addr && *bind_addr) {
        struct sockaddr_in a = { .sin_family = AF_INET, .sin_port = htons((uint16_t)port) };
        if (inet_pton(AF_INET, bind_addr, &a.sin_addr) != 1) { fprintf(stderr, "ZC_BIND_ADDR inválida: %s\n", bind_addr); return -1; }
        int fd4 = socket(AF_INET, SOCK_STREAM, 0);
        if (fd4 < 0) { perror("socket"); return -1; }
        setsockopt(fd4, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
        if (bind(fd4, (struct sockaddr *)&a, sizeof(a)) != 0 || listen(fd4, 256) != 0) { perror("bind/listen"); close(fd4); return -1; }
        return fd4;
    }
    int fd = socket(AF_INET6, SOCK_STREAM, 0);
    if (fd >= 0) {
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
        setsockopt(fd, IPPROTO_IPV6, IPV6_V6ONLY, &zero, sizeof(zero));
        struct sockaddr_in6 a6 = { .sin6_family = AF_INET6, .sin6_addr = in6addr_any, .sin6_port = htons((uint16_t)port) };
        if (bind(fd, (struct sockaddr *)&a6, sizeof(a6)) == 0 && listen(fd, 256) == 0) return fd;
        close(fd);
    }
    fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) { perror("socket"); return -1; }
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
    struct sockaddr_in a = { .sin_family = AF_INET, .sin_addr.s_addr = INADDR_ANY, .sin_port = htons((uint16_t)port) };
    if (bind(fd, (struct sockaddr *)&a, sizeof(a)) != 0 || listen(fd, 256) != 0) { perror("bind/listen"); close(fd); return -1; }
    return fd;
}

int main(void) {
    char err[300] = "";
    signal(SIGPIPE, SIG_IGN);
    /* SIGTERM/SIGINT se bloquean en TODOS los hilos (lo heredan) y solo main los espera con sigwait:
     * así el apagado ordenado (guardar índices) no depende de qué hilo recibe la señal. */
    sigset_t sigs; sigemptyset(&sigs); sigaddset(&sigs, SIGTERM); sigaddset(&sigs, SIGINT);
    pthread_sigmask(SIG_BLOCK, &sigs, NULL);
    setvbuf(stdout, NULL, _IOLBF, 0);
    load_options();

    /* La config viene del API Node.js: si aún no responde (p.ej. arranque del clúster), reintentar. */
    long tries = env_long("ZC_STARTUP_RETRIES", 30);
    for (long i = 0;; i++) {
        if (zc_gate_init(err, sizeof(err)) == 0) break;
        fprintf(stderr, "zc_gate_init (intento %ld/%ld): %s\n", i + 1, tries + 1, err);
        if (i >= tries) return 1;
        sleep(2);
    }

    long hp = env_long("ZC_HTTP_PORT", 8080), sp = env_long("ZC_HTTPS_PORT", 8443);
    lst_t http = { listen_on((int)hp), 0 }, https = { -1, 1 };
    if (http.fd < 0) { zc_gate_shutdown(); return 1; }
    if (getenv("ZC_TLS_CERT_FILE") && *getenv("ZC_TLS_CERT_FILE")) {
        TLS = zc_tls_ctx_from_env(err, sizeof(err));
        if (!TLS) { fprintf(stderr, "TLS: %s\n", err); zc_gate_shutdown(); return 1; }
        https.fd = listen_on((int)sp);
        if (https.fd < 0) { zc_gate_shutdown(); return 1; }
    }
    printf("zonal-cache zona=%s: HTTP en %ld%s", O.zone, hp, TLS ? "" : "\n");
    if (TLS) printf(", HTTPS en %ld (SSL termination)\n", sp);

    pthread_t t1, t2;
    pthread_create(&t1, NULL, accept_loop, &http);
    if (https.fd >= 0) pthread_create(&t2, NULL, accept_loop, &https);
    int sig = 0;
    sigwait(&sigs, &sig);
    STOP = 1;

    printf("apagando: guardando índices de la caché\n");
    shutdown(http.fd, SHUT_RDWR); close(http.fd);
    if (https.fd >= 0) { shutdown(https.fd, SHUT_RDWR); close(https.fd); }
    sleep(1);                                /* deja terminar respuestas en curso */
    zc_gate_shutdown();
    if (TLS) SSL_CTX_free(TLS);
    curl_global_cleanup();
    return 0;
}
