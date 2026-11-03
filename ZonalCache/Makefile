# Zonal Cache (IC7602 P2) — servidor real, biblioteca de la Persona 3, demo y pruebas.
# Dependencias (Debian/Ubuntu): build-essential libcurl4-openssl-dev libssl-dev openssl curl nodejs
#   make            -> zonal-cache (servidor real) + libzc_p3.a + tools/zc_p3_demo
#   make test       -> pruebas unitarias de la biblioteca (C)
#   make e2e        -> 29 pruebas: servidor real + mock del API (config/credenciales/login UI) + origen real
#   make e2e-proxy  -> 49 pruebas del proxy: orígenes HTTP/HTTPS reales, verbos, políticas en disco, TTL, errores
#   make e2e-api    -> 16 pruebas: servidor real <-> router real de api-nodejs (almacén en memoria)
#   make e2e-sistema-> 11 pruebas del sistema: dig -> DNS Interceptor (dns.c) -> API -> cachés cr/us -> origen
#   make e2e-demo   -> las 29 pruebas de e2e contra el demo de la Persona 3
#   make check      -> test + e2e + e2e-proxy + e2e-api + e2e-sistema
CC      ?= gcc
CFLAGS  ?= -std=gnu11 -O2 -g -Wall -Wextra -Wpedantic -Wno-unused-parameter
LDLIBS  := -lcurl -lssl -lcrypto -lpthread
SRC     := p3/zc_policy.c p3/zc_config.c p3/zc_auth.c p3/zc_tls.c p3/zc_registry.c p3/zc_gate.c
OBJ     := $(SRC:.c=.o)

all: zonal-cache libzc_p3.a tools/zc_p3_demo

libzc_p3.a: $(OBJ)
	ar rcs $@ $^

%.o: %.c $(wildcard p3/*.h)
	$(CC) $(CFLAGS) -Ip3 -c $< -o $@

# Servidor real de la Zonal Cache (proxy HTTP/HTTPS + caché en disco)
zonal-cache: src/zonal_cache.c libzc_p3.a
	$(CC) $(CFLAGS) -Ip3 $< libzc_p3.a $(LDLIBS) -o $@

tests/test_%: tests/test_%.c libzc_p3.a
	$(CC) $(CFLAGS) -Ip3 $< libzc_p3.a $(LDLIBS) -o $@

tools/zc_p3_demo: tools/zc_p3_demo.c libzc_p3.a
	$(CC) $(CFLAGS) -Ip3 $< libzc_p3.a $(LDLIBS) -o $@

TESTS := tests/test_policy tests/test_config tests/test_auth tests/test_tls tests/test_runtime \
         tests/test_registry tests/test_gate

test: $(TESTS)
	@for t in $(TESTS); do echo "== $$t"; ./$$t || exit 1; done; echo "TODAS LAS PRUEBAS OK"

e2e: zonal-cache
	ZC_BIN=./zonal-cache bash tests/e2e.sh

e2e-proxy: zonal-cache
	ZC_BIN=./zonal-cache bash tests/e2e-proxy.sh

e2e-api: zonal-cache
	ZC_BIN=./zonal-cache bash tests/e2e-api-real.sh

e2e-sistema: zonal-cache
	ZC_BIN=./zonal-cache bash tests/e2e-sistema.sh

e2e-demo: tools/zc_p3_demo
	ZC_BIN=./tools/zc_p3_demo bash tests/e2e.sh

check: test e2e e2e-proxy e2e-api e2e-sistema

clean:
	rm -f $(OBJ) libzc_p3.a zonal-cache tools/zc_p3_demo $(TESTS)
.PHONY: all test e2e e2e-proxy e2e-api e2e-sistema e2e-demo check clean
