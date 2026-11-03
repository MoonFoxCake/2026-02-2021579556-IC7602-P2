#define _GNU_SOURCE
#include "zc_registry.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <errno.h>
#include <pthread.h>
#include <sys/stat.h>

typedef struct { char *name; zc_index_t *ix; } slot_t;

struct zc_registry {
    char *dir;
    pthread_mutex_t mu;
    slot_t *s; size_t n, cap;
};

int zc_domain_dirname(const char *domain, char *out, size_t cap) {
    if (!domain || !*domain || cap < 8) return -1;
    size_t o = 0;
    const char *p = domain;
    if (p[0] == '*' && p[1] == '.') { o = (size_t)snprintf(out, cap, "_wild_"); p++; }
    for (; *p; p++) {
        char c = (char)tolower((unsigned char)*p);
        if (!(isalnum((unsigned char)c) || c == '.' || c == '-' || c == '_')) return -1;
        if (o + 1 >= cap) return -1;
        out[o++] = c;
    }
    out[o] = '\0';
    if (strstr(out, "..") || out[0] == '.') return -1;
    return 0;
}

zc_registry_t *zc_registry_new(const char *dir) {
    zc_registry_t *r = calloc(1, sizeof(*r));
    if (!r) return NULL;
    if (dir && *dir) {
        r->dir = strdup(dir);
        mkdir(dir, 0750);
    }
    pthread_mutex_init(&r->mu, NULL);
    return r;
}

void zc_registry_free(zc_registry_t *r) {
    if (!r) return;
    for (size_t i = 0; i < r->n; i++) { zc_index_free(r->s[i].ix); free(r->s[i].ix); free(r->s[i].name); }
    free(r->s); free(r->dir);
    pthread_mutex_destroy(&r->mu);
    free(r);
}

static int path_for(const zc_registry_t *r, const char *dname, const char *file, char *out, size_t cap) {
    if (!r->dir) return -1;
    int n = file ? snprintf(out, cap, "%s/%s/%s", r->dir, dname, file) : snprintf(out, cap, "%s/%s", r->dir, dname);
    return (n > 0 && (size_t)n < cap) ? 0 : -1;
}

int zc_registry_domain_dir(zc_registry_t *r, const zc_domain_t *d, char *out, size_t cap) {
    char dn[256];
    if (!d || zc_domain_dirname(d->domain, dn, sizeof(dn)) != 0 || path_for(r, dn, NULL, out, cap) != 0) return -1;
    if (mkdir(out, 0750) != 0 && errno != EEXIST) return -1;
    return 0;
}

zc_index_t *zc_registry_get(zc_registry_t *r, const zc_domain_t *d, zc_evict_cb cb, void *ud) {
    char dn[256];
    if (!d || zc_domain_dirname(d->domain, dn, sizeof(dn)) != 0) return NULL;
    zc_index_t *ix = NULL;
    pthread_mutex_lock(&r->mu);
    for (size_t i = 0; i < r->n; i++) if (!strcmp(r->s[i].name, dn)) { ix = r->s[i].ix; break; }
    if (!ix) {
        if (r->n == r->cap) {
            size_t nc = r->cap ? r->cap * 2 : 8;
            slot_t *ns = realloc(r->s, nc * sizeof(*ns));
            if (!ns) { pthread_mutex_unlock(&r->mu); return NULL; }
            r->s = ns; r->cap = nc;
        }
        ix = calloc(1, sizeof(*ix));
        if (!ix) { pthread_mutex_unlock(&r->mu); return NULL; }
        zc_index_init(ix, d->max_cache_bytes);
        char p[1024];
        if (path_for(r, dn, NULL, p, sizeof(p)) == 0) mkdir(p, 0750);
        if (path_for(r, dn, "index.zc", p, sizeof(p)) == 0) zc_index_load(ix, p); /* si no existe, queda vacío */
        r->s[r->n].name = strdup(dn); r->s[r->n].ix = ix; r->n++;
        zc_index_set_max(ix, d->max_cache_bytes, ZC_POLICY_LRU, cb, ud); /* lo cargado puede exceder el límite actual */
    }
    pthread_mutex_unlock(&r->mu);
    pthread_mutex_lock(&ix->mu); size_t cur = ix->max_bytes; pthread_mutex_unlock(&ix->mu);
    if (cur != d->max_cache_bytes) zc_index_set_max(ix, d->max_cache_bytes, ZC_POLICY_LRU, cb, ud);
    return ix;
}

int zc_registry_save_all(zc_registry_t *r) {
    int rc = 0;
    if (!r->dir) return 0;
    pthread_mutex_lock(&r->mu);
    for (size_t i = 0; i < r->n; i++) {
        char p[1024];
        if (path_for(r, r->s[i].name, "index.zc", p, sizeof(p)) != 0 || zc_index_save(r->s[i].ix, p) != 0) rc = -1;
    }
    pthread_mutex_unlock(&r->mu);
    return rc;
}
