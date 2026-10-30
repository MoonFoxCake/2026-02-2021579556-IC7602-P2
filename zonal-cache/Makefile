CC = gcc
CPPFLAGS += -D_DEFAULT_SOURCE -D_POSIX_C_SOURCE=200809L -Iinclude $(shell pkg-config --cflags gnutls)
CFLAGS ?= -O2 -g
CFLAGS += -std=c11 -Wall -Wextra -Wpedantic -Wconversion -Wshadow
LDLIBS += $(shell pkg-config --libs gnutls)

.PHONY: all test clean
all: zonal-cache

zonal-cache: src/main.c src/proxy.c include/proxy.h
	$(CC) $(CPPFLAGS) $(CFLAGS) $(LDFLAGS) src/main.c src/proxy.c $(LDLIBS) -o $@

test: zonal-cache
	sh tests/proxy.sh

clean:
	$(RM) zonal-cache
