/* zc_p3_demo.c — servidor de PRUEBA de la Persona 3. NO es la Zonal Cache final.
 *
 * Sirve para probar con curl/navegador, antes de integrar con la Persona 2, todo lo de la Persona 3:
 * x-api-key, login (local o vía UI), sesiones, logout, SSL termination (con SNI), límites y políticas.
 *
 * El "origen" es simulado: en lugar de hacer proxy a domain->origin responde un texto generado.
 * Lo que la Persona 2 debe reemplazar está marcado con  >>> PERSONA 2 <<< .
 *
 * Variables: las de zc_gate (ZC_CONFIG_*, ZC_LOGIN_*, ZC_CACHE_DIR, ...) y además
 *   ZC_HTTP_PORT (8080), ZC_HTTPS_PORT (8443; solo si hay ZC_TLS_CERT_FILE/ZC_TLS_KEY_FILE). */
#define _GNU_SOURCE
#include "zc_gate.h"
#include "zc_tls.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <signal.h>
#include <unistd.h>
#include <pthread.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <sys/stat.h>

#define MAX_HEAD 16384
#define MAX_BODY 65536

typedef struct { int fd; SSL *ssl; char ip[64]; } conn_t;

static SSL_CTX *TLS;
static volatile sig_atomic_t STOP;

static int c_read(conn_t *c, void *b, int n)        { return c->ssl ? zc_tls_read(c->ssl, b, n) : (int)recv(c->fd, b, (size_t)n, 0); }
static int c_write_all(conn_t *c, const void *b, size_t n) {
    const char *p = b;
    while (n) {
        int w = c->ssl ? zc_tls_write(c->ssl, p, (int)n) : (int)send(c->fd, p, n, MSG_NOSIGNAL);
        if (w <= 0) return -1;
        p += w; n -= (size_t)w;
    }
    return 0;
}

static const char *reason(int s) {
    switch (s) { case 200: return "OK"; case 302: return "Found"; case 400: return "Bad Request"; case 401: return "Unauthorized";
                 case 403: return "Forbidden"; case 404: return "Not Found"; case 405: return "Method Not Allowed";
                 case 413: return "Payload Too Large"; case 429: return "Too Many Requests"; case 502: return "Bad Gateway";
                 case 503: return "Service Unavailable"; default: return "Error"; }
}

static void send_resp(conn_t *c, int status, const char *ctype, const char *extra, const char *body, size_t blen, int head_only) {
    char h[4096];
    int n = snprintf(h, sizeof(h), "HTTP/1.1 %d %s\r\nContent-Type: %s\r\nContent-Length: %zu\r\nConnection: close\r\n%s\r\n",
                     status, reason(status), ctype ? ctype : "text/plain", blen, extra ? extra : "");
    c_write_all(c, h, (size_t)(n < (int)sizeof(h) ? n : (int)sizeof(h) - 1));
    if (!head_only && body && blen) c_write_all(c, body, blen);
}

/* Encabezado (case-insensitive) dentro del bloque de headers. Copia el valor sin espacios. */
static int header(const char *head, const char *name, char *out, size_t cap) {
    size_t nl = strlen(name);
    for (const char *p = strstr(head, "\r\n"); p && p[2]; p = strstr(p + 2, "\r\n")) {
        const char *l = p + 2;
        if (!strncasecmp(l, name, nl) && l[nl] == ':') {
            l += nl + 1; while (*l == ' ' || *l == '\t') l++;
            size_t k = strcspn(l, "\r\n"); if (k >= cap) k = cap - 1;
            memcpy(out, l, k); out[k] = '\0';
            return 1;
        }
    }
    return 0;
}

static void handle(conn_t *c) {
    char *buf = malloc(MAX_HEAD + MAX_BODY + 1); size_t n = 0; char *eoh = NULL;
    if (!buf) return;
    while (n < MAX_HEAD && !(eoh = memmem(buf, n, "\r\n\r\n", 4))) {
        int r = c_read(c, buf + n, (int)(MAX_HEAD - n)); if (r <= 0) { free(buf); return; }
        n += (size_t)r;
    }
    if (!eoh) { send_resp(c, 400, "text/plain", NULL, "encabezados demasiado grandes\n", 30, 0); free(buf); return; }
    *eoh = '\0';
    char method[16] = "", target[2048] = "";
    if (sscanf(buf, "%15s %2047s", method, target) != 2) { send_resp(c, 400, "text/plain", NULL, "", 0, 0); free(buf); return; }

    char host[300] = "", key[600] = "", cookie[4096] = "", clen[32] = "";
    int has_key = header(buf, "x-api-key", key, sizeof(key)), has_cookie = header(buf, "cookie", cookie, sizeof(cookie));
    header(buf, "host", host, sizeof(host));
    header(buf, "content-length", clen, sizeof(clen));
    size_t want = (size_t)atol(clen), have = n - (size_t)(eoh + 4 - buf);
    if (want > MAX_BODY) { send_resp(c, 413, "text/plain", NULL, "", 0, 0); free(buf); return; }
    char *body = eoh + 4;
    while (have < want) { int r = c_read(c, body + have, (int)(want - have)); if (r <= 0) break; have += (size_t)r; }

    zc_req_t rq = { .method = method, .host = host, .target = target, .x_api_key = has_key ? key : NULL,
                    .cookie = has_cookie ? cookie : NULL, .body = body, .body_len = have, .client_ip = c->ip,
                    .is_tls = c->ssl != NULL };
    time_t now = time(NULL);
    zc_gate_res_t g;
    zc_gate_handle(&rq, now, &g);
    int head_only = !strcasecmp(method, "HEAD");

    if (g.action == ZC_GATE_RESPOND) {
        send_resp(c, g.status, g.content_type, g.headers, g.body, g.body_len, head_only);
        printf("%s %s %s -> %d\n", c->ip, method, target, g.status);
    } else {
        char extra[1024], path[1400];
        const char *xc = "BYPASS";
        char *content = NULL; size_t clen2 = 0;
        snprintf(path, sizeof(path), "%s/%s", g.domain_dir, g.cache_key);
        if (g.cacheable && zc_gate_cache_lookup(&g, now) == 1 && g.domain_dir[0]) {
            FILE *f = fopen(path, "rb");                    /* >>> PERSONA 2 <<< leer objeto del disco */
            if (f) {
                fseek(f, 0, SEEK_END); long sz = ftell(f); fseek(f, 0, SEEK_SET);
                content = malloc((size_t)sz + 1); clen2 = fread(content, 1, (size_t)sz, f); fclose(f);
                xc = "HIT";
            } else zc_index_remove(g.index, g.cache_key);   /* índice sin archivo: tratar como miss */
        }
        if (!content) {
            /* >>> PERSONA 2 <<< aquí va el proxy real a g.domain->origin + target (HTTP/HTTPS con libcurl),
             * reenviando g.upstream_cookie y sin x-api-key. Simulado: */
            if (asprintf(&content, "Respuesta simulada del origen %s para %s (generada %ld)\n",
                         g.domain->origin ? g.domain->origin : "?", target, (long)now) < 0) content = NULL;
            clen2 = content ? strlen(content) : 0;
            if (g.cacheable) {
                xc = "MISS";
                if (g.domain_dir[0]) { FILE *f = fopen(path, "wb"); if (f) { fwrite(content, 1, clen2, f); fclose(f); } }
                if (zc_gate_cache_store(&g, clen2, now) != 0) { xc = "MISS-NOSTORE"; unlink(path); }
            }
        }
        snprintf(extra, sizeof(extra), "X-Cache: %s\r\nX-ZC-Rule: %s\r\nX-ZC-Policy: %s\r\nX-ZC-TTL: %ld\r\nX-ZC-Domain-Bytes: %zu\r\n%s",
                 xc, g.rule ? g.rule->pattern : "-", g.ft ? zc_policy_name(g.ft->policy) : "-", g.ft ? g.ft->ttl : 0L,
                 g.index ? zc_index_bytes(g.index) : 0, g.authenticated ? "Cache-Control: private\r\n" : "");
        send_resp(c, 200, "text/plain; charset=utf-8", extra, content, clen2, head_only);
        printf("%s %s %s -> 200 %s\n", c->ip, method, target, xc);
        free(content);
    }
    fflush(stdout);
    zc_gate_done(&g);
    free(buf);
}

static void *conn_main(void *arg) {
    conn_t *c = arg;
    struct timeval tv = { .tv_sec = 10 };
    setsockopt(c->fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    if (TLS && c->ssl == (SSL *)1) { c->ssl = zc_tls_accept(TLS, c->fd); if (!c->ssl) goto out; }
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
        struct sockaddr_in a; socklen_t al = sizeof(a);
        int fd = accept(l->fd, (struct sockaddr *)&a, &al);
        if (fd < 0) continue;
        conn_t *c = calloc(1, sizeof(*c)); c->fd = fd; c->ssl = l->tls ? (SSL *)1 : NULL;
        inet_ntop(AF_INET, &a.sin_addr, c->ip, sizeof(c->ip));
        pthread_t t;
        if (pthread_create(&t, NULL, conn_main, c) != 0) { close(fd); free(c); continue; }
        pthread_detach(t);
    }
    return NULL;
}

static int listen_on(int port) {
    int fd = socket(AF_INET, SOCK_STREAM, 0), one = 1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
    struct sockaddr_in a = { .sin_family = AF_INET, .sin_addr.s_addr = INADDR_ANY, .sin_port = htons((uint16_t)port) };
    if (bind(fd, (struct sockaddr *)&a, sizeof(a)) != 0 || listen(fd, 128) != 0) { perror("bind/listen"); return -1; }
    return fd;
}

static void on_sig(int s) { (void)s; STOP = 1; }

int main(void) {
    char err[300] = "";
    signal(SIGPIPE, SIG_IGN);
    if (zc_gate_init(err, sizeof(err)) != 0) { fprintf(stderr, "zc_gate_init: %s\n", err); return 1; }
    const char *hp = getenv("ZC_HTTP_PORT"), *sp = getenv("ZC_HTTPS_PORT");
    lst_t http = { listen_on(hp ? atoi(hp) : 8080), 0 }, https = { -1, 1 };
    if (http.fd < 0) return 1;
    if (getenv("ZC_TLS_CERT_FILE")) {
        TLS = zc_tls_ctx_from_env(err, sizeof(err));
        if (!TLS) { fprintf(stderr, "TLS: %s\n", err); return 1; }
        https.fd = listen_on(sp ? atoi(sp) : 8443);
        if (https.fd < 0) return 1;
    }
    printf("zc_p3_demo: HTTP en %d%s%s\n", hp ? atoi(hp) : 8080, TLS ? ", HTTPS en " : "", TLS ? (sp ? sp : "8443") : "");
    fflush(stdout);
    struct sigaction sa = { .sa_handler = on_sig }; sigaction(SIGTERM, &sa, NULL); sigaction(SIGINT, &sa, NULL);
    pthread_t t1, t2;
    pthread_create(&t1, NULL, accept_loop, &http);
    if (https.fd >= 0) pthread_create(&t2, NULL, accept_loop, &https);
    while (!STOP) pause();
    printf("apagando: guardando índices\n");
    zc_gate_shutdown();
    return 0;
}
