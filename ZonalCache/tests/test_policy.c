#include "check.h"
#include "zc_policy.h"
#include <string.h>
#include <unistd.h>

static char evicted[64][ZC_KEY_MAX]; static int nev;
static void cb(const char *k, void *ud) { (void)ud; snprintf(evicted[nev++], ZC_KEY_MAX, "%s", k); }

/* Capacidad 300; a,b,c de 100 bytes; luego se accede en un orden definido y se inserta d. */
static void scenario(zc_policy_t pol, const char *expected) {
    zc_index_t ix; zc_index_init(&ix, 300); nev = 0; time_t now = 1000;
    zc_index_put(&ix, "a", 100, 0, pol, now, cb, NULL);
    zc_index_put(&ix, "b", 100, 0, pol, now, cb, NULL);
    zc_index_put(&ix, "c", 100, 0, pol, now, cb, NULL);
    zc_index_lookup(&ix, "a", now, cb, NULL);  /* a: 1 hit */
    zc_index_lookup(&ix, "a", now, cb, NULL);  /* a: 2 hits */
    zc_index_lookup(&ix, "c", now, cb, NULL);  /* c: 1 hit, más reciente */
    zc_index_lookup(&ix, "b", now, cb, NULL);  /* b: 1 hit, MÁS reciente de todas */
    /* orden de uso (viejo->nuevo): a, c, b | hits: a=2 b=1 c=1 | inserción: a,b,c */
    CHECK(zc_index_put(&ix, "d", 100, 0, pol, now, cb, NULL) == 0);
    CHECK(nev == 1);
    CHECK(strcmp(evicted[0], expected) == 0);
    CHECK(zc_index_bytes(&ix) == 300 && zc_index_count(&ix) == 3);
    zc_index_free(&ix);
}

int main(void) {
    printf("test_policy\n");
    scenario(ZC_POLICY_LRU,  "a");   /* a se usó hace más tiempo (aunque tiene más hits) */
    scenario(ZC_POLICY_MRU,  "b");   /* b es la más recientemente usada */
    scenario(ZC_POLICY_FIFO, "a");   /* a entró primero */
    scenario(ZC_POLICY_LFU,  "c");   /* b y c empatan en 1 hit: sale la menos reciente (c) */

    /* RANDOM: siempre expulsa algo existente y respeta el límite */
    { zc_index_t ix; zc_index_init(&ix, 300); nev = 0;
      for (int i = 0; i < 50; i++) { char k[16]; snprintf(k, sizeof k, "k%d", i);
          CHECK(zc_index_put(&ix, k, 100, 0, ZC_POLICY_RANDOM, 1000, cb, NULL) == 0);
          CHECK(zc_index_bytes(&ix) <= 300); }
      CHECK(zc_index_count(&ix) == 3 && nev == 47); zc_index_free(&ix); }

    /* Expiración: las expiradas salen primero, sin importar la política */
    { zc_index_t ix; zc_index_init(&ix, 200); nev = 0;
      zc_index_put(&ix, "old", 100, 10, ZC_POLICY_MRU, 1000, cb, NULL);   /* expira en 1010 */
      zc_index_put(&ix, "new", 100, 0,  ZC_POLICY_MRU, 1005, cb, NULL);
      CHECK(zc_index_put(&ix, "x", 100, 0, ZC_POLICY_MRU, 1020, cb, NULL) == 0);
      CHECK(nev == 1 && strcmp(evicted[0], "old") == 0);
      zc_index_free(&ix); }

    /* lookup de expirada = -1 y se elimina; miss = 0; hit = 1 */
    { zc_index_t ix; zc_index_init(&ix, 100); nev = 0;
      zc_index_put(&ix, "t", 10, 5, ZC_POLICY_LRU, 100, cb, NULL);
      CHECK(zc_index_lookup(&ix, "t", 103, cb, NULL) == 1);
      CHECK(zc_index_lookup(&ix, "t", 106, cb, NULL) == -1 && nev == 1);
      CHECK(zc_index_lookup(&ix, "t", 106, cb, NULL) == 0);
      zc_index_free(&ix); }

    /* Límites y validación de claves */
    { zc_index_t ix; zc_index_init(&ix, 100);
      CHECK(zc_index_put(&ix, "big", 101, 0, ZC_POLICY_LRU, 0, NULL, NULL) == -1);
      CHECK(zc_index_put(&ix, "../etc/passwd", 1, 0, ZC_POLICY_LRU, 0, NULL, NULL) == -1);
      CHECK(zc_index_put(&ix, "", 1, 0, ZC_POLICY_LRU, 0, NULL, NULL) == -1);
      CHECK(zc_index_put(&ix, "ok-1.bin", 50, 0, ZC_POLICY_LRU, 0, NULL, NULL) == 0);
      CHECK(zc_index_put(&ix, "ok-1.bin", 60, 0, ZC_POLICY_LRU, 0, NULL, NULL) == 0); /* reemplazo */
      CHECK(zc_index_bytes(&ix) == 60 && zc_index_count(&ix) == 1);
      CHECK(zc_index_remove(&ix, "ok-1.bin") == 1 && zc_index_bytes(&ix) == 0);
      zc_index_free(&ix); }

    /* Si Firebase reduce el límite se expulsa hasta cumplirlo */
    { zc_index_t ix; zc_index_init(&ix, 300); nev = 0;
      zc_index_put(&ix, "a", 100, 0, ZC_POLICY_FIFO, 0, cb, NULL);
      zc_index_put(&ix, "b", 100, 0, ZC_POLICY_FIFO, 0, cb, NULL);
      zc_index_put(&ix, "c", 100, 0, ZC_POLICY_FIFO, 0, cb, NULL);
      zc_index_set_max(&ix, 150, ZC_POLICY_FIFO, cb, NULL);
      CHECK(nev == 2 && strcmp(evicted[0], "a") == 0 && strcmp(evicted[1], "b") == 0 && zc_index_bytes(&ix) == 100);
      zc_index_free(&ix); }

    /* Persistencia de metadatos: tras recargar, LRU sigue eligiendo la misma víctima */
    { zc_index_t ix, iy; zc_index_init(&ix, 300); zc_index_init(&iy, 300); nev = 0;
      zc_index_put(&ix, "a", 100, 0, ZC_POLICY_LRU, 0, NULL, NULL);
      zc_index_put(&ix, "b", 100, 0, ZC_POLICY_LRU, 0, NULL, NULL);
      zc_index_put(&ix, "c", 100, 0, ZC_POLICY_LRU, 0, NULL, NULL);
      zc_index_lookup(&ix, "a", 0, NULL, NULL);
      CHECK(zc_index_save(&ix, "/tmp/zc_idx_test") == 0);
      CHECK(zc_index_load(&iy, "/tmp/zc_idx_test") == 0 && zc_index_count(&iy) == 3 && zc_index_bytes(&iy) == 300);
      zc_index_put(&iy, "d", 100, 0, ZC_POLICY_LRU, 0, cb, NULL);
      CHECK(nev == 1 && strcmp(evicted[0], "b") == 0);   /* a se usó después, b es la LRU */
      CHECK(zc_index_load(&iy, "/tmp/no_existe_zc") == -1);
      unlink("/tmp/zc_idx_test"); zc_index_free(&ix); zc_index_free(&iy); }

    { zc_policy_t p; CHECK(zc_policy_parse("lru", &p) == 0 && p == ZC_POLICY_LRU);
      CHECK(zc_policy_parse("Random", &p) == 0 && p == ZC_POLICY_RANDOM);
      CHECK(zc_policy_parse("ARC", &p) == -1 && zc_policy_parse(NULL, &p) == -1); }
    DONE();
}
