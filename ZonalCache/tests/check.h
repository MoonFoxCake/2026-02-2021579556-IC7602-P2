#ifndef CHECK_H
#define CHECK_H
#include <stdio.h>
#include <stdlib.h>
static int g_fail = 0, g_ok = 0;
#define CHECK(c) do { if (c) g_ok++; else { g_fail++; fprintf(stderr, "  FALLO %s:%d: %s\n", __FILE__, __LINE__, #c); } } while (0)
#define DONE() do { printf("  %d ok, %d fallos\n", g_ok, g_fail); return g_fail ? 1 : 0; } while (0)
#endif
