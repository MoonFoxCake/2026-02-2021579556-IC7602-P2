/* json_lite.h — parser JSON mínimo, extraído del DNS Interceptor del equipo
 * (Interceptor/dns.c) para reutilizarlo en la Zonal Cache. Header-only. */
#ifndef ZC_JSON_LITE_H
#define ZC_JSON_LITE_H
#include <stdlib.h>
#include <string.h>
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wunused-function"
enum { J_NULL, J_BOOL, J_NUM, J_STR, J_ARR, J_OBJ };

typedef struct jval {
    int      type;
    int      b;
    double   n;
    char    *s;
    struct jval **items;
    char   **keys;
    size_t   count;
} jval_t;
//Parser del json, cualquier valor

static void jfree(jval_t *j) {
    if (!j) return;
    free(j->s);
    for (size_t i = 0; i < j->count; i++) {
        jfree(j->items[i]);
        if (j->keys) free(j->keys[i]);
    }
    free(j->items);
    free(j->keys);
    free(j);
}
//Libera memoria

static const char *jskip(const char *p) {
    while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r') p++;
    return p;
}
//Se salta si es vacio

static char *jparse_string(const char **pp) {
    const char *p = *pp;
    if (*p != '"') return NULL;
    //La idea es que lea " en esta funcion
    p++;
    size_t cap = 32, len = 0;
    char *out = malloc(cap);
    if (!out) return NULL;

    while (*p && *p != '"') {
        char c = *p++;
        if (c == '\\' && *p) {
            //Esto es por si hay un escape, por ejemplo \n, \t, \\, etc
            char e = *p++;
            switch (e) {
                case 'n':  c = '\n'; break;
                case 't':  c = '\t'; break;
                case 'r':  c = '\r'; break;
                case '"':  c = '"';  break;
                case '\\': c = '\\'; break;
                case '/':  c = '/';  break;
                case 'b':  c = '\b'; break;
                case 'f':  c = '\f'; break;
                case 'u':  for (int i = 0; i < 4 && *p; i++) p++; c = '?'; break;
                //Si es \u esto se salta, no se implementa el unicode
                default:   c = e; break;
            }
        }
        if (len + 1 >= cap) { cap *= 2; out = realloc(out, cap); }
        out[len++] = c;
    }
    if (*p != '"') { free(out); return NULL; } //Si no hay comilla de cierre se da null
    p++;
    out[len] = '\0';
    *pp = p;
    return out;
}

static jval_t *jparse_value(const char **pp); //Vacio pq como lo ocupan los otros y este los necesita es un workaround

static jval_t *jparse_array(const char **pp) {
    const char *p = *pp;
    if (*p != '[') return NULL;
    p = jskip(p + 1);

    jval_t *n = calloc(1, sizeof(*n));
    n->type = J_ARR;
    size_t cap = 4;
    n->items = malloc(cap * sizeof(*n->items));

    if (*p == ']') { *pp = p + 1; return n; }

    while (1) {
        p = jskip(p);
        jval_t *v = jparse_value(&p);
        if (!v) { jfree(n); return NULL; }

        if (n->count == cap) {
            cap *= 2;
            n->items = realloc(n->items, cap * sizeof(*n->items));
        }
        n->items[n->count++] = v;

        p = jskip(p);
        if (*p == ',') { p = jskip(p + 1); continue; }
        if (*p == ']') { *pp = p + 1; return n; }
        jfree(n); return NULL;
    }
}

static jval_t *jparse_object(const char **pp) {
    const char *p = *pp;
    if (*p != '{') return NULL;
    p = jskip(p + 1);

    jval_t *n = calloc(1, sizeof(*n));
    n->type = J_OBJ;
    size_t cap = 4;
    n->items = malloc(cap * sizeof(*n->items));
    n->keys  = malloc(cap * sizeof(*n->keys));

    if (*p == '}') { *pp = p + 1; return n; }

    while (1) {
        p = jskip(p);
        char *key = jparse_string(&p);
        if (!key) { jfree(n); return NULL; }

        p = jskip(p);
        if (*p != ':') { free(key); jfree(n); return NULL; }
        p = jskip(p + 1);

        jval_t *v = jparse_value(&p);
        if (!v) { free(key); jfree(n); return NULL; }

        if (n->count == cap) {
            cap *= 2;
            n->items = realloc(n->items, cap * sizeof(*n->items));
            n->keys  = realloc(n->keys,  cap * sizeof(*n->keys));
        }
        n->keys[n->count]  = key;
        n->items[n->count] = v;
        n->count++;

        p = jskip(p);
        if (*p == ',') { p = jskip(p + 1); continue; }
        if (*p == '}') { *pp = p + 1; return n; }
        jfree(n); return NULL;
    }
}

static jval_t *jparse_value(const char **pp) {
    const char *p = jskip(*pp);
    jval_t *n;

    if (*p == '{') { n = jparse_object(&p); *pp = p; return n; }
    if (*p == '[') { n = jparse_array(&p);  *pp = p; return n; }

    if (*p == '"') {
        char *s = jparse_string(&p);
        if (!s) return NULL;
        n = calloc(1, sizeof(*n));
        n->type = J_STR;
        n->s = s;
        *pp = p;
        return n;
    }

    if (strncmp(p, "true",  4) == 0) { n = calloc(1, sizeof(*n)); n->type = J_BOOL; n->b = 1; *pp = p + 4; return n; }
    if (strncmp(p, "false", 5) == 0) { n = calloc(1, sizeof(*n)); n->type = J_BOOL; n->b = 0; *pp = p + 5; return n; }
    if (strncmp(p, "null",  4) == 0) { n = calloc(1, sizeof(*n)); n->type = J_NULL;             *pp = p + 4; return n; }

    if (*p == '-' || (*p >= '0' && *p <= '9')) {
        char *end;
        double v = strtod(p, &end);
        n = calloc(1, sizeof(*n));
        n->type = J_NUM;
        n->n = v;
        *pp = end;
        return n;
    }
    return NULL;
}

static jval_t *jparse(const char *s) {
    const char *p = s;
    return jparse_value(&p);
}

//Para ya buscar en el json parseado, si no hay nada NULL

static jval_t *jget(jval_t *obj, const char *key) {
    if (!obj || obj->type != J_OBJ) return NULL;
    for (size_t i = 0; i < obj->count; i++)
        if (strcmp(obj->keys[i], key) == 0) return obj->items[i];
    return NULL;
}

static jval_t *jat(jval_t *arr, size_t i) {
    if (!arr || arr->type != J_ARR || i >= arr->count) return NULL;
    return arr->items[i];
}

static const char *jstr(jval_t *j)  { return (j && j->type == J_STR)  ? j->s : NULL; }
static double      jnum(jval_t *j)  { return (j && j->type == J_NUM)  ? j->n : 0.0;  }
static int         jbool(jval_t *j) { return (j && j->type == J_BOOL) ? j->b : 0;    }
#pragma GCC diagnostic pop
#endif
