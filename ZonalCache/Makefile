# Zonal Cache — módulos de la Persona 3 (políticas, config, auth, TLS, registro, gate), servidor demo y pruebas.
# Dependencias (Debian/Ubuntu): build-essential libcurl4-openssl-dev libssl-dev openssl curl nodejs
#   make        -> libzc_p3.a + tools/zc_p3_demo
#   make test   -> pruebas unitarias
#   make e2e    -> pruebas de punta a punta con curl (demo + mock del API Node.js)
CC      ?= gcc
CFLAGS  ?= -std=gnu11 -O2 -g -Wall -Wextra -Wpedantic -Wno-unused-parameter
LDLIBS  := -lcurl -lssl -lcrypto -lpthread
SRC     := p3/zc_policy.c p3/zc_config.c p3/zc_auth.c p3/zc_tls.c p3/zc_registry.c p3/zc_gate.c
OBJ     := $(SRC:.c=.o)

all: libzc_p3.a tools/zc_p3_demo

libzc_p3.a: $(OBJ)
	ar rcs $@ $^

%.o: %.c $(wildcard p3/*.h)
	$(CC) $(CFLAGS) -Ip3 -c $< -o $@

tests/test_%: tests/test_%.c libzc_p3.a
	$(CC) $(CFLAGS) -Ip3 $< libzc_p3.a $(LDLIBS) -o $@

tools/zc_p3_demo: tools/zc_p3_demo.c libzc_p3.a
	$(CC) $(CFLAGS) -Ip3 $< libzc_p3.a $(LDLIBS) -o $@

TESTS := tests/test_policy tests/test_config tests/test_auth tests/test_tls tests/test_runtime \
         tests/test_registry tests/test_gate

test: $(TESTS)
	@for t in $(TESTS); do echo "== $$t"; ./$$t || exit 1; done; echo "TODAS LAS PRUEBAS OK"

e2e: tools/zc_p3_demo
	bash tests/e2e.sh

e2e-api: tools/zc_p3_demo
	bash tests/e2e-api-real.sh

clean:
	rm -f $(OBJ) libzc_p3.a tools/zc_p3_demo $(TESTS)
.PHONY: all test e2e e2e-api clean
