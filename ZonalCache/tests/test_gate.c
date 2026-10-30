#include "check.h"
#include "zc_gate.h"
#include <string.h>
#include <unistd.h>
#include <sys/stat.h>

/* sha256("clave-demo") */
static const char *CFG =
 "{\"domains\":[{\"domain\":\"ejemplo.com\",\"origin\":\"http://origen:8080\",\"maxCacheBytes\":1000,\"urls\":["
 " {\"pattern\":\"/*\",\"auth\":{\"mode\":\"none\"},\"fileTypes\":[{\"ext\":\"html\",\"ttl\":60,\"policy\":\"LRU\"}]},"
 " {\"pattern\":\"/api/*\",\"auth\":{\"mode\":\"apikey\",\"apiKeyHashes\":[\"%s\"]},\"fileTypes\":[{\"ext\":\"*\",\"ttl\":5,\"policy\":\"MRU\"}]},"
 " {\"pattern\":\"/privado/*\",\"cacheBytes\":300,\"auth\":{\"mode\":\"userpass\"},\"fileTypes\":[{\"ext\":\"*\",\"ttl\":0,\"policy\":\"FIFO\"}]}]}]}";

static int fake_verify(const char *h, const char *p, const char *u, const char *pw, void *ud) {
    (void)h; (void)p; (void)ud; return !strcmp(u, "kevin") && !strcmp(pw, "s3creto");
}
static zc_req_t R(const char *m, const char *t) {
    zc_req_t r = { .method = m, .host = "Ejemplo.com:8080", .target = t, .client_ip = "10.0.0.1" };
    return r;
}
static int has(const zc_gate_res_t *g, const char *s) { return strstr(g->headers, s) != NULL; }
static void cookie_from(const zc_gate_res_t *g, const char *name, char *out, size_t cap) {
    const char *p = strstr(g->headers, name); out[0] = '\0';
    if (!p) return;
    size_t k = strcspn(p, ";\r"); snprintf(out, cap, "%.*s", (int)k, p);
}

int main(void) {
    printf("test_gate\n"); char err[256] = "";
    char hash[65]; zc_sha256_hex("clave-demo", 10, hash);
    FILE *f = fopen("/tmp/zc_gate_cfg.json", "w"); fprintf(f, CFG, hash); fclose(f);
    if (system("rm -rf /tmp/zc_gate_cache")) {}
    unsetenv("ZC_CONFIG_URL"); setenv("ZC_CONFIG_FILE", "/tmp/zc_gate_cfg.json", 1);

    zc_auth_opts_t o; memset(&o, 0, sizeof o);
    o.cookie_secure = 0; o.verify = fake_verify; o.login_max_attempts = 50;
    CHECK(zc_gate_init_with(&o, "/tmp/zc_gate_cache", err, sizeof err) == 0);
    zc_gate_res_t g; zc_req_t r; time_t now = 1000;

    /* dominio desconocido / validaciones */
    r = R("GET", "/"); r.host = "otro.com"; zc_gate_handle(&r, now, &g);
    CHECK(g.action == ZC_GATE_RESPOND && g.status == 404); zc_gate_done(&g);
    r = R("GET", "sin-barra"); zc_gate_handle(&r, now, &g); CHECK(g.status == 400); zc_gate_done(&g);
    r = R("GET", "/"); r.host = NULL; zc_gate_handle(&r, now, &g); CHECK(g.status == 400); zc_gate_done(&g);
    r = R("GET", "/__zc/otra"); zc_gate_handle(&r, now, &g); CHECK(g.status == 404); zc_gate_done(&g);

    /* público: proxy cacheable, MISS -> store -> HIT */
    r = R("GET", "/index.html?v=1"); zc_gate_handle(&r, now, &g);
    CHECK(g.action == ZC_GATE_PROXY && g.cacheable && !g.authenticated && g.ft && g.ft->ttl == 60);
    CHECK(strlen(g.cache_key) == 64 && !strcmp(g.domain->origin, "http://origen:8080"));
    CHECK(!strcmp(g.domain_dir, "/tmp/zc_gate_cache/ejemplo.com"));
    CHECK(zc_gate_cache_lookup(&g, now) == 0 && zc_gate_cache_store(&g, 100, now) == 0);
    char key1[65]; strcpy(key1, g.cache_key); zc_gate_done(&g);
    r = R("GET", "/index.html?v=1"); r.host = "EJEMPLO.COM"; zc_gate_handle(&r, now, &g);
    CHECK(!strcmp(g.cache_key, key1) && zc_gate_cache_lookup(&g, now) == 1); zc_gate_done(&g);   /* misma clave sin importar mayúsculas/puerto */
    r = R("HEAD", "/index.html?v=1"); zc_gate_handle(&r, now, &g); CHECK(!strcmp(g.cache_key, key1) && g.cacheable); zc_gate_done(&g);
    r = R("POST", "/index.html?v=1"); zc_gate_handle(&r, now, &g); CHECK(g.action == ZC_GATE_PROXY && !g.cacheable); zc_gate_done(&g);
    r = R("GET", "/foto.jpg"); zc_gate_handle(&r, now, &g); CHECK(g.action == ZC_GATE_PROXY && !g.cacheable && !g.ft); zc_gate_done(&g);

    /* API key */
    r = R("GET", "/api/users"); zc_gate_handle(&r, now, &g);
    CHECK(g.status == 401 && has(&g, "WWW-Authenticate") && strstr(g.body, "x-api-key")); zc_gate_done(&g);
    r = R("GET", "/api/users"); r.x_api_key = "mala"; zc_gate_handle(&r, now, &g); CHECK(g.status == 401); zc_gate_done(&g);
    r = R("GET", "/api/users"); r.x_api_key = "clave-demo"; r.cookie = "a=1; zc_session=xyz; zc_csrf=k; b=2";
    zc_gate_handle(&r, now, &g);
    CHECK(g.action == ZC_GATE_PROXY && g.authenticated && g.ft->policy == ZC_POLICY_MRU);
    CHECK(!strcmp(g.upstream_cookie, "a=1; b=2")); zc_gate_done(&g);

    /* usuario/contraseña, modo local */
    r = R("GET", "/privado/a.txt?x=1"); zc_gate_handle(&r, now, &g);
    CHECK(g.status == 302 && has(&g, "Location: /__zc/login?return_to=%2Fprivado%2Fa.txt%3Fx%3D1")); zc_gate_done(&g);
    r = R("DELETE", "/privado/a.txt"); zc_gate_handle(&r, now, &g); CHECK(g.status == 401); zc_gate_done(&g);
    r = R("GET", "/__zc/login?return_to=/index.html"); zc_gate_handle(&r, now, &g); CHECK(g.status == 400); zc_gate_done(&g);

    r = R("GET", "/__zc/login?return_to=%2Fprivado%2Fa.txt"); zc_gate_handle(&r, now, &g);
    CHECK(g.status == 200 && has(&g, "zc_csrf=") && strstr(g.body, "name=\"csrf\""));
    char csrfck[200]; cookie_from(&g, "zc_csrf=", csrfck, sizeof csrfck); zc_gate_done(&g);
    char body[600];
    /* sin CSRF -> 403 */
    snprintf(body, sizeof body, "username=kevin&password=s3creto&return_to=%%2Fprivado%%2Fa.txt");
    r = R("POST", "/__zc/login"); r.body = body; r.body_len = strlen(body); zc_gate_handle(&r, now, &g);
    CHECK(g.status == 403); zc_gate_done(&g);
    /* contraseña mala -> 401 con formulario */
    snprintf(body, sizeof body, "username=kevin&password=no&return_to=%%2Fprivado%%2Fa.txt&csrf=%s", csrfck + 8);
    r = R("POST", "/__zc/login"); r.body = body; r.body_len = strlen(body); r.cookie = csrfck; zc_gate_handle(&r, now, &g);
    CHECK(g.status == 401 && strstr(g.body, "incorrectos")); zc_gate_done(&g);
    /* correcta -> 302 + cookie */
    snprintf(body, sizeof body, "username=kevin&password=s3creto&return_to=%%2Fprivado%%2Fa.txt&csrf=%s", csrfck + 8);
    r = R("POST", "/__zc/login"); r.body = body; r.body_len = strlen(body); r.cookie = csrfck; zc_gate_handle(&r, now, &g);
    CHECK(g.status == 302 && has(&g, "Location: /privado/a.txt\r\n") && has(&g, "zc_session=") && has(&g, "HttpOnly"));
    char sess[200]; cookie_from(&g, "zc_session=", sess, sizeof sess); zc_gate_done(&g);
    r = R("GET", "/privado/a.txt"); r.cookie = sess; zc_gate_handle(&r, now, &g);
    CHECK(g.action == ZC_GATE_PROXY && g.authenticated && g.group != 0 && g.group_max == 300);
    /* cacheBytes de la URL = 300: el tercer objeto de 150 expulsa al primero (FIFO) */
    CHECK(zc_gate_cache_store(&g, 150, now) == 0); zc_gate_done(&g);
    r = R("GET", "/privado/b.txt"); r.cookie = sess; zc_gate_handle(&r, now, &g); CHECK(zc_gate_cache_store(&g, 150, now) == 0); zc_gate_done(&g);
    f = fopen("/tmp/zc_gate_cache/ejemplo.com/marca", "w"); fclose(f);
    r = R("GET", "/privado/c.txt"); r.cookie = sess; zc_gate_handle(&r, now, &g);
    CHECK(zc_gate_cache_store(&g, 150, now) == 0 && zc_index_group_bytes(g.index, g.group) == 300);
    CHECK(zc_index_bytes(g.index) == 400); zc_gate_done(&g);   /* 100 de index.html + 300 de /privado */
    r = R("GET", "/privado/a.txt"); r.cookie = sess; zc_gate_handle(&r, now, &g); CHECK(zc_gate_cache_lookup(&g, now) == 0); zc_gate_done(&g);
    /* el archivo expulsado se borra del disco */
    r = R("GET", "/privado/d.txt"); r.cookie = sess; zc_gate_handle(&r, now, &g);
    char fp[1300]; snprintf(fp, sizeof fp, "%s/%s", g.domain_dir, g.cache_key);
    f = fopen(fp, "w"); fputs("x", f); fclose(f);
    CHECK(zc_gate_cache_store(&g, 150, now) == 0); char kd[65]; strcpy(kd, g.cache_key); zc_gate_done(&g);
    r = R("GET", "/privado/e.txt"); r.cookie = sess; zc_gate_handle(&r, now, &g); zc_gate_cache_store(&g, 150, now); zc_gate_done(&g);
    r = R("GET", "/privado/f.txt"); r.cookie = sess; zc_gate_handle(&r, now, &g); zc_gate_cache_store(&g, 150, now); zc_gate_done(&g);
    CHECK(access(fp, F_OK) != 0);

    /* logout */
    r = R("GET", "/__zc/logout?return_to=/index.html"); r.cookie = sess; zc_gate_handle(&r, now, &g);
    CHECK(g.status == 302 && has(&g, "Location: /index.html") && has(&g, "Max-Age=0")); zc_gate_done(&g);
    r = R("GET", "/privado/a.txt"); r.cookie = sess; zc_gate_handle(&r, now, &g); CHECK(g.status == 302); zc_gate_done(&g);
    /* open redirect bloqueado */
    r = R("GET", "/__zc/logout?return_to=//evil.com"); zc_gate_handle(&r, now, &g); CHECK(has(&g, "Location: /\r\n")); zc_gate_done(&g);

    CHECK(zc_gate_save() == 0 && access("/tmp/zc_gate_cache/ejemplo.com/index.zc", R_OK) == 0);
    zc_gate_shutdown();

    /* ---- modo UI ---- */
    const char *SECRET = "secreto-compartido-de-pruebas-0123456789";
    zc_auth_opts_t ou; memset(&ou, 0, sizeof ou);
    ou.login_mode = ZC_LOGIN_UI; ou.login_ui_url = "https://ui.test/cache-login";
    CHECK(zc_gate_init_with(&ou, NULL, err, sizeof err) == -1);                  /* falta el secreto */
    ou.ticket_secret = SECRET; ou.ticket_max_age = 120; ou.cookie_secure = 1;
    CHECK(zc_gate_init_with(&ou, NULL, err, sizeof err) == 0);
    r = R("GET", "/privado/a.txt"); r.is_tls = 1; zc_gate_handle(&r, now, &g);
    CHECK(g.status == 302 && has(&g, "Location: https://ui.test/cache-login?domain=ejemplo.com&pattern=%2Fprivado%2F%2A&callback=https%3A%2F%2FEjemplo.com%3A8080%2F__zc%2Fcallback&return_to=%2Fprivado%2Fa.txt"));
    zc_gate_done(&g);
    r = R("POST", "/__zc/login"); body[0] = 0; r.body = body; zc_gate_handle(&r, now, &g); CHECK(g.status == 405 || g.status == 400); zc_gate_done(&g);
    char tk[3000], tgt[3300];
    zc_ticket_make(SECRET, "ejemplo.com", "/privado/*", "kevin", now + 60, tk, sizeof tk);
    snprintf(tgt, sizeof tgt, "/__zc/callback?ticket=%s&return_to=%%2Fprivado%%2Fa.txt", tk);
    r = R("GET", tgt); zc_gate_handle(&r, now, &g);
    CHECK(g.status == 302 && has(&g, "Location: /privado/a.txt") && has(&g, "; Secure"));
    cookie_from(&g, "zc_session=", sess, sizeof sess); zc_gate_done(&g);
    r = R("GET", tgt); zc_gate_handle(&r, now, &g); CHECK(g.status == 401 && strstr(g.body, "ya fue usado")); zc_gate_done(&g);
    r = R("GET", "/privado/a.txt"); r.cookie = sess; zc_gate_handle(&r, now, &g); CHECK(g.action == ZC_GATE_PROXY); zc_gate_done(&g);
    zc_gate_shutdown();

    unlink("/tmp/zc_gate_cfg.json"); if (system("rm -rf /tmp/zc_gate_cache")) {}
    DONE();
}
