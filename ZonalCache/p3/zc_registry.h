/* zc_registry.h — un índice de políticas (zc_index_t) por dominio, con persistencia en disco (Persona 3).
 *
 * Estructura en disco (ZC_CACHE_DIR, p.ej. /var/cache/zc):
 *   <dir>/<dominio-saneado>/index.zc      metadatos de políticas (lo escribe este módulo)
 *   <dir>/<dominio-saneado>/<clave>       objetos cacheados (los escribe la Persona 2)
 * "*.ejemplo.com" se guarda como "_wild_.ejemplo.com". */
#ifndef ZC_REGISTRY_H
#define ZC_REGISTRY_H
#include <stddef.h>
#include "zc_policy.h"
#include "zc_config.h"

typedef struct zc_registry zc_registry_t;

zc_registry_t *zc_registry_new(const char *dir);   /* dir NULL o "" = sin persistencia */
void           zc_registry_free(zc_registry_t *r);  /* no guarda: llame antes a zc_registry_save_all */

/* Devuelve el índice del dominio (lo crea y carga de disco la primera vez). Si en Firebase cambió
 * maxCacheBytes, aplica el nuevo límite expulsando con LRU (cb borra los archivos).
 * El puntero es estable mientras viva el registro. NULL si no hay memoria. */
zc_index_t    *zc_registry_get(zc_registry_t *r, const zc_domain_t *d, zc_evict_cb cb, void *ud);

/* Carpeta del dominio (se crea si no existe). 0 ok, -1 error o sin dir. */
int            zc_registry_domain_dir(zc_registry_t *r, const zc_domain_t *d, char *out, size_t cap);

int            zc_registry_save_all(zc_registry_t *r); /* 0 ok, -1 si alguno falló */

/* Nombre de carpeta seguro para un dominio: [a-z0-9.-_], sin "..". 0 ok, -1 inválido. */
int            zc_domain_dirname(const char *domain, char *out, size_t cap);
#endif
