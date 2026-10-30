#include "check.h"
#include "zc_config.h"
#include <string.h>
#include <unistd.h>

static void write_cfg(const char *path, size_t bytes) {
    FILE *f = fopen(path, "w");
    fprintf(f, "{\"domains\":[{\"domain\":\"a.com\",\"origin\":\"http://o\",\"maxCacheBytes\":%zu}]}", bytes);
    fclose(f);
}
int main(void) {
    printf("test_runtime\n"); char err[200] = "";
    unsetenv("ZC_CONFIG_FILE"); unsetenv("ZC_CONFIG_URL");
    CHECK(zc_cfg_runtime_start(err, sizeof err) == -1);                 /* sin fuente => error claro */
    write_cfg("/tmp/zc_cfg.json", 111);
    setenv("ZC_CONFIG_FILE", "/tmp/zc_cfg.json", 1); setenv("ZC_CONFIG_REFRESH_SECS", "1", 1);
    CHECK(zc_cfg_runtime_start(err, sizeof err) == 0);
    zc_cfg_handle_t *h1 = zc_cfg_acquire();
    CHECK(h1 && zc_cfg_get(h1)->domains[0].max_cache_bytes == 111);
    write_cfg("/tmp/zc_cfg.json", 222);
    sleep(2);
    zc_cfg_handle_t *h2 = zc_cfg_acquire();
    CHECK(zc_cfg_get(h2)->domains[0].max_cache_bytes == 222);          /* config nueva visible */
    CHECK(zc_cfg_get(h1)->domains[0].max_cache_bytes == 111);          /* snapshot viejo sigue válido mientras se use */
    FILE *f = fopen("/tmp/zc_cfg.json", "w"); fputs("{roto", f); fclose(f);
    sleep(2);
    zc_cfg_handle_t *h3 = zc_cfg_acquire();
    CHECK(zc_cfg_get(h3)->domains[0].max_cache_bytes == 222);          /* config inválida: se conserva la última buena */
    zc_cfg_release(h1); zc_cfg_release(h2); zc_cfg_release(h3);
    zc_cfg_runtime_stop();
    CHECK(zc_cfg_acquire() == NULL);
    unlink("/tmp/zc_cfg.json");
    DONE();
}
