#define _GNU_SOURCE
#include "zc_auth.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <pthread.h>
#include <sys/random.h>
#include <openssl/evp.h>
#include <openssl/crypto.h>
#include <curl/curl.h>

#define RL_SLOTS 256

typedef struct { char hash[65]; char host[256]; char pattern[256]; time_t exp; } sess_t;
typedef struct { char ip[64]; time_t start; int count; } rl_t;

struct zc_auth {
    zc_auth_opts_t o;
    char *verify_url, *verify_token;
    pthread_mutex_t mu;
    sess_t *s; size_t n, cap;
    rl_t rl[RL_SLOTS];
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
    char h[600], rt[1200], er[600], safe[1024];
    zc_safe_return_path(return_to, safe, sizeof(safe));
    html_escape(host ? host : "", h, sizeof(h));
    html_escape(safe, rt, sizeof(rt));
    html_escape(error ? error : "", er, sizeof(er));
    size_t cap = 4800; char *b = malloc(cap);
    if (!b) return NULL;
    snprintf(b, cap,
        "<!doctype html><html lang=\"es\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
        "<title>Acceso - %s</title><style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f3f4f6}"
        "form{background:#fff;padding:2rem;border-radius:12px;box-shadow:0 2px 12px #0002;width:min(92vw,340px)}"
        "input,button{width:100%%;padding:.6rem;margin:.4rem 0;box-sizing:border-box;font-size:1rem}.e{color:#b91c1c}</style></head><body>"
        "<form method=\"POST\" action=\"" ZC_LOGIN_PATH "\"><h2>Acceso a %s</h2>%s%s%s"
        "<input name=\"username\" placeholder=\"Usuario\" autocomplete=\"username\" required>"
        "<input name=\"password\" type=\"password\" placeholder=\"Contrase&ntilde;a\" autocomplete=\"current-password\" required>"
        "<input type=\"hidden\" name=\"return_to\" value=\"%s\"><button type=\"submit\">Entrar</button></form></body></html>",
        h, h, *er ? "<p class=\"e\">" : "", er, *er ? "</p>" : "", rt);
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
}

zc_auth_t *zc_auth_new(const zc_auth_opts_t *o) {
    zc_auth_t *a = calloc(1, sizeof(*a));
    if (!a) return NULL;
    a->o = *o;
    a->verify_url = o->verify_url ? strdup(o->verify_url) : NULL;
    a->verify_token = o->verify_token ? strdup(o->verify_token) : NULL;
    a->o.verify_url = a->verify_url; a->o.verify_token = a->verify_token;
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
