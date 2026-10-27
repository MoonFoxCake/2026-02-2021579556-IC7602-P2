#define _GNU_SOURCE
#include "zc_tls.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <signal.h>
#include <pthread.h>
#include <unistd.h>
#include <openssl/err.h>

#define SETERR(...) do { if (err && errlen) snprintf(err, errlen, __VA_ARGS__); } while (0)

/* ---------- SNI: un certificado por dominio ----------
 * ZC_TLS_CERT_DIR contiene <dominio>.crt / <dominio>.key; para comodines "wildcard.<padre>.crt/.key"
 * (p.ej. wildcard.ejemplo.com.crt sirve para a.ejemplo.com). Los contextos se cargan bajo demanda y se
 * reutilizan. Si no hay archivo para el nombre pedido, se usa el certificado por defecto. */
#define SNI_MAX 128
typedef struct { char name[256]; SSL_CTX *ctx; } sni_slot_t;
static struct {
    pthread_mutex_t mu; char dir[1024]; sni_slot_t s[SNI_MAX]; int n;
} S = { .mu = PTHREAD_MUTEX_INITIALIZER };

static int name_ok(const char *n) {
    if (!n || !*n || strlen(n) > 253 || n[0] == '.' || strstr(n, "..")) return 0;
    for (; *n; n++) if (!(isalnum((unsigned char)*n) || *n == '.' || *n == '-')) return 0;
    return 1;
}

static SSL_CTX *new_ctx(const char *cert, const char *key, char *err, size_t errlen) {
    SSL_CTX *ctx = SSL_CTX_new(TLS_server_method());
    if (!ctx) { SETERR("SSL_CTX_new falló"); return NULL; }
    SSL_CTX_set_min_proto_version(ctx, TLS1_2_VERSION);
    if (SSL_CTX_use_certificate_chain_file(ctx, cert) != 1) { SETERR("certificado inválido: %s", cert); goto fail; }
    if (SSL_CTX_use_PrivateKey_file(ctx, key, SSL_FILETYPE_PEM) != 1) { SETERR("llave privada inválida: %s", key); goto fail; }
    if (SSL_CTX_check_private_key(ctx) != 1) { SETERR("la llave no corresponde al certificado"); goto fail; }
    return ctx;
fail:
    SSL_CTX_free(ctx); ERR_clear_error();
    return NULL;
}

static SSL_CTX *load_pair(const char *base) {
    char c[1400], k[1400];
    snprintf(c, sizeof(c), "%s/%s.crt", S.dir, base);
    snprintf(k, sizeof(k), "%s/%s.key", S.dir, base);
    if (access(c, R_OK) != 0 || access(k, R_OK) != 0) return NULL;
    char err[256] = "";
    SSL_CTX *ctx = new_ctx(c, k, err, sizeof(err));
    if (!ctx) fprintf(stderr, "[zc_tls] %s\n", err);
    return ctx;
}

/* Busca/carga el contexto del nombre. Guarda también los "no encontrados" (ctx NULL) para no ir a disco cada vez. */
static SSL_CTX *sni_lookup(const char *name) {
    char lower[256]; size_t i;
    for (i = 0; name[i] && i + 1 < sizeof(lower); i++) lower[i] = (char)tolower((unsigned char)name[i]);
    lower[i] = '\0';
    SSL_CTX *ctx = NULL;
    pthread_mutex_lock(&S.mu);
    for (int j = 0; j < S.n; j++) if (!strcmp(S.s[j].name, lower)) { ctx = S.s[j].ctx; pthread_mutex_unlock(&S.mu); return ctx; }
    ctx = load_pair(lower);
    if (!ctx) {
        const char *dot = strchr(lower, '.');
        if (dot && strchr(dot + 1, '.')) { char w[300]; snprintf(w, sizeof(w), "wildcard%s", dot); ctx = load_pair(w); }
    }
    if (S.n < SNI_MAX) { snprintf(S.s[S.n].name, sizeof(S.s[S.n].name), "%s", lower); S.s[S.n].ctx = ctx; S.n++; }
    pthread_mutex_unlock(&S.mu);
    return ctx;
}

static int sni_cb(SSL *ssl, int *alert, void *arg) {
    (void)alert; (void)arg;
    const char *name = SSL_get_servername(ssl, TLSEXT_NAMETYPE_host_name);
    if (!name_ok(name)) return SSL_TLSEXT_ERR_OK;          /* sin SNI o nombre raro: certificado por defecto */
    SSL_CTX *ctx = sni_lookup(name);
    if (ctx) SSL_set_SSL_CTX(ssl, ctx);
    return SSL_TLSEXT_ERR_OK;
}

SSL_CTX *zc_tls_ctx_from_env(char *err, size_t errlen) {
    signal(SIGPIPE, SIG_IGN); /* un cliente que cierra no debe matar el proceso al escribir/shutdown */
    const char *cert = getenv("ZC_TLS_CERT_FILE"), *key = getenv("ZC_TLS_KEY_FILE"), *dir = getenv("ZC_TLS_CERT_DIR");
    if (!cert || !key) { SETERR("defina ZC_TLS_CERT_FILE y ZC_TLS_KEY_FILE"); return NULL; }
    SSL_CTX *ctx = new_ctx(cert, key, err, errlen);
    if (!ctx) return NULL;
    if (dir && *dir) {
        pthread_mutex_lock(&S.mu);
        snprintf(S.dir, sizeof(S.dir), "%s", dir);
        pthread_mutex_unlock(&S.mu);
        SSL_CTX_set_tlsext_servername_callback(ctx, sni_cb);
    }
    return ctx;
}

void zc_tls_sni_reset(void) {
    pthread_mutex_lock(&S.mu);
    for (int j = 0; j < S.n; j++) SSL_CTX_free(S.s[j].ctx);
    S.n = 0; S.dir[0] = '\0';
    pthread_mutex_unlock(&S.mu);
}

SSL *zc_tls_accept(SSL_CTX *ctx, int fd) {
    SSL *s = SSL_new(ctx);
    if (!s) return NULL;
    SSL_set_fd(s, fd);
    if (SSL_accept(s) != 1) { SSL_free(s); ERR_clear_error(); return NULL; }
    return s;
}
int zc_tls_read(SSL *s, void *b, int n)        { return SSL_read(s, b, n); }
int zc_tls_write(SSL *s, const void *b, int n) { return SSL_write(s, b, n); }
void zc_tls_close(SSL *s) { if (s) { SSL_shutdown(s); SSL_free(s); } }
