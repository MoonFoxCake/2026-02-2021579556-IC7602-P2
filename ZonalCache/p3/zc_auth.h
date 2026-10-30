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
#define ZC_CALLBACK_PATH "/__zc/callback"
#define ZC_COOKIE_NAME "zc_session"
#define ZC_CSRF_COOKIE "zc_csrf"

/* Cómo se piden usuario/contraseña:
 *  LOCAL: la caché sirve su propio formulario (/__zc/login) y verifica con POST al API Node.js.
 *  UI:    la caché redirige al formulario del UI (React, Vercel). El UI autentica contra el API y
 *         redirige de vuelta a /__zc/callback?ticket=...; la caché valida el ticket (HMAC-SHA256 con
 *         ZC_TICKET_SECRET, compartido con el API Node.js), de un solo uso, y crea la sesión. */
typedef enum { ZC_LOGIN_LOCAL, ZC_LOGIN_UI } zc_login_mode_t;

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
    zc_login_mode_t login_mode;      /* ZC_LOGIN_MODE = local (default) | ui */
    const char  *login_ui_url;       /* ZC_LOGIN_UI_URL, p.ej. https://ui.vercel.app/cache-login */
    const char  *ticket_secret;      /* ZC_TICKET_SECRET (Secret de Kubernetes; >= 32 caracteres) */
    long         ticket_max_age;     /* ZC_TICKET_MAX_AGE_SECS (120): vida máxima aceptada de un ticket */
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

/* ---- Modo UI ----
 * URL a la que se redirige al usuario: {login_ui_url}?domain=&pattern=&callback=&return_to=
 * 0 ok; -1 falta configuración o no cabe. */
int               zc_auth_ui_login_url(const zc_auth_t *a, const char *host, const char *pattern, int is_tls,
                                       const char *return_to, char *out, size_t cap);
/* Valida el ticket del callback y crea la sesión. expected_pattern = patrón de la regla de return_to.
 * 0 ok (token_out); -1 inválido/expirado/otro dominio/otra regla; -4 ticket ya usado (replay). */
int               zc_auth_redeem_ticket(zc_auth_t *a, const char *ticket, const char *host,
                                        const char *expected_pattern, time_t now, char *token_out, size_t cap);
/* Genera un ticket (lo usa el mock y las pruebas; en producción lo genera el API Node.js). */
int               zc_ticket_make(const char *secret, const char *domain, const char *pattern, const char *user,
                                 time_t exp, char *out, size_t cap);
zc_login_mode_t   zc_auth_mode(const zc_auth_t *a);

/* ---- CSRF del formulario local (double-submit cookie) ---- */
int               zc_auth_csrf_new(char out[65]);
void              zc_auth_csrf_cookie(const zc_auth_t *a, const char *tok, char *out, size_t cap);
int               zc_auth_csrf_ok(const char *cookie_header, const char *form_value); /* 1 si coinciden */
char             *zc_auth_login_form_csrf(const char *host, const char *return_to, const char *error, const char *csrf);

/* Cabeceras Set-Cookie listas para enviar. */
void              zc_auth_set_cookie(const zc_auth_t *a, const char *token, char *out, size_t cap);
void              zc_auth_clear_cookie(const zc_auth_t *a, char *out, size_t cap);

/* Utilidades para el servidor HTTP */
char             *zc_auth_login_form(const char *host, const char *return_to, const char *error); /* HTML (malloc) */
void              zc_safe_return_path(const char *in, char *out, size_t cap); /* solo rutas locales: anti open-redirect */
int               zc_form_get(const char *body, const char *key, char *out, size_t cap); /* x-www-form-urlencoded; 1 si existe */
int               zc_cookie_get(const char *cookie_header, const char *name, char *out, size_t cap);
int               zc_query_get(const char *path_with_query, const char *key, char *out, size_t cap); /* 1 si existe */
void              zc_url_encode(const char *in, char *out, size_t cap);
void              zc_sha256_hex(const void *data, size_t n, char out[65]);
#endif
