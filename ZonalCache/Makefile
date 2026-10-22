# Módulos de la Persona 3 (políticas, config, auth, TLS) y sus pruebas.
# Dependencias (Debian/Ubuntu): build-essential libcurl4-openssl-dev libssl-dev
CC      ?= gcc
CFLAGS  ?= -std=gnu11 -O2 -g -Wall -Wextra -Wpedantic -Wno-unused-parameter
LDLIBS  := -lcurl -lssl -lcrypto -lpthread
SRC     := p3/zc_policy.c p3/zc_config.c p3/zc_auth.c p3/zc_tls.c
OBJ     := $(SRC:.c=.o)

all: libzc_p3.a

libzc_p3.a: $(OBJ)
	ar rcs $@ $^

%.o: %.c
	$(CC) $(CFLAGS) -Ip3 -c $< -o $@

tests/%: tests/%.c libzc_p3.a
	$(CC) $(CFLAGS) -Ip3 $< libzc_p3.a $(LDLIBS) -o $@

TESTS := tests/test_policy tests/test_config tests/test_auth tests/test_tls tests/test_runtime
test: $(TESTS)
	@for t in $(TESTS); do echo "== $$t"; ./$$t || exit 1; done; echo "TODAS LAS PRUEBAS OK"

clean:
	rm -f $(OBJ) libzc_p3.a $(TESTS)
.PHONY: all test clean
