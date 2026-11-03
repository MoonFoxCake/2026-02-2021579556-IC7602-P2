#include "check.h"
#include "zc_registry.h"
#include <string.h>
#include <unistd.h>
#include <sys/stat.h>

static int nev;
static void cb(const char *k, void *ud) { (void)k; (void)ud; nev++; }

int main(void) {
    printf("test_registry\n");
    char out[256];
    CHECK(zc_domain_dirname("Ejemplo.COM", out, sizeof out) == 0 && !strcmp(out, "ejemplo.com"));
    CHECK(zc_domain_dirname("*.cdn.test", out, sizeof out) == 0 && !strcmp(out, "_wild_.cdn.test"));
    CHECK(zc_domain_dirname("../etc", out, sizeof out) == -1);
    CHECK(zc_domain_dirname("a/b", out, sizeof out) == -1);
    CHECK(zc_domain_dirname("", out, sizeof out) == -1);

    if (system("rm -rf /tmp/zc_reg_test")) {}
    zc_domain_t d = { .domain = "ejemplo.com", .max_cache_bytes = 300 };
    zc_registry_t *r = zc_registry_new("/tmp/zc_reg_test");
    zc_index_t *ix = zc_registry_get(r, &d, cb, NULL);
    CHECK(ix && ix == zc_registry_get(r, &d, cb, NULL));                 /* mismo índice */
    zc_index_put(ix, "a", 100, 0, ZC_POLICY_LRU, 0, cb, NULL);
    zc_index_put(ix, "b", 100, 0, ZC_POLICY_LRU, 0, cb, NULL);
    CHECK(zc_registry_domain_dir(r, &d, out, sizeof out) == 0 && !strcmp(out, "/tmp/zc_reg_test/ejemplo.com"));
    CHECK(zc_registry_save_all(r) == 0 && access("/tmp/zc_reg_test/ejemplo.com/index.zc", R_OK) == 0);
    zc_registry_free(r);

    /* Reinicio del pod: se recarga el índice; Firebase bajó el límite => se expulsa */
    r = zc_registry_new("/tmp/zc_reg_test");
    d.max_cache_bytes = 150; nev = 0;
    ix = zc_registry_get(r, &d, cb, NULL);
    CHECK(ix && zc_index_count(ix) == 1 && nev == 1 && zc_index_bytes(ix) == 100);
    zc_registry_free(r);

    /* Sin directorio: funciona en memoria */
    r = zc_registry_new(NULL);
    CHECK(zc_registry_get(r, &d, cb, NULL) != NULL && zc_registry_save_all(r) == 0);
    CHECK(zc_registry_domain_dir(r, &d, out, sizeof out) == -1);
    zc_domain_t bad = { .domain = "../x", .max_cache_bytes = 1 };
    CHECK(zc_registry_get(r, &bad, cb, NULL) == NULL);
    zc_registry_free(r);
    if (system("rm -rf /tmp/zc_reg_test")) {}
    DONE();
}
