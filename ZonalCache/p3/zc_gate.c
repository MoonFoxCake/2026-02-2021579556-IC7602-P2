#define _GNU_SOURCE
#include "zc_gate.h"
#include "zc_registry.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <stdarg.h>
#include <unistd.h>
#include <pthread.h>
#include <curl/curl.h>

static struct {
    zc_auth_t *auth;
    zc_registry_t *reg;
    pthread_t saver; int saver_on, stop, save_secs;
} G;

/* ---------- respuestas ---------- */
static void add_header(zc_gate_res_t *rs, const char *fmt, ...) {
    size_t used = strlen(rs->headers);
    if (used + 4 >= sizeof(rs->headers)) return;
    va_list ap; va_start(ap, fmt);
    int n = vsnprintf(rs->headers + used, sizeof(rs->headers) - used - 2, fmt, ap);
    va_end(ap);
    if (n < 0 || used + (size_t)n + 2 >= sizeof(rs->headers)) { rs->headers[used] = '\0'; return; }
    strcat(rs->headers, "\r\n");
}

static void set_body(zc_gate_res_t *rs, const char *ctype, char *owned) {
    free(rs->body);
    rs->body = owned; rs->body_len = owned ? strlen(owned) : 0; rs->content_type = ctype;
}

static void respond(zc_gate_res_t *rs, int status, const char *title, const char *msg) {
    rs->action = ZC_GATE_RESPOND; rs->status = status;
    char *b = NULL;
    if (asprintf(&b, "<!doctype html><html lang=\"es\"><meta charset=\"utf-8\"><title>%d %s</title>"
                     "<body style=\"font-family:system-ui,sans-serif;margin:3rem\"><h1>%d %s</h1><p>%s</p></body></html>",
                 status, title, status, title, msg) < 0) b = NULL;
    set_body(rs, "text/html; charset=utf-8", b);
}

static void respond_json(zc_gate_res_t *rs, int status, const char *json) {
    rs->action = ZC_GATE_RESPOND; rs->status = status;
    set_body(rs, "application/json", strdup(json));
}

static void redirect(zc_gate_res_t *rs, const char *location) {
    rs->action = ZC_GATE_RESPOND; rs->status = 302;
    add_header(rs, "Location: %s", location);
    add_header(rs, "Cache-Control: no-store");
    set_body(rs, "text/plain; charset=utf-8", strdup("Redirigiendo...\n"));
}

/* ---------- utilidades ---------- */
void zc_gate_evict_file(const char *key, void *ud) {
    const char *dir = ud;
    if (!dir || !*dir || !key) return;
    char p[1400]; snprintf(p, sizeof(p), "%s/%s", dir, key);
    unlink(p);
}

void zc_cookie_strip(const char *h, char *out, size_t cap) {
    size_t o = 0;
    if (cap) out[0] = '\0';
    if (!h) return;
    const char *p = h;
    while (*p) {
        while (*p == ' ' || *p == ';') p++;
        size_t k = strcspn(p, ";");
        if (k == 0) break;
        int skip = (!strncmp(p, ZC_COOKIE_NAME "=", sizeof(ZC_COOKIE_NAME)) || !strncmp(p, ZC_CSRF_COOKIE "=", sizeof(ZC_CSRF_COOKIE)));
        if (!skip && o + k + 3 < cap) {
            if (o) { out[o++] = ';'; out[o++] = ' '; }
            memcpy(out + o, p, k); o += k; out[o] = '\0';
        }
        p += k;
    }
}

static void path_only(const char *target, char *out, size_t cap) {
    snprintf(out, cap, "%s", target ? target : "/");
    char *q = strpbrk(out, "?#"); if (q) *q = '\0';
}

static void host_lower(const char *h, char *out, size_t cap) {
    snprintf(out, cap, "%s", h ? h : "");
    char *c = strrchr(out, ':'); if (c && !strchr(c, ']')) *c = '\0';
    for (char *p = out; *p; p++) if (*p >= 'A' && *p <= 'Z') *p = (char)(*p - 'A' + 'a');
}

static const zc_rule_t *userpass_rule(const zc_domain_t *d, const char *return_to) {
    const zc_rule_t *r = zc_domain_match_rule(d, return_to);
    return (r && r->auth == ZC_AUTH_USERPASS) ? r : NULL;
}

static void login_redirect(zc_gate_res_t *rs, const zc_req_t *rq, const zc_rule_t *rule, const char *return_to) {
    char safe[2048], loc[6400];
    zc_safe_return_path(return_to, safe, sizeof(safe));
    if (zc_auth_mode(G.auth) == ZC_LOGIN_UI) {
        if (zc_auth_ui_login_url(G.auth, rq->host, rule->pattern, rq->is_tls, safe, loc, sizeof(loc)) != 0) {
            respond(rs, 500, "Error de configuraci&oacute;n", "ZC_LOGIN_MODE=ui requiere ZC_LOGIN_UI_URL.");
            return;
        }
    } else {
        char enc[3 * sizeof(safe)];
        zc_url_encode(safe, enc, sizeof(enc));
        snprintf(loc, sizeof(loc), ZC_LOGIN_PATH "?return_to=%s", enc);
    }
    redirect(rs, loc);
}

static void serve_form(zc_gate_res_t *rs, int status, const zc_req_t *rq, const char *return_to, const char *error) {
    char csrf[65];
    if (zc_auth_csrf_new(csrf) != 0) { respond(rs, 500, "Error", "No se pudo generar el token."); return; }
    char line[400]; zc_auth_csrf_cookie(G.auth, csrf, line, sizeof(line));
    add_header(rs, "%s", line);
    add_header(rs, "Cache-Control: no-store");
    rs->action = ZC_GATE_RESPOND; rs->status = status;
    set_body(rs, "text/html; charset=utf-8", zc_auth_login_form_csrf(rq->host, return_to, error, csrf));
}

static void session_ok(zc_gate_res_t *rs, const char *token, const char *return_to) {
    char line[400], safe[2048];
    zc_auth_set_cookie(G.auth, token, line, sizeof(line));
    zc_safe_return_path(return_to, safe, sizeof(safe));
    redirect(rs, safe);
    add_header(rs, "%s", line);
}

/* ---------- rutas propias ---------- */
static void handle_login(const zc_req_t *rq, time_t now, const zc_domain_t *d, zc_gate_res_t *rs) {
    int is_post = !strcasecmp(rq->method, "POST");
    char return_to[2048] = "/";
    char *body = NULL;
    if (is_post) {
        if (rq->body_len > 16384) { respond(rs, 413, "Demasiado grande", "Formulario demasiado grande."); return; }
        body = strndup(rq->body ? rq->body : "", rq->body_len);
        if (!body) { respond(rs, 500, "Error", "Sin memoria."); return; }
        zc_form_get(body, "return_to", return_to, sizeof(return_to));
    } else zc_query_get(rq->target, "return_to", return_to, sizeof(return_to));

    const zc_rule_t *rule = userpass_rule(d, return_to);
    if (!rule) { free(body); respond(rs, 400, "Solicitud inv&aacute;lida", "Ese recurso no requiere inicio de sesi&oacute;n."); return; }

    if (zc_auth_mode(G.auth) == ZC_LOGIN_UI) {          /* el formulario vive en el UI */
        free(body);
        if (is_post) { respond(rs, 405, "M&eacute;todo no permitido", "Inicie sesi&oacute;n desde el UI."); return; }
        login_redirect(rs, rq, rule, return_to);
        return;
    }
    if (!is_post) { serve_form(rs, 200, rq, return_to, NULL); return; }

    char csrf[128] = "", user[256] = "", pass[512] = "", tok[80];
    zc_form_get(body, "csrf", csrf, sizeof(csrf));
    zc_form_get(body, "username", user, sizeof(user));
    zc_form_get(body, "password", pass, sizeof(pass));
    free(body);
    if (!zc_auth_csrf_ok(rq->cookie, csrf)) { serve_form(rs, 403, rq, return_to, "La sesi\xC3\xB3n del formulario expir\xC3\xB3. Intente de nuevo."); return; }

    int r = zc_auth_login(G.auth, rq->host, rule->pattern, user, pass, rq->client_ip, now, tok, sizeof(tok));
    memset(pass, 0, sizeof(pass));
    if (r == 0) { session_ok(rs, tok, return_to); return; }
    if (r == -2) { respond(rs, 429, "Demasiados intentos", "Espere unos minutos e intente de nuevo."); add_header(rs, "Retry-After: 300"); return; }
    if (r == -3) { respond(rs, 502, "Servicio de autenticaci&oacute;n no disponible", "Intente m&aacute;s tarde."); return; }
    serve_form(rs, 401, rq, return_to, "Usuario o contrase\xC3\xB1" "a incorrectos.");
}

static void handle_callback(const zc_req_t *rq, time_t now, const zc_domain_t *d, zc_gate_res_t *rs) {
    char ticket[3000] = "", return_to[2048] = "/", tok[80];
    zc_query_get(rq->target, "ticket", ticket, sizeof(ticket));
    zc_query_get(rq->target, "return_to", return_to, sizeof(return_to));
    const zc_rule_t *rule = userpass_rule(d, return_to);
    if (!rule) { respond(rs, 400, "Solicitud inv&aacute;lida", "Ese recurso no requiere inicio de sesi&oacute;n."); return; }
    int r = zc_auth_redeem_ticket(G.auth, ticket, rq->host, rule->pattern, now, tok, sizeof(tok));
    if (r == 0) { session_ok(rs, tok, return_to); return; }
    respond(rs, 401, "No autorizado", r == -4 ? "Ese enlace de acceso ya fue usado. Inicie sesi&oacute;n de nuevo."
                                              : "El ticket de acceso es inv&aacute;lido o expir&oacute;.");
}

static void handle_logout(const zc_req_t *rq, zc_gate_res_t *rs) {
    char return_to[2048] = "/", line[300];
    zc_query_get(rq->target, "return_to", return_to, sizeof(return_to));
    zc_auth_logout(G.auth, rq->cookie);
    zc_auth_clear_cookie(G.auth, line, sizeof(line));
    char safe[2048]; zc_safe_return_path(return_to, safe, sizeof(safe));
    redirect(rs, safe);
    add_header(rs, "%s", line);
}

/* ---------- decisión principal ---------- */
void zc_gate_handle(const zc_req_t *rq, time_t now, zc_gate_res_t *rs) {
    memset(rs, 0, sizeof(*rs));
    rs->_cfg = zc_cfg_acquire();
    const zc_config_t *cfg = zc_cfg_get(rs->_cfg);
    if (!cfg || !G.auth) { respond(rs, 503, "No disponible", "La cach&eacute; a&uacute;n no tiene configuraci&oacute;n."); return; }
    if (!rq->method || !rq->target || rq->target[0] != '/' || strlen(rq->target) > 2000) {
        respond(rs, 400, "Solicitud inv&aacute;lida", "Ruta inv&aacute;lida."); return;
    }
    if (!rq->host || !*rq->host || strlen(rq->host) > 255) { respond(rs, 400, "Solicitud inv&aacute;lida", "Falta el encabezado Host."); return; }

    const zc_domain_t *d = zc_config_find_domain(cfg, rq->host);
    if (!d) { respond(rs, 404, "Dominio no administrado", "Este dominio no est&aacute; registrado en la cach&eacute;."); return; }
    rs->domain = d;

    char path[2048]; path_only(rq->target, path, sizeof(path));
    if (!strncmp(path, "/__zc/", 6)) {
        if (!strcmp(path, ZC_LOGIN_PATH))    { handle_login(rq, now, d, rs); return; }
        if (!strcmp(path, ZC_CALLBACK_PATH)) { handle_callback(rq, now, d, rs); return; }
        if (!strcmp(path, ZC_LOGOUT_PATH))   { handle_logout(rq, rs); return; }
        respond(rs, 404, "No encontrado", "Ruta reservada de la cach&eacute;."); return;
    }

    const zc_rule_t *rule = zc_domain_match_rule(d, rq->target);
    rs->rule = rule;
    switch (zc_auth_check(G.auth, rule, rq->host, rq->x_api_key, rq->cookie, now)) {
        case ZC_AUTH_DENY:
            respond_json(rs, 401, "{\"error\":\"x-api-key ausente o inv\\u00e1lida\"}");
            add_header(rs, "WWW-Authenticate: ApiKey header=\"x-api-key\"");
            return;
        case ZC_AUTH_LOGIN_REQUIRED:
            if (!strcasecmp(rq->method, "GET") || !strcasecmp(rq->method, "HEAD")) login_redirect(rs, rq, rule, rq->target);
            else respond_json(rs, 401, "{\"error\":\"requiere sesi\\u00f3n\"}");
            return;
        case ZC_AUTH_ALLOW: break;
    }

    /* Permitido: datos para que la Persona 2 haga proxy y caché */
    rs->action = ZC_GATE_PROXY;
    rs->authenticated = rule && rule->auth != ZC_AUTH_NONE;
    rs->ft = rule ? zc_rule_filetype(rule, rq->target) : NULL;
    rs->cacheable = rs->ft && (!strcasecmp(rq->method, "GET") || !strcasecmp(rq->method, "HEAD"));
    char hl[256], keysrc[2400]; host_lower(rq->host, hl, sizeof(hl));
    snprintf(keysrc, sizeof(keysrc), "GET %s %s", hl, rq->target);
    zc_sha256_hex(keysrc, strlen(keysrc), rs->cache_key);
    if (rule && rule->cache_bytes) { rs->group = zc_group_id(rule->pattern); rs->group_max = rule->cache_bytes; }
    if (zc_registry_domain_dir(G.reg, d, rs->domain_dir, sizeof(rs->domain_dir)) != 0) rs->domain_dir[0] = '\0';
    rs->index = zc_registry_get(G.reg, d, zc_gate_evict_file, rs->domain_dir);
    zc_cookie_strip(rq->cookie, rs->upstream_cookie, sizeof(rs->upstream_cookie));
}

void zc_gate_done(zc_gate_res_t *rs) {
    free(rs->body); rs->body = NULL;
    zc_cfg_release(rs->_cfg); rs->_cfg = NULL;
}

int zc_gate_cache_lookup(zc_gate_res_t *rs, time_t now) {
    if (rs->action != ZC_GATE_PROXY || !rs->cacheable || !rs->index) return 0;
    return zc_index_lookup(rs->index, rs->cache_key, now, zc_gate_evict_file, rs->domain_dir);
}

int zc_gate_cache_store(zc_gate_res_t *rs, size_t bytes, time_t now) {
    if (rs->action != ZC_GATE_PROXY || !rs->cacheable || !rs->index || !rs->ft) return -1;
    return zc_index_put_ex(rs->index, rs->cache_key, bytes, rs->ft->ttl, rs->ft->policy,
                           rs->group, rs->group_max, now, zc_gate_evict_file, rs->domain_dir) == 0 ? 0 : -1;
}

int zc_gate_save(void) { return G.reg ? zc_registry_save_all(G.reg) : 0; }

/* ---------- ciclo de vida ---------- */
static void *saver(void *arg) {
    (void)arg;
    for (;;) {
        for (int i = 0; i < G.save_secs; i++) { sleep(1); if (G.stop) return NULL; }
        if (zc_gate_save() != 0) fprintf(stderr, "[zc_gate] no se pudieron guardar los índices\n");
    }
}

int zc_gate_init_with(const zc_auth_opts_t *ao, const char *cache_dir, char *err, size_t errlen) {
    curl_global_init(CURL_GLOBAL_DEFAULT);
    if (ao->login_mode == ZC_LOGIN_UI && (!ao->login_ui_url || !ao->ticket_secret || strlen(ao->ticket_secret) < 16)) {
        if (err) snprintf(err, errlen, "ZC_LOGIN_MODE=ui requiere ZC_LOGIN_UI_URL y ZC_TICKET_SECRET (>= 16 caracteres)");
        return -1;
    }
    if (zc_cfg_runtime_start(err, errlen) != 0) return -1;
    G.auth = zc_auth_new(ao);
    G.reg = zc_registry_new(cache_dir);
    if (!G.auth || !G.reg) { if (err) snprintf(err, errlen, "sin memoria"); zc_gate_shutdown(); return -1; }
    const char *s = getenv("ZC_INDEX_SAVE_SECS");
    G.save_secs = s ? atoi(s) : 30; if (G.save_secs <= 0) G.save_secs = 30;
    G.stop = 0;
    if (cache_dir && *cache_dir && pthread_create(&G.saver, NULL, saver, NULL) == 0) G.saver_on = 1;
    return 0;
}

int zc_gate_init(char *err, size_t errlen) {
    zc_auth_opts_t o; zc_auth_opts_from_env(&o);
    return zc_gate_init_with(&o, getenv("ZC_CACHE_DIR"), err, errlen);
}

void zc_gate_shutdown(void) {
    if (G.saver_on) { G.stop = 1; pthread_join(G.saver, NULL); G.saver_on = 0; }
    if (G.reg) { zc_gate_save(); zc_registry_free(G.reg); G.reg = NULL; }
    if (G.auth) { zc_auth_free(G.auth); G.auth = NULL; }
    zc_cfg_runtime_stop();
}
