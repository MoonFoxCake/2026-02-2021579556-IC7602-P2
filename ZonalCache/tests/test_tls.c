#include "check.h"
#include "zc_tls.h"
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/wait.h>

int main(void) {
    printf("test_tls\n"); char err[200] = "";
    unsetenv("ZC_TLS_CERT_FILE");
    CHECK(zc_tls_ctx_from_env(err, sizeof err) == NULL);
    if (system("scripts/gen-dev-cert.sh /tmp/zc_certs localhost >/dev/null") != 0) { CHECK(0); DONE(); }
    setenv("ZC_TLS_CERT_FILE", "/tmp/zc_certs/dev.crt", 1);
    setenv("ZC_TLS_KEY_FILE", "/tmp/zc_certs/dev.key", 1);
    SSL_CTX *ctx = zc_tls_ctx_from_env(err, sizeof err);
    CHECK(ctx != NULL);
    setenv("ZC_TLS_KEY_FILE", "/tmp/zc_certs/dev.crt", 1);              /* llave inválida */
    CHECK(zc_tls_ctx_from_env(err, sizeof err) == NULL);
    if (!ctx) DONE();

    int sv[2]; CHECK(socketpair(AF_UNIX, SOCK_STREAM, 0, sv) == 0);
    pid_t pid = fork();
    if (pid == 0) {                                                      /* cliente */
        close(sv[0]);
        SSL_CTX *cc = SSL_CTX_new(TLS_client_method());
        SSL *s = SSL_new(cc); SSL_set_fd(s, sv[1]);
        if (SSL_connect(s) != 1) _exit(2);
        SSL_write(s, "ping", 4);
        char b[8] = {0}; int n = SSL_read(s, b, sizeof b - 1);
        _exit(n == 4 && !strcmp(b, "pong") && strcmp(SSL_get_version(s), "TLSv1.2") >= 0 ? 0 : 3);
    }
    close(sv[1]);
    SSL *s = zc_tls_accept(ctx, sv[0]);
    CHECK(s != NULL);
    if (s) {
        char b[8] = {0}; int n = zc_tls_read(s, b, sizeof b - 1);
        CHECK(n == 4 && !strcmp(b, "ping"));
        CHECK(zc_tls_write(s, "pong", 4) == 4);
        zc_tls_close(s);
    }
    int st = 0; waitpid(pid, &st, 0);
    CHECK(WIFEXITED(st) && WEXITSTATUS(st) == 0);
    close(sv[0]); SSL_CTX_free(ctx);
    DONE();
}
