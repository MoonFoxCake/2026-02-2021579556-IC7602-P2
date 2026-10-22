/* zc_auth.h — autenticación de peticiones HTTP de la Zonal Cache (Persona 3).
 *  - API Key por encabezado x-api-key (se compara el SHA-256 contra los hashes de la config)
 *  - Usuario/contraseña: formulario servido por la caché, credenciales verificadas llamando al
 *    API del UI (Node.js), sesión por cookie HttpOnly con token aleatorio (solo se guarda su hash). */
#ifndef ZC_AUTH_H
#define ZC_AUTH_H
#include <stddef.h>
#include <time.h>
#include "zc_config.h"

#define ZC_LOGIN_PATH  "/__zc/login"
#define ZC_LOGOUT_PATH "/__zc/logout"
#define ZC_COOKIE_NAME "zc_session"

typedef enum {
    ZC_AUTH_ALLOW,           /* continuar con caché/origen */
    ZC_AUTH_DENY,            /* responder 401 (API key ausente o inválida) */
    ZC_AUTH_LOGIN_REQUIRED   /* responder 302 a ZC_LOGIN_PATH?return_to=... (o servir el formulario) */
} zc_auth_result_t;

/* Verificador de credenciales: 1 válidas, 0 inválidas, -1 error del upstream. Inyectable para pruebas. */
typedef int (*zc_verify_fn)(const char *host, const char *pattern, const char *user, const char *pass, void *ud);

typedef struct {
    long         session_ttl;        /* ZC_SESSION_TTL_SECS (3600) */
    size_t       max_sessions;       /* ZC_SESSION_MAX (10000) */
    int          login_max_attempts; /* ZC_LOGIN_MAX_ATTEMPTS (5) por IP y ventana */
    long         login_window;       /* ZC_LOGIN_WINDOW_SECS (300) */
    int          cookie_secure;      /* ZC_COOKIE_SECURE (1): agrega el atributo Secure */
    zc_verify_fn verify;             /* NULL = HTTP POST a verify_url */
    void        *verify_ud;
    const char  *verify_url;         /* ZC_VERIFY_URL (por defecto ZC_CONFIG_URL) */
    const char  *verify_token;       /* ZC_VERIFY_TOKEN (por defecto ZC_CONFIG_TOKEN) */
} zc_auth_opts_t;

typedef struct zc_auth zc_auth_t;

void              zc_auth_opts_from_env(zc_auth_opts_t *o);
zc_auth_t        *zc_auth_new(const zc_auth_opts_t *o);
void              zc_auth_free(zc_auth_t *a);

/* Decide si la petición puede continuar. rule == NULL => ALLOW. host/cookie_header/x_api_key pueden ser NULL. */
zc_auth_result_t  zc_auth_check(zc_auth_t *a, const zc_rule_t *rule, const char *host,
                                const char *x_api_key, const char *cookie_header, time_t now);

/* Procesa el POST del formulario. 0 ok (token_out = token de sesión); -1 credenciales inválidas;
 * -2 demasiados intentos (responder 429); -3 error del servicio de verificación (responder 502). */
int               zc_auth_login(zc_auth_t *a, const char *host, const char *pattern, const char *user,
                                const char *pass, const char *client_ip, time_t now,
                                char *token_out, size_t cap);
int               zc_auth_logout(zc_auth_t *a, const char *cookie_header); /* 1 si había sesión */

/* Cabeceras Set-Cookie listas para enviar. */
void              zc_auth_set_cookie(const zc_auth_t *a, const char *token, char *out, size_t cap);
void              zc_auth_clear_cookie(const zc_auth_t *a, char *out, size_t cap);

/* Utilidades para el servidor HTTP */
char             *zc_auth_login_form(const char *host, const char *return_to, const char *error); /* HTML (malloc) */
void              zc_safe_return_path(const char *in, char *out, size_t cap); /* solo rutas locales: anti open-redirect */
int               zc_form_get(const char *body, const char *key, char *out, size_t cap); /* x-www-form-urlencoded; 1 si existe */
int               zc_cookie_get(const char *cookie_header, const char *name, char *out, size_t cap);
void              zc_sha256_hex(const void *data, size_t n, char out[65]);
#endif
