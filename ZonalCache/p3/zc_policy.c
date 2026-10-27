#define _GNU_SOURCE
#include "zc_policy.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <ctype.h>
#include <unistd.h>
#include <sys/random.h>

static const char *NAMES[] = { "LRU", "LFU", "FIFO", "MRU", "RANDOM" };

int zc_policy_parse(const char *s, zc_policy_t *out) {
    if (!s) return -1;
    for (int i = 0; i < 5; i++)
        if (strcasecmp(s, NAMES[i]) == 0) { *out = (zc_policy_t)i; return 0; }
    return -1;
}
const char *zc_policy_name(zc_policy_t p) { return ((int)p >= 0 && (int)p < 5) ? NAMES[p] : "?"; }

static int key_valid(const char *k) {
    size_t n = k ? strlen(k) : 0;
    if (n == 0 || n >= ZC_KEY_MAX) return 0;
    for (; *k; k++)
        if (!(isalnum((unsigned char)*k) || *k == '.' || *k == '_' || *k == '-')) return 0;
    return 1;
}

int zc_index_init(zc_index_t *ix, size_t max_bytes) {
    memset(ix, 0, sizeof(*ix));
    ix->max_bytes = max_bytes;
    if (getrandom(&ix->rng, sizeof(ix->rng), 0) < 0) ix->rng = (unsigned)time(NULL);
    return pthread_mutex_init(&ix->mu, NULL);
}
void zc_index_free(zc_index_t *ix) { free(ix->e); pthread_mutex_destroy(&ix->mu); memset(ix, 0, sizeof(*ix)); }

static long find(zc_index_t *ix, const char *key) {
    for (size_t i = 0; i < ix->n; i++) if (strcmp(ix->e[i].key, key) == 0) return (long)i;
    return -1;
}
static void remove_at(zc_index_t *ix, size_t i) {
    ix->total_bytes -= ix->e[i].size;
    ix->e[i] = ix->e[--ix->n];
}

/* Núcleo de las políticas. O(n) por expulsión: suficiente para cachés de miles de objetos.
 * only_group != 0 restringe la búsqueda a las entradas de ese grupo (límite por URL). */
static long select_victim(zc_index_t *ix, zc_policy_t p, uint32_t only_group) {
    #define IN_SCOPE(i) (only_group == 0 || ix->e[i].group == only_group)
    long b = -1;
    if (p == ZC_POLICY_RANDOM) {
        size_t cnt = 0;
        for (size_t i = 0; i < ix->n; i++) if (IN_SCOPE(i)) cnt++;
        if (cnt == 0) return -1;
        size_t k = (size_t)rand_r(&ix->rng) % cnt;
        for (size_t i = 0; i < ix->n; i++) if (IN_SCOPE(i) && k-- == 0) return (long)i;
        return -1;
    }
    for (size_t i = 0; i < ix->n; i++) {
        if (!IN_SCOPE(i)) continue;
        if (b < 0) { b = (long)i; continue; }
        const zc_entry_t *c = &ix->e[i], *v = &ix->e[b];
        int better = 0;
        switch (p) {
            case ZC_POLICY_LRU:  better = c->accessed_seq < v->accessed_seq; break;   /* menos recientemente usada */
            case ZC_POLICY_MRU:  better = c->accessed_seq > v->accessed_seq; break;   /* más recientemente usada */
            case ZC_POLICY_FIFO: better = c->inserted_seq < v->inserted_seq; break;   /* la más antigua insertada */
            case ZC_POLICY_LFU:  better = c->hits < v->hits ||
                                          (c->hits == v->hits && c->accessed_seq < v->accessed_seq); break;
            default: break;
        }
        if (better) b = (long)i;
    }
    return b;
    #undef IN_SCOPE
}

static size_t group_bytes(const zc_index_t *ix, uint32_t g) {
    size_t t = 0;
    for (size_t i = 0; i < ix->n; i++) if (ix->e[i].group == g) t += ix->e[i].size;
    return t;
}

uint32_t zc_group_id(const char *pattern) {
    uint32_t h = 2166136261u;
    for (const char *p = pattern ? pattern : ""; *p; p++) { h ^= (unsigned char)*p; h *= 16777619u; }
    return h ? h : 1;
}

static void purge_expired(zc_index_t *ix, time_t now, zc_evict_cb cb, void *ud) {
    for (size_t i = 0; i < ix->n; ) {
        if (ix->e[i].expires_at && ix->e[i].expires_at <= now) {
            if (cb) cb(ix->e[i].key, ud);
            remove_at(ix, i);
        } else i++;
    }
}

int zc_index_lookup(zc_index_t *ix, const char *key, time_t now, zc_evict_cb cb, void *ud) {
    int r = 0;
    pthread_mutex_lock(&ix->mu);
    long i = find(ix, key);
    if (i >= 0) {
        if (ix->e[i].expires_at && ix->e[i].expires_at <= now) {
            if (cb) cb(ix->e[i].key, ud);
            remove_at(ix, (size_t)i);
            r = -1;
        } else {
            ix->e[i].accessed_seq = ++ix->seq;
            ix->e[i].hits++;
            r = 1;
        }
    }
    pthread_mutex_unlock(&ix->mu);
    return r;
}

int zc_index_put(zc_index_t *ix, const char *key, size_t size, long ttl, zc_policy_t policy,
                 time_t now, zc_evict_cb cb, void *ud) {
    return zc_index_put_ex(ix, key, size, ttl, policy, 0, 0, now, cb, ud);
}

int zc_index_put_ex(zc_index_t *ix, const char *key, size_t size, long ttl, zc_policy_t policy,
                    uint32_t group, size_t group_max, time_t now, zc_evict_cb cb, void *ud) {
    if (!key_valid(key)) return -1;
    if (group == 0) group_max = 0;
    pthread_mutex_lock(&ix->mu);
    if (size > ix->max_bytes || (group_max && size > group_max)) { pthread_mutex_unlock(&ix->mu); return -1; }
    long at = find(ix, key);
    if (at >= 0) remove_at(ix, (size_t)at); /* el llamador sobrescribe el archivo */
    size_t gb = group_max ? group_bytes(ix, group) : 0;
    if (ix->total_bytes + size > ix->max_bytes || (group_max && gb + size > group_max)) {
        purge_expired(ix, now, cb, ud);
        if (group_max) gb = group_bytes(ix, group);
    }
    /* 1) límite de la URL: solo compiten las entradas de la misma URL */
    while (group_max && gb + size > group_max) {
        long v = select_victim(ix, policy, group);
        if (v < 0) break;
        gb -= ix->e[v].size;
        if (cb) cb(ix->e[v].key, ud);
        remove_at(ix, (size_t)v);
    }
    /* 2) límite del dominio: compiten todas */
    while (ix->total_bytes + size > ix->max_bytes && ix->n > 0) {
        long v = select_victim(ix, policy, 0);
        if (cb) cb(ix->e[v].key, ud);
        remove_at(ix, (size_t)v);
    }
    if (ix->n == ix->cap) {
        size_t nc = ix->cap ? ix->cap * 2 : 64;
        zc_entry_t *ne = realloc(ix->e, nc * sizeof(*ne));
        if (!ne) { pthread_mutex_unlock(&ix->mu); return -2; }
        ix->e = ne; ix->cap = nc;
    }
    zc_entry_t *e = &ix->e[ix->n++];
    memset(e, 0, sizeof(*e));
    snprintf(e->key, sizeof(e->key), "%s", key);
    e->size = size;
    e->group = group;
    e->inserted_seq = e->accessed_seq = ++ix->seq;
    e->expires_at = ttl > 0 ? now + ttl : 0;
    ix->total_bytes += size;
    pthread_mutex_unlock(&ix->mu);
    return 0;
}

size_t zc_index_group_bytes(zc_index_t *ix, uint32_t group) {
    pthread_mutex_lock(&ix->mu); size_t r = group_bytes(ix, group); pthread_mutex_unlock(&ix->mu); return r;
}

int zc_index_remove(zc_index_t *ix, const char *key) {
    pthread_mutex_lock(&ix->mu);
    long i = find(ix, key);
    if (i >= 0) remove_at(ix, (size_t)i);
    pthread_mutex_unlock(&ix->mu);
    return i >= 0;
}

void zc_index_set_max(zc_index_t *ix, size_t max_bytes, zc_policy_t policy, zc_evict_cb cb, void *ud) {
    pthread_mutex_lock(&ix->mu);
    ix->max_bytes = max_bytes;
    while (ix->total_bytes > ix->max_bytes && ix->n > 0) {
        long v = select_victim(ix, policy, 0);
        if (cb) cb(ix->e[v].key, ud);
        remove_at(ix, (size_t)v);
    }
    pthread_mutex_unlock(&ix->mu);
}

size_t zc_index_bytes(zc_index_t *ix) { pthread_mutex_lock(&ix->mu); size_t r = ix->total_bytes; pthread_mutex_unlock(&ix->mu); return r; }
size_t zc_index_count(zc_index_t *ix) { pthread_mutex_lock(&ix->mu); size_t r = ix->n; pthread_mutex_unlock(&ix->mu); return r; }

int zc_index_save(zc_index_t *ix, const char *path) {
    char tmp[1024];
    snprintf(tmp, sizeof(tmp), "%s.tmp", path);
    FILE *f = fopen(tmp, "w");
    if (!f) return -1;
    pthread_mutex_lock(&ix->mu);
    fprintf(f, "ZCIDX2 %llu\n", (unsigned long long)ix->seq);
    for (size_t i = 0; i < ix->n; i++) {
        const zc_entry_t *e = &ix->e[i];
        fprintf(f, "%s %zu %llu %llu %llu %lld %u\n", e->key, e->size,
                (unsigned long long)e->inserted_seq, (unsigned long long)e->accessed_seq,
                (unsigned long long)e->hits, (long long)e->expires_at, (unsigned)e->group);
    }
    pthread_mutex_unlock(&ix->mu);
    int ok = (fflush(f) == 0 && fsync(fileno(f)) == 0);
    fclose(f);
    if (!ok || rename(tmp, path) != 0) { unlink(tmp); return -1; }
    return 0;
}

int zc_index_load(zc_index_t *ix, const char *path) {
    FILE *f = fopen(path, "r");
    if (!f) return -1;
    char line[512];
    unsigned long long seq = 0;
    int ver = 0;
    if (fgets(line, sizeof(line), f)) {
        if (sscanf(line, "ZCIDX2 %llu", &seq) == 1) ver = 2;
        else if (sscanf(line, "ZCIDX1 %llu", &seq) == 1) ver = 1;   /* formato anterior, sin grupo */
    }
    if (!ver) { fclose(f); return -1; }
    pthread_mutex_lock(&ix->mu);
    ix->n = 0; ix->total_bytes = 0; ix->seq = seq;
    while (fgets(line, sizeof(line), f)) {
        char key[ZC_KEY_MAX]; size_t size; unsigned long long ins, acc, hits; long long exp; unsigned grp = 0;
        int got = sscanf(line, "%128s %zu %llu %llu %llu %lld %u", key, &size, &ins, &acc, &hits, &exp, &grp);
        if (got < 6 || (ver == 2 && got != 7)) continue;
        if (!key_valid(key)) continue; /* no se descarta por tamaño: el llamador aplica zc_index_set_max con su cb */
        if (ix->n == ix->cap) {
            size_t nc = ix->cap ? ix->cap * 2 : 64;
            zc_entry_t *ne = realloc(ix->e, nc * sizeof(*ne));
            if (!ne) break;
            ix->e = ne; ix->cap = nc;
        }
        zc_entry_t *e = &ix->e[ix->n++];
        snprintf(e->key, sizeof(e->key), "%s", key);
        e->size = size; e->group = grp; e->inserted_seq = ins; e->accessed_seq = acc; e->hits = hits; e->expires_at = (time_t)exp;
        ix->total_bytes += size;
        if (ins > ix->seq) ix->seq = ins;
        if (acc > ix->seq) ix->seq = acc;
    }
    pthread_mutex_unlock(&ix->mu);
    fclose(f);
    return 0;
}
