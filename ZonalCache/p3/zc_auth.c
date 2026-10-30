#define _GNU_SOURCE
#include "zc_auth.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <strings.h>
#include <pthread.h>
#include <sys/random.h>
#include <openssl/evp.h>
#include <openssl/crypto.h>
#include <openssl/hmac.h>
#include "json_lite.h"
#include <curl/curl.h>

#define RL_SLOTS 256

typedef struct { char hash[65]; char host[256]; char pattern[256]; time_t exp; } sess_t;
typedef struct { char ip[64]; time_t start; int count; } rl_t;
typedef struct { char hash[65]; time_t exp; } used_t;
#define USED_MAX 4096

struct zc_auth {
    zc_auth_opts_t o;
    char *verify_url, *verify_token;
    pthread_mutex_t mu;
    sess_t *s; size_t n, cap;
    rl_t rl[RL_SLOTS];
    char *login_ui_url, *ticket_secret;
    used_t *used; size_t n_used;
};

/* ---------- utilidades ---------- */
void zc_sha256_hex(const void *data, size_t n, char out[65]) {
    unsigned char md[EVP_MAX_MD_SIZE]; unsigned int len = 0;
    EVP_MD_CTX *c = EVP_MD_CTX_new();
    EVP_DigestInit_ex(c, EVP_sha256(), NULL);
    EVP_DigestUpdate(c, data, n);
    EVP_DigestFinal_ex(c, md, &len);
    EVP_MD_CTX_free(c);
    for (unsigned i = 0; i < len; i++) sprintf(out + 2 * i, "%02x", md[i]);
    out[64] = '\0';
}

static int random_token(char *out, size_t cap) { /* 32 bytes -> 64 hex */
    unsigned char r[32];
    if (cap < 65 || getrandom(r, sizeof(r), 0) != (ssize_t)sizeof(r)) return -1;
    for (int i = 0; i < 32; i++) sprintf(out + 2 * i, "%02x", r[i]);
    return 0;
}

int zc_cookie_get(const char *h, const char *name, char *out, size_t cap) {
    if (!h || !name || !cap) return 0;
    size_t nl = strlen(name);
    const char *p = h;
    while (*p) {
        while (*p == ' ' || *p == ';') p++;
        if (strncmp(p, name, nl) == 0 && p[nl] == '=') {
            p += nl + 1;
            size_t k = strcspn(p, ";");
            if (k >= cap) return 0;
            memcpy(out, p, k); out[k] = '\0';
            return 1;
        }
        p += strcspn(p, ";");
    }
    return 0;
}

static int hexv(int c) { return isdigit(c) ? c - '0' : (tolower(c) >= 'a' && tolower(c) <= 'f') ? tolower(c) - 'a' + 10 : -1; }

int zc_form_get(const char *body, const char *key, char *out, size_t cap) {
    if (!body || !key || !cap) return 0;
    size_t kl = strlen(key);
    const char *p = body;
    while (*p) {
        size_t seg = strcspn(p, "&");
        if (seg > kl && strncmp(p, key, kl) == 0 && p[kl] == '=') {
            const char *v = p + kl + 1, *end = p + seg; size_t o = 0;
            while (v < end) {
                if (o + 1 >= cap) return 0;
                if (*v == '+') { out[o++] = ' '; v++; }
                else if (*v == '%' && end - v >= 3 && hexv(v[1]) >= 0 && hexv(v[2]) >= 0) {
                    out[o++] = (char)(hexv(v[1]) * 16 + hexv(v[2])); v += 3;
                } else out[o++] = *v++;
            }
            out[o] = '\0';
            return 1;
        }
        p += seg; if (*p == '&') p++;
    }
    return 0;
}

void zc_safe_return_path(const char *in, char *out, size_t cap) {
    /* Solo rutas absolutas locales: "/algo". Rechaza "//host", "/\host", esquemas y caracteres de control. */
    int ok = in && in[0] == '/' && in[1] != '/' && in[1] != '\\';
    for (const char *p = in; ok && *p; p++) if ((unsigned char)*p < 0x20 || *p == '\\') ok = 0;
    snprintf(out, cap, "%s", ok ? in : "/");
}

static void html_escape(const char *s, char *o, size_t cap) {
    size_t n = 0;
    for (; s && *s && n + 7 < cap; s++) {
        const char *r = *s == '&' ? "&amp;" : *s == '<' ? "&lt;" : *s == '>' ? "&gt;" : *s == '"' ? "&quot;" : *s == '\'' ? "&#39;" : NULL;
        if (r) { size_t l = strlen(r); memcpy(o + n, r, l); n += l; } else o[n++] = *s;
    }
    o[n] = '\0';
}

char *zc_auth_login_form(const char *host, const char *return_to, const char *error) {
    return zc_auth_login_form_csrf(host, return_to, error, NULL);
}

char *zc_auth_login_form_csrf(const char *host, const char *return_to, const char *error, const char *csrf) {
    char h[600], rt[1200], er[600], safe[1024], cs[200];
    zc_safe_return_path(return_to, safe, sizeof(safe));
    html_escape(host ? host : "", h, sizeof(h));
    html_escape(safe, rt, sizeof(rt));
    html_escape(error ? error : "", er, sizeof(er));
    html_escape(csrf ? csrf : "", cs, sizeof(cs));
    size_t cap = 5200; char *b = malloc(cap);
    if (!b) return NULL;
    snprintf(b, cap,
        "<!doctype html><html lang=\"es\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
        "<title>Acceso - %s</title><style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f3f4f6}"
        "form{background:#fff;padding:2rem;border-radius:12px;box-shadow:0 2px 12px #0002;width:min(92vw,340px)}"
        "input,button{width:100%%;padding:.6rem;margin:.4rem 0;box-sizing:border-box;font-size:1rem}.e{color:#b91c1c}</style></head><body>"
        "<form method=\"POST\" action=\"" ZC_LOGIN_PATH "\"><h2>Acceso a %s</h2>%s%s%s"
        "<input name=\"username\" placeholder=\"Usuario\" autocomplete=\"username\" required>"
        "<input name=\"password\" type=\"password\" placeholder=\"Contrase&ntilde;a\" autocomplete=\"current-password\" required>"
        "<input type=\"hidden\" name=\"return_to\" value=\"%s\">%s%s%s<button type=\"submit\">Entrar</button></form></body></html>",
        h, h, *er ? "<p class=\"e\">" : "", er, *er ? "</p>" : "", rt,
        *cs ? "<input type=\"hidden\" name=\"csrf\" value=\"" : "", cs, *cs ? "\">" : "");
    return b;
}

/* ---------- ciclo de vida ---------- */
static long env_long(const char *k, long d) { const char *v = getenv(k); return (v && *v) ? atol(v) : d; }

void zc_auth_opts_from_env(zc_auth_opts_t *o) {
    memset(o, 0, sizeof(*o));
    o->session_ttl = env_long("ZC_SESSION_TTL_SECS", 3600);
    o->max_sessions = (size_t)env_long("ZC_SESSION_MAX", 10000);
    o->login_max_attempts = (int)env_long("ZC_LOGIN_MAX_ATTEMPTS", 5);
    o->login_window = env_long("ZC_LOGIN_WINDOW_SECS", 300);
    o->cookie_secure = (int)env_long("ZC_COOKIE_SECURE", 1);
    o->verify_url = getenv("ZC_VERIFY_URL") ? getenv("ZC_VERIFY_URL") : getenv("ZC_CONFIG_URL");
    o->verify_token = getenv("ZC_VERIFY_TOKEN") ? getenv("ZC_VERIFY_TOKEN") : getenv("ZC_CONFIG_TOKEN");
    const char *m = getenv("ZC_LOGIN_MODE");
    o->login_mode = (m && !strcasecmp(m, "ui")) ? ZC_LOGIN_UI : ZC_LOGIN_LOCAL;
    o->login_ui_url = getenv("ZC_LOGIN_UI_URL");
    o->ticket_secret = getenv("ZC_TICKET_SECRET");
    o->ticket_max_age = env_long("ZC_TICKET_MAX_AGE_SECS", 120);
}

zc_auth_t *zc_auth_new(const zc_auth_opts_t *o) {
    zc_auth_t *a = calloc(1, sizeof(*a));
    if (!a) return NULL;
    a->o = *o;
    a->verify_url = o->verify_url ? strdup(o->verify_url) : NULL;
    a->verify_token = o->verify_token ? strdup(o->verify_token) : NULL;
    a->o.verify_url = a->verify_url; a->o.verify_token = a->verify_token;
    a->login_ui_url = o->login_ui_url ? strdup(o->login_ui_url) : NULL;
    a->ticket_secret = o->ticket_secret ? strdup(o->ticket_secret) : NULL;
    a->o.login_ui_url = a->login_ui_url; a->o.ticket_secret = a->ticket_secret;
    if (a->o.ticket_max_age <= 0) a->o.ticket_max_age = 120;
    if (a->o.session_ttl <= 0) a->o.session_ttl = 3600;
    if (a->o.max_sessions == 0) a->o.max_sessions = 10000;
    if (a->o.login_max_attempts <= 0) a->o.login_max_attempts = 5;
    if (a->o.login_window <= 0) a->o.login_window = 300;
    pthread_mutex_init(&a->mu, NULL);
    return a;
}
void zc_auth_free(zc_auth_t *a) {
    if (!a) return;
    free(a->s); free(a->verify_url); free(a->verify_token);
    if (a->ticket_secret) { OPENSSL_cleanse(a->ticket_secret, strlen(a->ticket_secret)); free(a->ticket_secret); }
    free(a->login_ui_url); free(a->used);
    pthread_mutex_destroy(&a->mu); free(a);
}

/* ---------- sesiones ---------- */
static void purge(zc_auth_t *a, time_t now) {
    for (size_t i = 0; i < a->n; ) { if (a->s[i].exp <= now) a->s[i] = a->s[--a->n]; else i++; }
}

static int session_add(zc_auth_t *a, const char *tok, const char *host, const char *pat, time_t now) {
    pthread_mutex_lock(&a->mu);
    purge(a, now);
    if (a->n >= a->o.max_sessions) { /* lleno: se descarta la que expira primero */
        size_t oldest = 0;
        for (size_t i = 1; i < a->n; i++) if (a->s[i].exp < a->s[oldest].exp) oldest = i;
        a->s[oldest] = a->s[--a->n];
    }
    if (a->n == a->cap) {
        size_t nc = a->cap ? a->cap * 2 : 64;
        sess_t *ns = realloc(a->s, nc * sizeof(*ns));
        if (!ns) { pthread_mutex_unlock(&a->mu); return -1; }
        a->s = ns; a->cap = nc;
    }
    sess_t *s = &a->s[a->n++];
    zc_sha256_hex(tok, strlen(tok), s->hash);
    snprintf(s->host, sizeof(s->host), "%s", host ? host : "");
    snprintf(s->pattern, sizeof(s->pattern), "%s", pat ? pat : "");
    s->exp = now + a->o.session_ttl;
    pthread_mutex_unlock(&a->mu);
    return 0;
}

static void host_norm(const char *h, char *out, size_t cap) {
    snprintf(out, cap, "%s", h ? h : "");
    char *c = strrchr(out, ':'); if (c && !strchr(c, ']')) *c = '\0';
    for (char *p = out; *p; p++) *p = (char)tolower((unsigned char)*p);
}

static int session_valid(zc_auth_t *a, const char *tok, const char *host, const char *pat, time_t now) {
    char hash[65], hn[256]; int ok = 0;
    zc_sha256_hex(tok, strlen(tok), hash);
    host_norm(host, hn, sizeof(hn));
    pthread_mutex_lock(&a->mu);
    purge(a, now);
    for (size_t i = 0; i < a->n; i++)
        if (CRYPTO_memcmp(a->s[i].hash, hash, 64) == 0) {
            ok = !strcmp(a->s[i].host, hn) && !strcmp(a->s[i].pattern, pat ? pat : ""); /* sesión ligada a dominio+regla */
            break;
        }
    pthread_mutex_unlock(&a->mu);
    return ok;
}

/* ---------- decisión ---------- */
zc_auth_result_t zc_auth_check(zc_auth_t *a, const zc_rule_t *rule, const char *host,
                               const char *x_api_key, const char *cookie_header, time_t now) {
    if (!rule || rule->auth == ZC_AUTH_NONE) return ZC_AUTH_ALLOW;
    if (rule->auth == ZC_AUTH_APIKEY) {
        if (!x_api_key || !*x_api_key || strlen(x_api_key) > 512) return ZC_AUTH_DENY;
        char h[65]; zc_sha256_hex(x_api_key, strlen(x_api_key), h);
        int ok = 0;
        for (size_t i = 0; i < rule->n_keys; i++)       /* recorre todas: tiempo independiente de cuál coincide */
            ok |= (CRYPTO_memcmp(h, rule->key_hashes[i], 64) == 0);
        return ok ? ZC_AUTH_ALLOW : ZC_AUTH_DENY;
    }
    char tok[128];
    if (zc_cookie_get(cookie_header, ZC_COOKIE_NAME, tok, sizeof(tok)) && session_valid(a, tok, host, rule->pattern, now))
        return ZC_AUTH_ALLOW;
    return ZC_AUTH_LOGIN_REQUIRED;
}

/* ---------- login ---------- */
static int rl_allow(zc_auth_t *a, const char *ip, time_t now) {
    unsigned h = 5381; for (const char *p = ip; *p; p++) h = h * 33 + (unsigned char)*p;
    rl_t *r = &a->rl[h % RL_SLOTS]; int ok;
    pthread_mutex_lock(&a->mu);
    if (strcmp(r->ip, ip) != 0 || now - r->start >= a->o.login_window) {
        snprintf(r->ip, sizeof(r->ip), "%s", ip); r->start = now; r->count = 0;
    }
    ok = ++r->count <= a->o.login_max_attempts;
    pthread_mutex_unlock(&a->mu);
    return ok;
}
static void rl_reset(zc_auth_t *a, const char *ip) {
    unsigned h = 5381; for (const char *p = ip; *p; p++) h = h * 33 + (unsigned char)*p;
    pthread_mutex_lock(&a->mu);
    if (!strcmp(a->rl[h % RL_SLOTS].ip, ip)) a->rl[h % RL_SLOTS].count = 0;
    pthread_mutex_unlock(&a->mu);
}

static void json_esc(const char *s, char *o, size_t cap) {
    size_t n = 0;
    for (; s && *s && n + 7 < cap; s++) {
        unsigned char c = (unsigned char)*s;
        if (c == '"' || c == '\\') { o[n++] = '\\'; o[n++] = (char)c; }
        else if (c < 0x20) n += (size_t)snprintf(o + n, 7, "\\u%04x", c);
        else o[n++] = (char)c;
    }
    o[n] = '\0';
}
static size_t sink(void *d, size_t s, size_t m, void *u) { (void)d; (void)u; return s * m; }

/* POST {verify_url}/api/cache/verify-credentials  ->  HTTP 200 = válidas, 401/403 = inválidas */
static int verify_http(zc_auth_t *a, const char *host, const char *pat, const char *user, const char *pass) {
    if (!a->verify_url) return -1;
    char eh[600], ep[600], eu[600], ew[1200], body[3200], url[1200];
    json_esc(host, eh, sizeof(eh)); json_esc(pat, ep, sizeof(ep));
    json_esc(user, eu, sizeof(eu)); json_esc(pass, ew, sizeof(ew));
    snprintf(body, sizeof(body), "{\"domain\":\"%s\",\"pattern\":\"%s\",\"username\":\"%s\",\"password\":\"%s\"}", eh, ep, eu, ew);
    snprintf(url, sizeof(url), "%s/api/cache/verify-credentials", a->verify_url);
    CURL *cu = curl_easy_init(); if (!cu) return -1;
    struct curl_slist *h = curl_slist_append(NULL, "Content-Type: application/json");
    if (a->verify_token && *a->verify_token) {
        char t[1100]; snprintf(t, sizeof(t), "Authorization: Bearer %s", a->verify_token);
        h = curl_slist_append(h, t);
    }
    curl_easy_setopt(cu, CURLOPT_URL, url);
    curl_easy_setopt(cu, CURLOPT_HTTPHEADER, h);
    curl_easy_setopt(cu, CURLOPT_POSTFIELDS, body);
    curl_easy_setopt(cu, CURLOPT_WRITEFUNCTION, sink);
    curl_easy_setopt(cu, CURLOPT_TIMEOUT, 8L);
    curl_easy_setopt(cu, CURLOPT_PROTOCOLS_STR, "http,https");
    CURLcode rc = curl_easy_perform(cu);
    long code = 0; curl_easy_getinfo(cu, CURLINFO_RESPONSE_CODE, &code);
    curl_slist_free_all(h); curl_easy_cleanup(cu);
    memset(body, 0, sizeof(body)); memset(ew, 0, sizeof(ew));
    if (rc != CURLE_OK) return -1;
    return code == 200 ? 1 : (code == 401 || code == 403) ? 0 : -1;
}

int zc_auth_login(zc_auth_t *a, const char *host, const char *pattern, const char *user, const char *pass,
                  const char *client_ip, time_t now, char *token_out, size_t cap) {
    if (!user || !pass || !*user || strlen(user) > 200 || strlen(pass) > 400) return -1;
    char ip[64]; snprintf(ip, sizeof(ip), "%s", client_ip && *client_ip ? client_ip : "?");
    if (!rl_allow(a, ip, now)) return -2;
    char hn[256]; host_norm(host, hn, sizeof(hn));
    int r = a->o.verify ? a->o.verify(hn, pattern, user, pass, a->o.verify_ud) : verify_http(a, hn, pattern, user, pass);
    if (r < 0) return -3;
    if (r == 0) return -1;
    if (random_token(token_out, cap) != 0 || session_add(a, token_out, hn, pattern, now) != 0) return -3;
    rl_reset(a, ip);
    return 0;
}

int zc_auth_logout(zc_auth_t *a, const char *cookie_header) {
    char tok[128], hash[65]; int found = 0;
    if (!zc_cookie_get(cookie_header, ZC_COOKIE_NAME, tok, sizeof(tok))) return 0;
    zc_sha256_hex(tok, strlen(tok), hash);
    pthread_mutex_lock(&a->mu);
    for (size_t i = 0; i < a->n; i++)
        if (CRYPTO_memcmp(a->s[i].hash, hash, 64) == 0) { a->s[i] = a->s[--a->n]; found = 1; break; }
    pthread_mutex_unlock(&a->mu);
    return found;
}

void zc_auth_set_cookie(const zc_auth_t *a, const char *token, char *out, size_t cap) {
    snprintf(out, cap, "Set-Cookie: " ZC_COOKIE_NAME "=%s; Path=/; HttpOnly; SameSite=Lax; Max-Age=%ld%s",
             token, a->o.session_ttl, a->o.cookie_secure ? "; Secure" : "");
}
void zc_auth_clear_cookie(const zc_auth_t *a, char *out, size_t cap) {
    snprintf(out, cap, "Set-Cookie: " ZC_COOKIE_NAME "=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0%s",
             a->o.cookie_secure ? "; Secure" : "");
}

/* ---------- utilidades de URL ---------- */
void zc_url_encode(const char *in, char *out, size_t cap) {
    static const char hx[] = "0123456789ABCDEF";
    size_t o = 0;
    for (; in && *in && o + 4 < cap; in++) {
        unsigned char c = (unsigned char)*in;
        if (isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') out[o++] = (char)c;
        else { out[o++] = '%'; out[o++] = hx[c >> 4]; out[o++] = hx[c & 15]; }
    }
    if (cap) out[o < cap ? o : cap - 1] = '\0';
}

int zc_query_get(const char *path, const char *key, char *out, size_t cap) {
    const char *q = path ? strchr(path, '?') : NULL;
    if (!q) return 0;
    char tmp[4096]; snprintf(tmp, sizeof(tmp), "%s", q + 1);
    char *h = strchr(tmp, '#'); if (h) *h = '\0';
    return zc_form_get(tmp, key, out, cap);
}

/* ---------- CSRF ---------- */
int zc_auth_csrf_new(char out[65]) { return random_token(out, 65); }
void zc_auth_csrf_cookie(const zc_auth_t *a, const char *tok, char *out, size_t cap) {
    snprintf(out, cap, "Set-Cookie: " ZC_CSRF_COOKIE "=%s; Path=" ZC_LOGIN_PATH "; HttpOnly; SameSite=Strict; Max-Age=900%s",
             tok, a->o.cookie_secure ? "; Secure" : "");
}
int zc_auth_csrf_ok(const char *cookie_header, const char *form_value) {
    char c[128];
    if (!form_value || strlen(form_value) != 64 || !zc_cookie_get(cookie_header, ZC_CSRF_COOKIE, c, sizeof(c)) || strlen(c) != 64)
        return 0;
    return CRYPTO_memcmp(c, form_value, 64) == 0;
}

/* ---------- modo UI: tickets ---------- */
zc_login_mode_t zc_auth_mode(const zc_auth_t *a) { return a->o.login_mode; }

int zc_auth_ui_login_url(const zc_auth_t *a, const char *host, const char *pattern, int is_tls,
                         const char *return_to, char *out, size_t cap) {
    if (!a->login_ui_url || !*a->login_ui_url) return -1;
    char hn[256], safe[1024], cb[600], e_h[800], e_p[800], e_cb[1800], e_rt[3100];
    host_norm(host, hn, sizeof(hn));
    zc_safe_return_path(return_to, safe, sizeof(safe));
    snprintf(cb, sizeof(cb), "%s://%s" ZC_CALLBACK_PATH, is_tls ? "https" : "http", host ? host : hn);
    zc_url_encode(hn, e_h, sizeof(e_h)); zc_url_encode(pattern ? pattern : "", e_p, sizeof(e_p));
    zc_url_encode(cb, e_cb, sizeof(e_cb)); zc_url_encode(safe, e_rt, sizeof(e_rt));
    int n = snprintf(out, cap, "%s%cdomain=%s&pattern=%s&callback=%s&return_to=%s", a->login_ui_url,
                     strchr(a->login_ui_url, '?') ? '&' : '?', e_h, e_p, e_cb, e_rt);
    return (n > 0 && (size_t)n < cap) ? 0 : -1;
}

static void b64url_enc(const unsigned char *in, size_t n, char *out, size_t cap) {
    static const char T[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    size_t o = 0;
    for (size_t i = 0; i < n && o + 5 < cap; i += 3) {
        unsigned v = (unsigned)in[i] << 16 | (i + 1 < n ? (unsigned)in[i + 1] << 8 : 0) | (i + 2 < n ? in[i + 2] : 0);
        out[o++] = T[v >> 18 & 63]; out[o++] = T[v >> 12 & 63];
        if (i + 1 < n) out[o++] = T[v >> 6 & 63];
        if (i + 2 < n) out[o++] = T[v & 63];
    }
    out[o] = '\0';
}
static int b64v(int c) {
    return c >= 'A' && c <= 'Z' ? c - 'A' : c >= 'a' && c <= 'z' ? c - 'a' + 26 : c >= '0' && c <= '9' ? c - '0' + 52
         : c == '-' ? 62 : c == '_' ? 63 : -1;
}
static long b64url_dec(const char *in, size_t n, unsigned char *out, size_t cap) {
    size_t o = 0; unsigned acc = 0; int bits = 0;
    for (size_t i = 0; i < n; i++) {
        int v = b64v((unsigned char)in[i]);
        if (v < 0) return -1;
        acc = acc << 6 | (unsigned)v; bits += 6;
        if (bits >= 8) { bits -= 8; if (o >= cap) return -1; out[o++] = (unsigned char)(acc >> bits & 0xFF); }
    }
    return (long)o;
}
static void hmac_hex(const char *secret, const char *data, size_t n, char out[65]) {
    unsigned char md[EVP_MAX_MD_SIZE]; unsigned len = 0;
    HMAC(EVP_sha256(), secret, (int)strlen(secret), (const unsigned char *)data, n, md, &len);
    for (unsigned i = 0; i < len && i < 32; i++) sprintf(out + 2 * i, "%02x", md[i]);
    out[64] = '\0';
}

int zc_ticket_make(const char *secret, const char *domain, const char *pattern, const char *user,
                   time_t exp, char *out, size_t cap) {
    char nonce[65], ed[600], ep[600], eu[600], json[2200], b64[3000], mac[65];
    if (!secret || random_token(nonce, sizeof(nonce)) != 0) return -1;
    json_esc(domain, ed, sizeof(ed)); json_esc(pattern, ep, sizeof(ep)); json_esc(user, eu, sizeof(eu));
    int n = snprintf(json, sizeof(json), "{\"domain\":\"%s\",\"pattern\":\"%s\",\"user\":\"%s\",\"exp\":%lld,\"nonce\":\"%s\"}",
                     ed, ep, eu, (long long)exp, nonce);
    b64url_enc((unsigned char *)json, (size_t)n, b64, sizeof(b64));
    hmac_hex(secret, b64, strlen(b64), mac);
    n = snprintf(out, cap, "%s.%s", b64, mac);
    return (n > 0 && (size_t)n < cap) ? 0 : -1;
}

/* 1 si ya se había usado (replay); si no, lo registra hasta su expiración. */
static int ticket_seen(zc_auth_t *a, const char *mac, time_t exp, time_t now) {
    int seen = 0;
    pthread_mutex_lock(&a->mu);
    for (size_t i = 0; i < a->n_used; ) { if (a->used[i].exp < now) a->used[i] = a->used[--a->n_used]; else i++; }
    for (size_t i = 0; i < a->n_used; i++) if (!strcmp(a->used[i].hash, mac)) { seen = 1; break; }
    if (!seen) {
        if (!a->used) a->used = calloc(USED_MAX, sizeof(used_t));
        if (a->used) {
            size_t slot = a->n_used < USED_MAX ? a->n_used++ : 0;  /* lleno: se pisa la primera */
            snprintf(a->used[slot].hash, sizeof(a->used[slot].hash), "%s", mac);
            a->used[slot].exp = exp;
        }
    }
    pthread_mutex_unlock(&a->mu);
    return seen;
}

int zc_auth_redeem_ticket(zc_auth_t *a, const char *ticket, const char *host, const char *expected_pattern,
                          time_t now, char *token_out, size_t cap) {
    if (!a->ticket_secret || strlen(a->ticket_secret) < 16 || !ticket || strlen(ticket) > 2900) return -1;
    const char *dot = strrchr(ticket, '.');
    if (!dot || strlen(dot + 1) != 64) return -1;
    char mac[65]; hmac_hex(a->ticket_secret, ticket, (size_t)(dot - ticket), mac);
    char given[65]; snprintf(given, sizeof(given), "%s", dot + 1);
    for (char *p = given; *p; p++) *p = (char)tolower((unsigned char)*p);
    if (CRYPTO_memcmp(mac, given, 64) != 0) return -1;

    unsigned char json[2300];
    long jn = b64url_dec(ticket, (size_t)(dot - ticket), json, sizeof(json) - 1);
    if (jn <= 0) return -1;
    json[jn] = '\0';
    jval_t *j = jparse((const char *)json);
    const char *dom = jstr(jget(j, "domain")), *pat = jstr(jget(j, "pattern")), *user = jstr(jget(j, "user"));
    time_t exp = (time_t)jnum(jget(j, "exp"));
    char hn[256]; host_norm(host, hn, sizeof(hn));
    int ok = dom && pat && user && *user && exp > now && exp - now <= a->o.ticket_max_age
             && !strcasecmp(dom, hn) && expected_pattern && !strcmp(pat, expected_pattern);
    char pcopy[256]; snprintf(pcopy, sizeof(pcopy), "%s", pat ? pat : "");
    jfree(j);
    if (!ok) return -1;
    if (ticket_seen(a, mac, exp, now)) return -4;
    if (random_token(token_out, cap) != 0 || session_add(a, token_out, hn, pcopy, now) != 0) return -1;
    return 0;
}
