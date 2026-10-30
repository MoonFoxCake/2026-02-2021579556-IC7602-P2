/* zc_policy.h — índice de metadatos de caché y políticas de reemplazo.
 * Persona 3. Una instancia de zc_index_t por dominio (límite en bytes por dominio). */
#ifndef ZC_POLICY_H
#define ZC_POLICY_H
#include <stddef.h>
#include <stdint.h>
#include <time.h>
#include <pthread.h>

#define ZC_KEY_MAX 129 /* 128 chars + NUL. Claves: [A-Za-z0-9._-], p.ej. sha256 hex */

typedef enum { ZC_POLICY_LRU, ZC_POLICY_LFU, ZC_POLICY_FIFO, ZC_POLICY_MRU, ZC_POLICY_RANDOM } zc_policy_t;

int         zc_policy_parse(const char *s, zc_policy_t *out); /* 0 ok, -1 desconocida (case-insensitive) */
const char *zc_policy_name(zc_policy_t p);

typedef struct {
    char     key[ZC_KEY_MAX];
    size_t   size;
    uint64_t inserted_seq;  /* FIFO */
    uint64_t accessed_seq;  /* LRU / MRU */
    uint64_t hits;          /* LFU */
    time_t   expires_at;    /* 0 = no expira */
    uint32_t group;         /* grupo = regla/URL dueña de la entrada (0 = sin grupo). Ver zc_group_id */
} zc_entry_t;

typedef struct {
    zc_entry_t     *e;
    size_t          n, cap;
    uint64_t        seq;
    size_t          total_bytes, max_bytes;
    unsigned        rng;
    pthread_mutex_t mu;
} zc_index_t;

/* Se invoca por cada entrada expulsada: el llamador debe borrar el archivo en disco.
 * Se llama con el lock del índice tomado: NO llamar de vuelta al índice desde el callback. */
typedef void (*zc_evict_cb)(const char *key, void *ud);

int    zc_index_init(zc_index_t *ix, size_t max_bytes);
void   zc_index_free(zc_index_t *ix);

/* 1 = hit vigente (actualiza metadatos), 0 = miss, -1 = estaba expirada (se elimina y se llama cb). */
int    zc_index_lookup(zc_index_t *ix, const char *key, time_t now, zc_evict_cb cb, void *ud);

/* Registra una entrada nueva (o reemplaza la existente). Expulsa con la política dada hasta que quepa.
 * Primero se descartan las expiradas. ttl<=0 = sin expiración.
 * 0 ok; -1 clave inválida o size > max_bytes (no cachear); -2 sin memoria. */
int    zc_index_put(zc_index_t *ix, const char *key, size_t size, long ttl, zc_policy_t policy,
                    time_t now, zc_evict_cb cb, void *ud);

/* Igual que zc_index_put pero además respeta el tamaño de caché de la URL (cacheBytes):
 * mientras el grupo no quepa en group_max se expulsan entradas DEL MISMO grupo; luego se aplica el
 * límite del dominio sobre todas las entradas. group_max == 0 = sin límite por URL. */
int    zc_index_put_ex(zc_index_t *ix, const char *key, size_t size, long ttl, zc_policy_t policy,
                       uint32_t group, size_t group_max, time_t now, zc_evict_cb cb, void *ud);
size_t zc_index_group_bytes(zc_index_t *ix, uint32_t group);
uint32_t zc_group_id(const char *pattern); /* FNV-1a del patrón de la URL; estable entre refrescos; nunca 0 */

int    zc_index_remove(zc_index_t *ix, const char *key); /* 1 si existía */
void   zc_index_set_max(zc_index_t *ix, size_t max_bytes, zc_policy_t policy, zc_evict_cb cb, void *ud);
size_t zc_index_bytes(zc_index_t *ix);
size_t zc_index_count(zc_index_t *ix);

int    zc_index_save(zc_index_t *ix, const char *path); /* atómico (tmp + rename) */
int    zc_index_load(zc_index_t *ix, const char *path); /* 0 ok; -1 no existe/ilegible.
                                                       * Si lo cargado excede max_bytes, llame zc_index_set_max
                                                       * para expulsar CON callback (borrar archivos). */
#endif
