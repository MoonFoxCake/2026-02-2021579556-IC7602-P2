#define _GNU_SOURCE
#include "zc_config.h"
#include "json_lite.h"
#include <stdio.h>
#include <ctype.h>
#include <strings.h>
#include <unistd.h>
#include <pthread.h>
#include <curl/curl.h>

#define SETERR(...) do { if (err && errlen) snprintf(err, errlen, __VA_ARGS__); } while (0)

static char *xdup(const char *s) { return s ? strdup(s) : NULL; }

/* ---------- wildcard ---------- */
int zc_wildcard_match(const char *p, const char *s, int ci) {
    const char *star = NULL, *ss = s;
    #define EQ(a, b) (ci ? tolower((unsigned char)(a)) == tolower((unsigned char)(b)) : (a) == (b))
    while (*s) {
        if (*p == '*') { star = p++; ss = s; }
        else if (*p && EQ(*p, *s)) { p++; s++; }
        else if (star) { p = star + 1; s = ++ss; }
        else return 0;
    }
    while (*p == '*') p++;
    return *p == '\0';
    #undef EQ
}

/* ---------- parseo ---------- */
void zc_config_free(zc_config_t *c) {
    if (!c) return;
    for (size_t i = 0; i < c->n_domains; i++) {
        zc_domain_t *d = &c->domains[i];
        free(d->domain); free(d->origin);
        for (size_t j = 0; j < d->n_rules; j++) {
            zc_rule_t *r = &d->rules[j];
            free(r->pattern);
            for (size_t k = 0; k < r->n_keys; k++) free(r->key_hashes[k]);
            free(r->key_hashes); free(r->types);
        }
        free(d->rules);
    }
    free(c->domains); free(c);
}

static int parse_rule(jval_t *u, zc_rule_t *r, char *err, size_t errlen) {
    const char *pat = jstr(jget(u, "pattern"));
    if (!pat || !*pat) { SETERR("regla sin 'pattern'"); return -1; }
    r->pattern = strdup(pat);
    r->cache_bytes = (size_t)jnum(jget(u, "cacheBytes"));

    jval_t *a = jget(u, "auth");
    const char *mode = a ? jstr(jget(a, "mode")) : "none";
    if (!mode || !strcmp(mode, "none"))        r->auth = ZC_AUTH_NONE;
    else if (!strcmp(mode, "apikey"))          r->auth = ZC_AUTH_APIKEY;
    else if (!strcmp(mode, "userpass"))        r->auth = ZC_AUTH_USERPASS;
    else { SETERR("auth.mode desconocido '%s' en '%s'", mode, pat); return -1; } /* falla cerrado */

    jval_t *keys = a ? jget(a, "apiKeyHashes") : NULL;
    if (keys && keys->type == J_ARR && keys->count) {
        r->key_hashes = calloc(keys->count, sizeof(char *));
        for (size_t i = 0; i < keys->count; i++) {
            const char *h = jstr(jat(keys, i));
            if (!h || strlen(h) != 64) continue;
            char *d = strdup(h);
            for (char *q = d; *q; q++) *q = (char)tolower((unsigned char)*q);
            r->key_hashes[r->n_keys++] = d;
        }
    }
    jval_t *ft = jget(u, "fileTypes");
    if (ft && ft->type == J_ARR && ft->count) {
        r->types = calloc(ft->count, sizeof(zc_filetype_t));
        for (size_t i = 0; i < ft->count; i++) {
            jval_t *t = jat(ft, i);
            const char *ext = jstr(jget(t, "ext")), *pol = jstr(jget(t, "policy"));
            zc_filetype_t *o = &r->types[r->n_types];
            if (!ext || !*ext || strlen(ext) >= sizeof(o->ext)) { SETERR("fileType.ext inválido en '%s'", pat); return -1; }
            if (zc_policy_parse(pol ? pol : "LRU", &o->policy) != 0) { SETERR("política desconocida '%s'", pol); return -1; }
            snprintf(o->ext, sizeof(o->ext), "%s", ext);
            for (char *q = o->ext; *q; q++) *q = (char)tolower((unsigned char)*q);
            o->ttl = (long)jnum(jget(t, "ttl"));
            r->n_types++;
        }
    }
    return 0;
}

zc_config_t *zc_config_parse(const char *json, char *err, size_t errlen) {
    jval_t *root = jparse(json ? json : "");
    if (!root || root->type != J_OBJ) { jfree(root); SETERR("JSON inválido"); return NULL; }
    jval_t *doms = jget(root, "domains");
    if (!doms || doms->type != J_ARR) { jfree(root); SETERR("falta el arreglo 'domains'"); return NULL; }
    zc_config_t *c = calloc(1, sizeof(*c));
    c->domains = calloc(doms->count ? doms->count : 1, sizeof(zc_domain_t));
    for (size_t i = 0; i < doms->count; i++) {
        jval_t *d = jat(doms, i);
        zc_domain_t *o = &c->domains[c->n_domains++];
        const char *name = jstr(jget(d, "domain"));
        if (!name || !*name) { SETERR("dominio sin nombre"); goto fail; }
        o->domain = strdup(name);
        o->origin = xdup(jstr(jget(d, "origin")));
        o->max_cache_bytes = (size_t)jnum(jget(d, "maxCacheBytes"));
        jval_t *urls = jget(d, "urls");
        if (urls && urls->type == J_ARR && urls->count) {
            o->rules = calloc(urls->count, sizeof(zc_rule_t));
            for (size_t j = 0; j < urls->count; j++) {
                o->n_rules++;
                if (parse_rule(jat(urls, j), &o->rules[j], err, errlen) != 0) goto fail;
            }
        }
    }
    jfree(root);
    return c;
fail:
    jfree(root); zc_config_free(c);
    return NULL;
}

zc_config_t *zc_config_load_file(const char *path, char *err, size_t errlen) {
    FILE *f = fopen(path, "rb");
    if (!f) { SETERR("no se pudo abrir %s", path); return NULL; }
    fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET);
    if (n < 0 || n > 16 * 1024 * 1024) { fclose(f); SETERR("tamaño de config inválido"); return NULL; }
    char *buf = malloc((size_t)n + 1);
    size_t rd = fread(buf, 1, (size_t)n, f); fclose(f);
    buf[rd] = '\0';
    zc_config_t *c = zc_config_parse(buf, err, errlen);
    free(buf);
    return c;
}

/* ---------- HTTP (libcurl) ---------- */
typedef struct { char *p; size_t n; } buf_t;
static size_t wcb(void *d, size_t s, size_t m, void *u) {
    buf_t *b = u; size_t k = s * m;
    if (b->n + k > 16 * 1024 * 1024) return 0;
    char *np = realloc(b->p, b->n + k + 1);
    if (!np) return 0;
    b->p = np; memcpy(b->p + b->n, d, k); b->n += k; b->p[b->n] = '\0';
    return k;
}

zc_config_t *zc_config_fetch(const char *base, const char *token, const char *zone, char *err, size_t errlen) {
    CURL *cu = curl_easy_init();
    if (!cu) { SETERR("curl_easy_init falló"); return NULL; }
    char *ez = curl_easy_escape(cu, zone ? zone : "", 0);
    char url[2048];
    snprintf(url, sizeof(url), "%s/api/cache/config?zone=%s", base, ez ? ez : "");
    curl_free(ez);
    struct curl_slist *h = NULL;
    if (token && *token) {
        char auth[1100]; snprintf(auth, sizeof(auth), "Authorization: Bearer %s", token);
        h = curl_slist_append(h, auth);
    }
    buf_t b = { NULL, 0 };
    curl_easy_setopt(cu, CURLOPT_URL, url);
    curl_easy_setopt(cu, CURLOPT_HTTPHEADER, h);
    curl_easy_setopt(cu, CURLOPT_WRITEFUNCTION, wcb);
    curl_easy_setopt(cu, CURLOPT_WRITEDATA, &b);
    curl_easy_setopt(cu, CURLOPT_TIMEOUT, 10L);
    curl_easy_setopt(cu, CURLOPT_PROTOCOLS_STR, "http,https");
    CURLcode rc = curl_easy_perform(cu);
    long code = 0; curl_easy_getinfo(cu, CURLINFO_RESPONSE_CODE, &code);
    curl_slist_free_all(h); curl_easy_cleanup(cu);
    zc_config_t *c = NULL;
    if (rc != CURLE_OK) SETERR("fallo de red: %s", curl_easy_strerror(rc));
    else if (code != 200) SETERR("el API de config respondió HTTP %ld", code);
    else c = zc_config_parse(b.p, err, errlen);
    free(b.p);
    return c;
}

/* ---------- búsquedas ---------- */
static void strip_port(const char *host, char *out, size_t cap) {
    snprintf(out, cap, "%s", host ? host : "");
    char *c = strrchr(out, ':');
    if (c && !strchr(c, ']')) *c = '\0';
}
static void strip_query(const char *path, char *out, size_t cap) {
    snprintf(out, cap, "%s", path ? path : "/");
    char *q = strpbrk(out, "?#");
    if (q) *q = '\0';
}

const zc_domain_t *zc_config_find_domain(const zc_config_t *c, const char *host) {
    char h[256]; strip_port(host, h, sizeof(h));
    for (size_t i = 0; i < c->n_domains; i++)
        if (strcasecmp(c->domains[i].domain, h) == 0) return &c->domains[i];
    for (size_t i = 0; i < c->n_domains; i++)
        if (strchr(c->domains[i].domain, '*') && zc_wildcard_match(c->domains[i].domain, h, 1)) return &c->domains[i];
    return NULL;
}

static size_t specificity(const char *p) { size_t n = 0; for (; *p; p++) if (*p != '*') n++; return n; }

const zc_rule_t *zc_domain_match_rule(const zc_domain_t *d, const char *path) {
    char p[2048]; strip_query(path, p, sizeof(p));
    const zc_rule_t *best = NULL; size_t bs = 0;
    for (size_t i = 0; i < d->n_rules; i++) {
        if (!zc_wildcard_match(d->rules[i].pattern, p, 0)) continue;
        size_t s = specificity(d->rules[i].pattern);
        if (!best || s > bs) { best = &d->rules[i]; bs = s; }
    }
    return best;
}

const zc_filetype_t *zc_rule_filetype(const zc_rule_t *r, const char *path) {
    char p[2048]; strip_query(path, p, sizeof(p));
    const char *slash = strrchr(p, '/'), *dot = strrchr(p, '.');
    const char *ext = (dot && (!slash || dot > slash)) ? dot + 1 : "";
    const zc_filetype_t *any = NULL;
    for (size_t i = 0; i < r->n_types; i++) {
        if (strcasecmp(r->types[i].ext, ext) == 0 && *ext) return &r->types[i];
        if (strcmp(r->types[i].ext, "*") == 0) any = &r->types[i];
    }
    return any;
}

/* ---------- config viva ---------- */
struct zc_cfg_handle { zc_config_t *cfg; int refs; };

static struct {
    pthread_mutex_t mu; zc_cfg_handle_t *cur; pthread_t th; int running, stop, secs;
    char url[1024], token[1024], zone[256], file[1024];
} G = { .mu = PTHREAD_MUTEX_INITIALIZER };

static zc_config_t *load_source(char *err, size_t errlen) {
    if (G.file[0]) return zc_config_load_file(G.file, err, errlen);
    return zc_config_fetch(G.url, G.token, G.zone, err, errlen);
}
static void install(zc_config_t *c) {
    zc_cfg_handle_t *h = calloc(1, sizeof(*h));
    h->cfg = c; h->refs = 1;
    pthread_mutex_lock(&G.mu);
    zc_cfg_handle_t *old = G.cur; G.cur = h;
    pthread_mutex_unlock(&G.mu);
    if (old) zc_cfg_release(old);
}
static void *refresher(void *arg) {
    (void)arg;
    for (;;) {
        for (int i = 0; i < G.secs; i++) { sleep(1); if (G.stop) return NULL; }
        char err[256] = "";
        zc_config_t *c = load_source(err, sizeof(err));
        if (c) install(c);
        else fprintf(stderr, "[zc_config] refresco falló, se conserva la config anterior: %s\n", err);
    }
}

int zc_cfg_runtime_start(char *err, size_t errlen) {
    const char *file = getenv("ZC_CONFIG_FILE"), *url = getenv("ZC_CONFIG_URL");
    const char *tok = getenv("ZC_CONFIG_TOKEN"), *zone = getenv("ZC_ZONE"), *sec = getenv("ZC_CONFIG_REFRESH_SECS");
    if (!file && !url) { SETERR("defina ZC_CONFIG_URL (y ZC_CONFIG_TOKEN, ZC_ZONE) o ZC_CONFIG_FILE"); return -1; }
    snprintf(G.file, sizeof(G.file), "%s", file ? file : "");
    snprintf(G.url, sizeof(G.url), "%s", url ? url : "");
    snprintf(G.token, sizeof(G.token), "%s", tok ? tok : "");
    snprintf(G.zone, sizeof(G.zone), "%s", zone ? zone : "");
    G.secs = sec ? atoi(sec) : 60; if (G.secs <= 0) G.secs = 60;
    G.stop = 0;
    zc_config_t *c = load_source(err, errlen);
    if (!c) return -1;
    install(c);
    if (pthread_create(&G.th, NULL, refresher, NULL) == 0) G.running = 1;
    return 0;
}
void zc_cfg_runtime_stop(void) {
    if (G.running) { G.stop = 1; pthread_join(G.th, NULL); G.running = 0; }
    pthread_mutex_lock(&G.mu);
    zc_cfg_handle_t *old = G.cur; G.cur = NULL;
    pthread_mutex_unlock(&G.mu);
    if (old) zc_cfg_release(old);
}
zc_cfg_handle_t *zc_cfg_acquire(void) {
    pthread_mutex_lock(&G.mu);
    zc_cfg_handle_t *h = G.cur;
    if (h) h->refs++;
    pthread_mutex_unlock(&G.mu);
    return h;
}
const zc_config_t *zc_cfg_get(const zc_cfg_handle_t *h) { return h ? h->cfg : NULL; }
void zc_cfg_release(zc_cfg_handle_t *h) {
    if (!h) return;
    pthread_mutex_lock(&G.mu);
    int last = (--h->refs == 0);
    pthread_mutex_unlock(&G.mu);
    if (last) { zc_config_free(h->cfg); free(h); }
}
