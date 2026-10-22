#include "zc_tls.h"
#include <stdio.h>
#include <stdlib.h>
#include <signal.h>
#include <openssl/err.h>

#define SETERR(...) do { if (err && errlen) snprintf(err, errlen, __VA_ARGS__); } while (0)

SSL_CTX *zc_tls_ctx_from_env(char *err, size_t errlen) {
    signal(SIGPIPE, SIG_IGN); /* un cliente que cierra no debe matar el proceso al escribir/shutdown */
    const char *cert = getenv("ZC_TLS_CERT_FILE"), *key = getenv("ZC_TLS_KEY_FILE");
    if (!cert || !key) { SETERR("defina ZC_TLS_CERT_FILE y ZC_TLS_KEY_FILE"); return NULL; }
    SSL_CTX *ctx = SSL_CTX_new(TLS_server_method());
    if (!ctx) { SETERR("SSL_CTX_new falló"); return NULL; }
    SSL_CTX_set_min_proto_version(ctx, TLS1_2_VERSION);
    if (SSL_CTX_use_certificate_chain_file(ctx, cert) != 1) { SETERR("certificado inválido: %s", cert); goto fail; }
    if (SSL_CTX_use_PrivateKey_file(ctx, key, SSL_FILETYPE_PEM) != 1) { SETERR("llave privada inválida: %s", key); goto fail; }
    if (SSL_CTX_check_private_key(ctx) != 1) { SETERR("la llave no corresponde al certificado"); goto fail; }
    return ctx;
fail:
    SSL_CTX_free(ctx);
    return NULL;
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
