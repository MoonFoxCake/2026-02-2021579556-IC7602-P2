/* zc_gate.h — punto único de integración de la Persona 3 con el servidor HTTP (Persona 2).
 *
 * Por cada petición, el servidor llena un zc_req_t y llama zc_gate_handle(). El gate:
 *   1. Busca dominio y regla (URL) en la config viva (Firebase vía API Node.js).
 *   2. Atiende las rutas propias /__zc/login, /__zc/logout y /__zc/callback.
 *   3. Aplica la seguridad de la regla (x-api-key o usuario/contraseña con sesión).
 *   4. Si se permite, devuelve ZC_GATE_PROXY con todo lo que la Persona 2 necesita para cachear:
 *      clave, tipo de archivo (TTL + política), índice del dominio, grupo/límite de la URL y carpeta.
 *
 * Uso mínimo (Persona 2):
 *
 *   zc_gate_res_t g;
 *   zc_gate_handle(&req, time(NULL), &g);
 *   if (g.action == ZC_GATE_RESPOND) { enviar g.status, g.headers, g.content_type, g.body; }
 *   else if (g.cacheable && zc_gate_cache_lookup(&g, now) == 1 && archivo <g.domain_dir>/<g.cache_key> existe)
 *        servir el archivo (X-Cache: HIT);
 *   else { pedir a g.domain->origin + req.target; enviar al cliente;
 *          if (g.cacheable && status 200) { escribir archivo; zc_gate_cache_store(&g, bytes, now); } }
 *   zc_gate_done(&g);
 */
#ifndef ZC_GATE_H
#define ZC_GATE_H
#include <stddef.h>
#include <stdint.h>
#include <time.h>
#include "zc_config.h"
#include "zc_auth.h"
#include "zc_policy.h"

typedef struct {
    const char *method;      /* "GET", "POST", ... */
    const char *host;        /* encabezado Host (puede traer :puerto) */
    const char *target;      /* ruta + query tal como llegó: "/img/a.png?v=2" */
    const char *x_api_key;   /* encabezado x-api-key o NULL */
    const char *cookie;      /* encabezado Cookie o NULL */
    const char *body;        /* cuerpo (solo se usa en POST /__zc/login), puede no terminar en NUL */
    size_t      body_len;
    const char *client_ip;   /* para el rate limit del login */
    int         is_tls;      /* 1 si la conexión llegó por HTTPS (SSL termination) */
} zc_req_t;

typedef enum { ZC_GATE_PROXY, ZC_GATE_RESPOND } zc_gate_action_t;

typedef struct {
    zc_gate_action_t action;

    /* ---- RESPOND: la Persona 2 envía esto tal cual ---- */
    int         status;
    char        headers[2048];    /* líneas extra "Nombre: valor\r\n" (Location, Set-Cookie, ...) */
    const char *content_type;
    char       *body;             /* malloc; lo libera zc_gate_done */
    size_t      body_len;

    /* ---- PROXY: petición permitida ---- */
    const zc_domain_t   *domain;  /* domain->origin = a dónde reenviar */
    const zc_rule_t     *rule;    /* NULL = el dominio no tiene regla para esa ruta (se hace proxy sin cachear) */
    const zc_filetype_t *ft;      /* NULL = tipo no configurado => no cachear */
    int         cacheable;        /* GET/HEAD con ft != NULL */
    int         authenticated;    /* la regla exige auth => responder con Cache-Control: private */
    char        cache_key[65];    /* sha256 hex de "GET <host> <target>"; también es el nombre del archivo */
    uint32_t    group;            /* grupo de la URL (límite cacheBytes) */
    size_t      group_max;
    zc_index_t *index;            /* índice de políticas del dominio */
    char        domain_dir[1024]; /* carpeta de los objetos del dominio ("" si no hay ZC_CACHE_DIR) */
    char        upstream_cookie[2048]; /* Cookie sin zc_session/zc_csrf, para reenviar al origen */

    zc_cfg_handle_t *_cfg;        /* privado: snapshot de config que mantiene vivos domain/rule/ft */
} zc_gate_res_t;

/* Inicializa desde variables de entorno (ver docs/PERSONA3.md). 0 ok, -1 error en err. */
int  zc_gate_init(char *err, size_t errlen);
/* Igual, con opciones explícitas (pruebas). cache_dir NULL = sin persistencia. */
int  zc_gate_init_with(const zc_auth_opts_t *auth, const char *cache_dir, char *err, size_t errlen);
void zc_gate_shutdown(void);                 /* guarda índices y libera todo */

void zc_gate_handle(const zc_req_t *rq, time_t now, zc_gate_res_t *rs);
void zc_gate_done(zc_gate_res_t *rs);

/* Ayudas de caché sobre el resultado PROXY (borran archivos de <domain_dir> al expulsar). */
int  zc_gate_cache_lookup(zc_gate_res_t *rs, time_t now);              /* 1 hit, 0 miss, -1 expirada */
int  zc_gate_cache_store(zc_gate_res_t *rs, size_t bytes, time_t now); /* 0 ok, -1 no cabe/no cacheable */
int  zc_gate_save(void);                                               /* guarda los índices (también lo hace un hilo) */

/* Callback de expulsión: borra <ud>/<key>. ud = domain_dir. */
void zc_gate_evict_file(const char *key, void *ud);
/* Quita zc_session y zc_csrf de un encabezado Cookie (no se filtran al origen). */
void zc_cookie_strip(const char *cookie_header, char *out, size_t cap);
#endif
