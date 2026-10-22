#include "check.h"
#include "zc_auth.h"
#include <string.h>
#include <stdlib.h>

static int calls;
static int fake_verify(const char *host, const char *pat, const char *u, const char *p, void *ud) {
    (void)host; (void)pat; (void)ud; calls++;
    if (!strcmp(u, "caido")) return -1;
    return !strcmp(u, "kevin") && !strcmp(p, "s3creto");
}

int main(void) {
    printf("test_auth\n");
    char h[65]; zc_sha256_hex("abc", 3, h);
    CHECK(strcmp(h, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad") == 0);

    zc_auth_opts_t o; memset(&o, 0, sizeof o);
    o.session_ttl = 100; o.max_sessions = 3; o.login_max_attempts = 3; o.login_window = 60;
    o.cookie_secure = 1; o.verify = fake_verify;
    zc_auth_t *a = zc_auth_new(&o);

    /* --- API key --- */
    char *keys[] = { "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" };
    zc_rule_t rk = { .pattern = "/api/*", .auth = ZC_AUTH_APIKEY, .key_hashes = keys, .n_keys = 1 };
    CHECK(zc_auth_check(a, &rk, "x.com", "abc", NULL, 0) == ZC_AUTH_ALLOW);
    CHECK(zc_auth_check(a, &rk, "x.com", "abd", NULL, 0) == ZC_AUTH_DENY);
    CHECK(zc_auth_check(a, &rk, "x.com", "", NULL, 0) == ZC_AUTH_DENY);
    CHECK(zc_auth_check(a, &rk, "x.com", NULL, NULL, 0) == ZC_AUTH_DENY);
    zc_rule_t rk0 = { .pattern = "/api/*", .auth = ZC_AUTH_APIKEY };           /* sin llaves: nadie pasa */
    CHECK(zc_auth_check(a, &rk0, "x.com", "abc", NULL, 0) == ZC_AUTH_DENY);
    CHECK(zc_auth_check(a, NULL, "x.com", NULL, NULL, 0) == ZC_AUTH_ALLOW);
    zc_rule_t rn = { .pattern = "/*", .auth = ZC_AUTH_NONE };
    CHECK(zc_auth_check(a, &rn, "x.com", NULL, NULL, 0) == ZC_AUTH_ALLOW);

    /* --- usuario/contraseña + sesión --- */
    zc_rule_t ru = { .pattern = "/priv/*", .auth = ZC_AUTH_USERPASS };
    char tok[80], ck[200], sc[300];
    CHECK(zc_auth_check(a, &ru, "x.com", NULL, NULL, 1000) == ZC_AUTH_LOGIN_REQUIRED);
    CHECK(zc_auth_login(a, "X.com:443", ru.pattern, "kevin", "mala", "1.1.1.1", 1000, tok, sizeof tok) == -1);
    CHECK(zc_auth_login(a, "x.com", ru.pattern, "caido", "x", "1.1.1.2", 1000, tok, sizeof tok) == -3);
    CHECK(zc_auth_login(a, "x.com", ru.pattern, "", "x", "1.1.1.3", 1000, tok, sizeof tok) == -1);
    CHECK(zc_auth_login(a, "X.com:443", ru.pattern, "kevin", "s3creto", "1.1.1.1", 1000, tok, sizeof tok) == 0 && strlen(tok) == 64);

    zc_auth_set_cookie(a, tok, sc, sizeof sc);
    CHECK(strstr(sc, "HttpOnly") && strstr(sc, "SameSite=Lax") && strstr(sc, "Secure") && strstr(sc, "Max-Age=100"));
    snprintf(ck, sizeof ck, "a=1; %s=%s; b=2", ZC_COOKIE_NAME, tok);
    CHECK(zc_auth_check(a, &ru, "x.com", NULL, ck, 1050) == ZC_AUTH_ALLOW);
    CHECK(zc_auth_check(a, &ru, "X.COM:8080", NULL, ck, 1050) == ZC_AUTH_ALLOW);               /* host normalizado */
    CHECK(zc_auth_check(a, &ru, "otro.com", NULL, ck, 1050) == ZC_AUTH_LOGIN_REQUIRED);         /* ligada al dominio */
    zc_rule_t ru2 = { .pattern = "/otra/*", .auth = ZC_AUTH_USERPASS };
    CHECK(zc_auth_check(a, &ru2, "x.com", NULL, ck, 1050) == ZC_AUTH_LOGIN_REQUIRED);           /* ligada a la regla */
    CHECK(zc_auth_check(a, &ru, "x.com", NULL, ck, 1101) == ZC_AUTH_LOGIN_REQUIRED);            /* expiró */
    CHECK(zc_auth_check(a, &ru, "x.com", NULL, "zc_session=inventada", 1050) == ZC_AUTH_LOGIN_REQUIRED);
    CHECK(zc_auth_check(a, &ru, "x.com", "abc", NULL, 1050) == ZC_AUTH_LOGIN_REQUIRED);         /* la API key no sirve en userpass */

    /* logout (sesión nueva: la anterior ya expiró y fue purgada) */
    CHECK(zc_auth_login(a, "x.com", ru.pattern, "kevin", "s3creto", "1.1.1.1", 1200, tok, sizeof tok) == 0);
    snprintf(ck, sizeof ck, "%s=%s", ZC_COOKIE_NAME, tok);
    CHECK(zc_auth_check(a, &ru, "x.com", NULL, ck, 1210) == ZC_AUTH_ALLOW);
    CHECK(zc_auth_logout(a, ck) == 1 && zc_auth_check(a, &ru, "x.com", NULL, ck, 1220) == ZC_AUTH_LOGIN_REQUIRED);
    CHECK(zc_auth_logout(a, ck) == 0);
    zc_auth_clear_cookie(a, sc, sizeof sc); CHECK(strstr(sc, "Max-Age=0"));

    /* límite de sesiones (3): la cuarta desplaza a la más próxima a expirar */
    char t[4][80];
    for (int i = 0; i < 4; i++)
        CHECK(zc_auth_login(a, "x.com", ru.pattern, "kevin", "s3creto", "9.9.9.9", 2000 + i, t[i], 80) == 0);
    char c0[200], c3[200];
    snprintf(c0, sizeof c0, "zc_session=%s", t[0]); snprintf(c3, sizeof c3, "zc_session=%s", t[3]);
    CHECK(zc_auth_check(a, &ru, "x.com", NULL, c0, 2010) == ZC_AUTH_LOGIN_REQUIRED);
    CHECK(zc_auth_check(a, &ru, "x.com", NULL, c3, 2010) == ZC_AUTH_ALLOW);

    /* rate limit por IP: 3 intentos por ventana (los exitosos reinician) */
    int before = calls;
    for (int i = 0; i < 3; i++) CHECK(zc_auth_login(a, "x.com", ru.pattern, "kevin", "mal", "6.6.6.6", 3000, tok, sizeof tok) == -1);
    CHECK(zc_auth_login(a, "x.com", ru.pattern, "kevin", "s3creto", "6.6.6.6", 3001, tok, sizeof tok) == -2);
    CHECK(calls == before + 3);                                     /* bloqueado: ni siquiera consulta al UI */
    CHECK(zc_auth_login(a, "x.com", ru.pattern, "kevin", "s3creto", "6.6.6.6", 3061, tok, sizeof tok) == 0); /* ventana nueva */

    /* utilidades */
    char out[64];
    CHECK(zc_form_get("username=ke%76in&password=a+b%26c&x=1", "username", out, sizeof out) && !strcmp(out, "kevin"));
    CHECK(zc_form_get("username=ke%76in&password=a+b%26c&x=1", "password", out, sizeof out) && !strcmp(out, "a b&c"));
    CHECK(!zc_form_get("username=k", "user", out, sizeof out) && !zc_form_get("a=b", "zz", out, sizeof out));
    zc_safe_return_path("/privado/a?x=1", out, sizeof out); CHECK(!strcmp(out, "/privado/a?x=1"));
    zc_safe_return_path("//evil.com", out, sizeof out);     CHECK(!strcmp(out, "/"));
    zc_safe_return_path("https://evil.com", out, sizeof out); CHECK(!strcmp(out, "/"));
    zc_safe_return_path("/\\evil.com", out, sizeof out);    CHECK(!strcmp(out, "/"));
    zc_safe_return_path(NULL, out, sizeof out);             CHECK(!strcmp(out, "/"));
    char *form = zc_auth_login_form("x.com", "/p", "<script>alert(1)</script>");
    CHECK(form && !strstr(form, "<script>") && strstr(form, "&lt;script&gt;") && strstr(form, ZC_LOGIN_PATH));
    free(form);
    zc_auth_free(a);
    DONE();
}
