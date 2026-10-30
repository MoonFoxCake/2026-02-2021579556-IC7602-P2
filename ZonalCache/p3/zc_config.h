/* zc_config.h — configuración de la Zonal Cache (dominios, URLs/reglas, tipos de archivo, auth).
 * Persona 3. La config se obtiene del API Node.js (que lee Firebase/Firestore) o de un archivo local. */
#ifndef ZC_CONFIG_H
#define ZC_CONFIG_H
#include <stddef.h>
#include "zc_policy.h"

typedef enum { ZC_AUTH_NONE, ZC_AUTH_APIKEY, ZC_AUTH_USERPASS } zc_auth_mode_t;

typedef struct { char ext[16]; long ttl; zc_policy_t policy; } zc_filetype_t; /* ext "*" = cualquier otra */

typedef struct {
    char          *pattern;      /* ruta con wildcards, p.ej. /static/ seguido de asterisco */
    zc_auth_mode_t auth;
    char         **key_hashes;   /* SHA-256 hex (minúsculas) de cada API key válida */
    size_t         n_keys;
    size_t         cache_bytes;  /* tamaño de caché declarado para la URL (0 = sin dato) */
    zc_filetype_t *types;
    size_t         n_types;
} zc_rule_t;

typedef struct {
    char      *domain;           /* admite wildcard: "*.ejemplo.com" */
    char      *origin;           /* "http://host:puerto" o "https://host" */
    size_t     max_cache_bytes;  /* límite por dominio */
    zc_rule_t *rules;
    size_t     n_rules;
} zc_domain_t;

typedef struct { zc_domain_t *domains; size_t n_domains; } zc_config_t;

zc_config_t *zc_config_parse(const char *json, char *err, size_t errlen);
zc_config_t *zc_config_load_file(const char *path, char *err, size_t errlen);
zc_config_t *zc_config_fetch(const char *base_url, const char *token, const char *zone, char *err, size_t errlen);
void         zc_config_free(zc_config_t *c);

/* Búsquedas (host puede traer ":puerto"; path puede traer "?query"). */
const zc_domain_t   *zc_config_find_domain(const zc_config_t *c, const char *host);
const zc_rule_t     *zc_domain_match_rule(const zc_domain_t *d, const char *path);  /* gana el patrón más específico */
const zc_filetype_t *zc_rule_filetype(const zc_rule_t *r, const char *path);        /* NULL = no cacheable */

int zc_wildcard_match(const char *pattern, const char *s, int case_insensitive);    /* '*' = cualquier secuencia */

/* ---- Config viva: carga inicial + refresco periódico, con reemplazo seguro ---- */
typedef struct zc_cfg_handle zc_cfg_handle_t;
/* Variables de entorno: ZC_CONFIG_URL + ZC_CONFIG_TOKEN + ZC_ZONE, o ZC_CONFIG_FILE.
 * ZC_CONFIG_REFRESH_SECS (default 60). 0 ok, -1 error (mensaje en err). */
int                 zc_cfg_runtime_start(char *err, size_t errlen);
void                zc_cfg_runtime_stop(void);
zc_cfg_handle_t    *zc_cfg_acquire(void);               /* snapshot inmutable; liberar con release */
const zc_config_t  *zc_cfg_get(const zc_cfg_handle_t *h);
void                zc_cfg_release(zc_cfg_handle_t *h);
#endif
