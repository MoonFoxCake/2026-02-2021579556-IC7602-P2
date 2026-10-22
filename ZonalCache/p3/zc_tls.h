/* zc_tls.h — SSL termination con OpenSSL (Persona 3).
 * Variables: ZC_TLS_CERT_FILE, ZC_TLS_KEY_FILE (PEM). TLS >= 1.2.
 * zc_tls_ctx_from_env() también ignora SIGPIPE a nivel de proceso (necesario en cualquier servidor). */
#ifndef ZC_TLS_H
#define ZC_TLS_H
#include <stddef.h>
#include <openssl/ssl.h>

SSL_CTX *zc_tls_ctx_from_env(char *err, size_t errlen); /* NULL si falta cert/key o son inválidos */
SSL     *zc_tls_accept(SSL_CTX *ctx, int client_fd);    /* handshake bloqueante; NULL si falla (no cierra el fd) */
int      zc_tls_read(SSL *s, void *buf, int n);          /* >0 bytes, 0 cierre, <0 error */
int      zc_tls_write(SSL *s, const void *buf, int n);
void     zc_tls_close(SSL *s);                           /* shutdown + free (no cierra el fd) */
#endif
