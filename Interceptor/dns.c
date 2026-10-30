#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <time.h>
#include <ctype.h>
#include <errno.h>
#include <unistd.h>
#include <pthread.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <curl/curl.h>
#include <ctype.h>
// Compilar: gcc dns.c -o dns -lcurl -lpthread -Wall OJO ESTO ES para linux, no me moleste en windows pq no uso windows y esto va a correr en docker asi que XD
// Para el .env DNS_API_URL  base del API eso se da en el .env para mejor orden
// se corre con sudo o sin sudo pero se especifica el puerto por como es el 53




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

static void load_dotenv(const char *filename) {
    FILE *f = fopen(filename, "r");
    if (!f) return; // Si no hay .env, no hace nada (usa las vars del sistema)

    char line[512];
    while (fgets(line, sizeof(line), f)) {
        // Ignorar comentarios y líneas vacías
        char *p = line;
        while (*p && isspace((unsigned char)*p)) p++;
        if (*p == '#' || *p == '\0' || *p == '\n') continue;

        // Buscar el '='
        char *eq = strchr(p, '=');
        if (!eq) continue;

        *eq = '\0'; 
        char *key = p;
        char *val = eq + 1;

        // Limpiar espacios y saltos de línea del valor
        char *end = val + strlen(val) - 1;
        while (end > val && isspace((unsigned char)*end)) *(end--) = '\0';

        // Si el valor tiene comillas, se las saca
        if (*val == '"') {
            val++;
            char *last_quote = strrchr(val, '"');
            if (last_quote) *last_quote = '\0';
        } else if (*val == '\'') {
            val++;
            char *last_quote = strrchr(val, '\'');
            if (last_quote) *last_quote = '\0';
        }

        // el .env tiene prioridad, eso es el 1, si no se pone 0
        setenv(key, val, 1); 
    }
    fclose(f);
}




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

/* ==================== Base64 ==================== */

static const char B64_ALPHA[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static char *b64_encode(const uint8_t *src, size_t n) {
    size_t out_len = 4 * ((n + 2) / 3);
    char *out = malloc(out_len + 1);
    if (!out) return NULL;
    //Se redondea hacia arriba para que siempre sea multiplo de 4, y se agrega 1 para el null terminator

    size_t j = 0;
    for (size_t i = 0; i < n; i += 3) {
        uint32_t a = src[i];
        uint32_t b = (i + 1 < n) ? src[i + 1] : 0;
        uint32_t c = (i + 2 < n) ? src[i + 2] : 0;
        uint32_t t = (a << 16) | (b << 8) | c;
        out[j++] = B64_ALPHA[(t >> 18) & 0x3F];
        out[j++] = B64_ALPHA[(t >> 12) & 0x3F];
        out[j++] = B64_ALPHA[(t >>  6) & 0x3F];
        out[j++] = B64_ALPHA[ t        & 0x3F];
    }
    if (n % 3 == 1) { out[out_len-1] = '='; out[out_len-2] = '='; }
    else if (n % 3 == 2) { out[out_len-1] = '='; }
    out[out_len] = '\0';
    return out;
}

static int b64_value(char c) {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
}

static uint8_t *b64_decode(const char *src, size_t *out_len) {
    size_t n = strlen(src);
    if (n % 4 != 0) return NULL;

    uint8_t *out = malloc((n / 4) * 3 + 1);
    if (!out) return NULL;

    size_t j = 0;
    for (size_t i = 0; i < n; i += 4) {
        int v0 = b64_value(src[i]);
        int v1 = b64_value(src[i+1]);
        int v2 = (src[i+2] == '=') ? -2 : b64_value(src[i+2]);
        int v3 = (src[i+3] == '=') ? -2 : b64_value(src[i+3]);
        if (v0 < 0 || v1 < 0 || v2 == -1 || v3 == -1) { free(out); return NULL; }

        uint32_t t = ((uint32_t)v0 << 18) | ((uint32_t)v1 << 12) |
                     ((uint32_t)(v2 < 0 ? 0 : v2) << 6) |
                     (uint32_t)(v3 < 0 ? 0 : v3);

        out[j++] = (t >> 16) & 0xFF;
        if (v2 >= 0) out[j++] = (t >> 8) & 0xFF;
        if (v3 >= 0) out[j++] = t & 0xFF;
    }
    *out_len = j;
    return out;
}

/* ==================== DNS parse / build ==================== */

typedef struct {
    uint16_t id;
    int      is_query;
    int      is_standard;
    int      is_a_query;
    char     qname[256];
} dns_query_t;

static int dns_parse(const uint8_t *buf, size_t len, dns_query_t *out) {
    if (len < 12) return -1;
    memset(out, 0, sizeof(*out));

    out->id          = ((uint16_t)buf[0] << 8) | buf[1];
    out->is_query    = (buf[2] & 0x80) == 0;
    out->is_standard = ((buf[2] >> 3) & 0x0F) == 0;

    if ((((uint16_t)buf[4] << 8) | buf[5]) == 0) return 0;

    size_t pos = 12;
    char *p = out->qname;
    size_t remaining = sizeof(out->qname) - 1;

    while (pos < len && buf[pos] != 0) {
        size_t lab = buf[pos++];
        if (pos + lab > len || lab > remaining) return -1;
        for (size_t i = 0; i < lab; i++)
            *p++ = (char)tolower((unsigned char)buf[pos + i]);
        pos += lab;
        remaining -= lab;
        if (remaining > 0) { *p++ = '.'; remaining--; }
    }
    if (pos >= len) return -1;
    pos++;

    if (p > out->qname && *(p - 1) == '.') p--;
    *p = '\0';

    if (pos + 2 > len) return -1;
    out->is_a_query = ((((uint16_t)buf[pos] << 8) | buf[pos + 1]) == 1);
    return 0;
}

/* Puntero al fin de la sección de question de una query. 0 si malformada. */
static size_t question_end(const uint8_t *q, size_t qlen) {
    if (qlen < 12) return 0;
    size_t pos = 12;
    while (pos < qlen && q[pos] != 0) {
        size_t lab = q[pos];
        pos += 1 + lab;
        if (pos >= qlen) return 0;
    }
    if (pos >= qlen) return 0;
    size_t qe = pos + 1 + 4;
    return (qe <= qlen) ? qe : 0;
}

/* Construye una respuesta DNS.
 * rcode = 0 (NoError) → incluye un answer A con answer_ip.
 * rcode != 0          → sin answer, solo el error (ej. SERVFAIL=2). */
static uint8_t *dns_build_response(const uint8_t *q, size_t qlen,
                                   uint32_t answer_ip, uint32_t ttl,
                                   int rcode, size_t *out_len) {
    size_t qe = question_end(q, qlen);
    if (qe == 0) return NULL;

    size_t qsize = qe - 12;
    int has_answer = (rcode == 0);

    size_t rlen = 12 + qsize + (has_answer ? 16 : 0);
    uint8_t *r = malloc(rlen);
    if (!r) return NULL;

    r[0] = q[0]; r[1] = q[1];                        /* ID */
    r[2] = 0x80 | (q[2] & 0x01);                     /* QR=1, RD copiado */
    r[3] = 0x80 | (rcode & 0x0F);                    /* RA=1, RCODE */

    /* Counts */
    r[4] = 0; r[5] = 1;                              /* QDCOUNT */
    r[6] = 0; r[7] = has_answer ? 1 : 0;             /* ANCOUNT */
    r[8] = 0; r[9] = 0;                              /* NSCOUNT */
    r[10] = 0; r[11] = 0;                            /* ARCOUNT */

    memcpy(r + 12, q + 12, qsize);                   /* question */

    if (has_answer) {
        size_t j = 12 + qsize;
        r[j++] = 0xC0; r[j++] = 0x0C;                /* NAME: ptr a 12 */
        r[j++] = 0x00; r[j++] = 0x01;                /* TYPE: A */
        r[j++] = 0x00; r[j++] = 0x01;                /* CLASS: IN */
        r[j++] = (ttl >> 24) & 0xFF;
        r[j++] = (ttl >> 16) & 0xFF;
        r[j++] = (ttl >>  8) & 0xFF;
        r[j++] =  ttl        & 0xFF;
        r[j++] = 0x00; r[j++] = 0x04;                /* RDLENGTH: 4 */
        r[j++] = (answer_ip >> 24) & 0xFF;
        r[j++] = (answer_ip >> 16) & 0xFF;
        r[j++] = (answer_ip >>  8) & 0xFF;
        r[j++] =  answer_ip        & 0xFF;
    }

    *out_len = rlen;
    return r;
}

/* ==================== HTTP (libcurl) ==================== */

typedef struct {
    char  *data;
    size_t len;
} http_buf_t;

static size_t http_write_cb(void *contents, size_t size, size_t nmemb, void *userp) {
    size_t n = size * nmemb;
    http_buf_t *b = userp;
    char *p = realloc(b->data, b->len + n + 1);
    if (!p) return 0;
    b->data = p;
    memcpy(b->data + b->len, contents, n);
    b->len += n;
    b->data[b->len] = '\0';
    return n;
}

typedef struct {
    long  status;
    char *body;
} http_resp_t;

static void http_resp_free(http_resp_t *r) {
    if (!r) return;
    free(r->body);
    free(r);
}

/* json_body != NULL → POST con ese body. json_body == NULL → GET. */
static http_resp_t *http_request(CURL *curl, const char *url, const char *json_body) {
    http_buf_t buf = { NULL, 0 };
    struct curl_slist *headers = NULL;

    curl_easy_reset(curl);
    curl_easy_setopt(curl, CURLOPT_URL, url);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, http_write_cb);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &buf);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 5L);
    curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);

    if (json_body) {
        headers = curl_slist_append(headers, "Content-Type: application/json");
        curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
        curl_easy_setopt(curl, CURLOPT_POSTFIELDS, json_body);
        curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, (long)strlen(json_body));
    }

    CURLcode res = curl_easy_perform(curl);
    if (headers) curl_slist_free_all(headers);

    if (res != CURLE_OK) { free(buf.data); return NULL; }

    long status = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &status);

    http_resp_t *r = malloc(sizeof(*r));
    r->status = status;
    r->body = buf.data ? buf.data : strdup("");
    return r;
}

static char *api_base_url(void) {
    const char *env = getenv("DNS_API_URL");
    const char *base = (env && *env) ? env : "http://localhost:8080";
    size_t len = strlen(base);
    while (len > 0 && base[len - 1] == '/') len--;
    char *out = malloc(len + 1);
    memcpy(out, base, len);
    out[len] = '\0';
    return out;
}

/* ==================== Modelo del record + estrategias ==================== */

typedef struct {
    char   *address;
    int     healthy;
    int     weight;      /* 0 = tratar como 1 */
    char   *country;     /* NULL si no aplica */
    double  latency_ms;  /* -1 si no viene */
} target_t;

typedef struct {
    char     *record_id;
    char     *type;
    uint32_t  ttl;
    char     *client_cc;
    target_t *targets;
    size_t    ntargets;
} record_info_t;

static void record_info_free(record_info_t *r) {
    if (!r) return;
    free(r->record_id);
    free(r->type);
    free(r->client_cc);
    for (size_t i = 0; i < r->ntargets; i++) {
        free(r->targets[i].address);
        free(r->targets[i].country);
    }
    free(r->targets);
    memset(r, 0, sizeof(*r));
}

static int parse_record_info(const char *json, record_info_t *out) {
    memset(out, 0, sizeof(*out));
    jval_t *root = jparse(json);
    if (!root) return -1;

    const char *rid = jstr(jget(root, "recordId"));
    const char *typ = jstr(jget(root, "type"));
    jval_t *ttl_v   = jget(root, "ttl");
    jval_t *client  = jget(root, "client");
    jval_t *targets = jget(root, "targets");

    out->record_id = rid ? strdup(rid) : NULL;
    out->type      = typ ? strdup(typ) : NULL;
    out->ttl       = ttl_v ? (uint32_t)jnum(ttl_v) : 60;

    if (client) {
        const char *cc = jstr(jget(client, "countryCode"));
        if (cc) out->client_cc = strdup(cc);
    }

    if (targets && targets->type == J_ARR) {
        out->ntargets = targets->count;
        out->targets = calloc(targets->count, sizeof(target_t));
        for (size_t i = 0; i < targets->count; i++) {
            jval_t *t = jat(targets, i);
            target_t *tt = &out->targets[i];
            tt->latency_ms = -1;

            const char *addr = jstr(jget(t, "address"));
            if (addr) tt->address = strdup(addr);

            tt->healthy = jbool(jget(t, "healthy"));

            jval_t *w = jget(t, "weight");
            if (w && w->type == J_NUM) tt->weight = (int)jnum(w);

            const char *c = jstr(jget(t, "country"));
            if (c) tt->country = strdup(c);

            jval_t *lm = jget(t, "latencyMs");
            if (lm && lm->type == J_NUM) tt->latency_ms = jnum(lm);
        }
    }

    jfree(root);
    return 0;
}

/* Contador de round-robin por record_id */
typedef struct rr_entry {
    char *record_id;
    size_t counter;
    struct rr_entry *next;
} rr_entry_t;

typedef struct {
    rr_entry_t *head;
    pthread_mutex_t lock;
} rr_map_t;

static rr_map_t *rr_new(void) {
    rr_map_t *m = calloc(1, sizeof(*m));
    pthread_mutex_init(&m->lock, NULL);
    return m;
}

static void rr_free(rr_map_t *m) {
    if (!m) return;
    pthread_mutex_lock(&m->lock);
    rr_entry_t *e = m->head;
    while (e) {
        rr_entry_t *n = e->next;
        free(e->record_id);
        free(e);
        e = n;
    }
    pthread_mutex_unlock(&m->lock);
    pthread_mutex_destroy(&m->lock);
    free(m);
}

static size_t rr_next(rr_map_t *m, const char *rid, size_t n) {
    pthread_mutex_lock(&m->lock);

    rr_entry_t *e = m->head;
    while (e && strcmp(e->record_id, rid) != 0) e = e->next;

    if (!e) {
        e = calloc(1, sizeof(*e));
        e->record_id = strdup(rid);
        e->next = m->head;
        m->head = e;
    }

    size_t idx = e->counter % n;
    e->counter++;
    pthread_mutex_unlock(&m->lock);
    return idx;
}

/* Devuelve IP (malloc'd) o NULL si no hay healthy.
 * Escribe el TTL en *out_ttl. */
static char *choose_ip(const record_info_t *info, rr_map_t *rr, uint32_t *out_ttl) {
    /* Filtrar healthy */
    const target_t **h = malloc(info->ntargets * sizeof(*h) + 1);
    size_t n = 0;
    for (size_t i = 0; i < info->ntargets; i++)
        if (info->targets[i].healthy) h[n++] = &info->targets[i];

    if (n == 0) { free(h); return NULL; }

    const char *type = info->type ? info->type : "single";
    const char *rid  = info->record_id ? info->record_id : "";
    uint32_t ttl = info->ttl ? info->ttl : 60;
    char *result = NULL;

    if (strcmp(type, "single") == 0) {
        result = strdup(h[0]->address);

    } else if (strcmp(type, "multi") == 0) {
        size_t idx = rr_next(rr, rid, n);
        result = strdup(h[idx]->address);

    } else if (strcmp(type, "weight") == 0) {
        int total = 0;
        for (size_t i = 0; i < n; i++)
            total += (h[i]->weight > 0) ? h[i]->weight : 1;
        if (total <= 0) total = 1;

        int r = rand() % total;
        for (size_t i = 0; i < n; i++) {
            int w = (h[i]->weight > 0) ? h[i]->weight : 1;
            if (r < w) { result = strdup(h[i]->address); break; }
            r -= w;
        }
        if (!result) result = strdup(h[0]->address);

    } else if (strcmp(type, "geo") == 0) {
        const char *cc = info->client_cc;
        if (cc) {
            for (size_t i = 0; i < n; i++) {
                if (h[i]->country && strcmp(h[i]->country, cc) == 0) {
                    result = strdup(h[i]->address);
                    break;
                }
            }
        }
        if (!result) {
            size_t idx = rand() % n;
            result = strdup(h[idx]->address);
        }

    } else if (strcmp(type, "round-trip") == 0) {
        double best = 1e308;
        for (size_t i = 0; i < n; i++) {
            if (h[i]->latency_ms >= 0 && h[i]->latency_ms < best) {
                best = h[i]->latency_ms;
                free(result);
                result = strdup(h[i]->address);
            }
        }
        if (!result) result = strdup(h[0]->address);

    } else {
        result = strdup(h[0]->address);
    }

    free(h);
    *out_ttl = ttl;
    return result;
}

/* ==================== Fallback: /api/dns_resolver ==================== */

static uint8_t *forward_to_resolver(CURL *curl,
                                    const uint8_t *query, size_t qlen,
                                    size_t *out_len) {
    char *b64 = b64_encode(query, qlen);
    if (!b64) return NULL;

    size_t body_len = strlen(b64) + 32;
    char *body = malloc(body_len);
    snprintf(body, body_len, "{\"data\":\"%s\"}", b64);
    free(b64);

    char *base = api_base_url();
    size_t url_len = strlen(base) + 32;
    char *url = malloc(url_len);
    snprintf(url, url_len, "%s/api/dns_resolver", base);
    free(base);

    http_resp_t *resp = http_request(curl, url, body);
    free(url);
    free(body);
    if (!resp) return NULL;

    if (resp->status < 200 || resp->status >= 300) {
        fprintf(stderr, "resolver HTTP %ld\n", resp->status);
        http_resp_free(resp);
        return NULL;
    }

    jval_t *json = jparse(resp->body);
    if (!json) { http_resp_free(resp); return NULL; }

    const char *data = jstr(jget(json, "data"));
    uint8_t *decoded = NULL;
    if (data) decoded = b64_decode(data, out_len);

    jfree(json);
    http_resp_free(resp);
    return decoded;
}

/* ==================== Handler de una query ==================== */

typedef struct {
    int sock;
    struct sockaddr_in src;
    uint8_t *query;
    size_t qlen;
    rr_map_t *rr;
} thread_ctx_t;

static void handle_query(thread_ctx_t *ctx, CURL *curl) {
    dns_query_t q;
    int parsed_ok = (dns_parse(ctx->query, ctx->qlen, &q) == 0);

    /* Paquete no parseable → reenviar al resolver */
    if (!parsed_ok) {
        printf("Resolver: paquete no reconocido, se reenvía\n");
        size_t rlen;
        uint8_t *r = forward_to_resolver(curl, ctx->query, ctx->qlen, &rlen);
        if (r) {
            sendto(ctx->sock, r, rlen, 0,
                   (struct sockaddr *)&ctx->src, sizeof(ctx->src));
            free(r);
        }
        return;
    }

    if (!q.is_query) return;   /* QR=1: es respuesta, no nos toca */

    uint8_t *direct = NULL;
    size_t direct_len = 0;

    if (q.is_standard && q.is_a_query) {
        char *base = api_base_url();
        char ip_str[64];
        inet_ntop(AF_INET, &ctx->src.sin_addr, ip_str, sizeof(ip_str));

        size_t url_len = strlen(base) + strlen(q.qname) + strlen(ip_str) + 32;
        char *url = malloc(url_len);
        snprintf(url, url_len, "%s/api/records/%s?sourceIp=%s", base, q.qname, ip_str);
        free(base);

        http_resp_t *resp = http_request(curl, url, NULL);
        free(url);

        if (!resp) {
            fprintf(stderr, "HTTP falló para %s\n", q.qname);
        } else if (resp->status == 200) {
            record_info_t info;
            if (parse_record_info(resp->body, &info) == 0) {
                uint32_t ttl = 60;
                char *ip = choose_ip(&info, ctx->rr, &ttl);
                if (ip) {
                    struct in_addr addr;
                    if (inet_pton(AF_INET, ip, &addr) == 1) {
                        printf("A: %s -> %s (ttl %u) tipo %s\n",
                               q.qname, ip, ttl, info.type ? info.type : "?");
                        direct = dns_build_response(ctx->query, ctx->qlen,
                                                    (uint32_t)addr.s_addr, ttl,
                                                    0, &direct_len);
                    }
                    free(ip);
                } else {
                    printf("A: %s sin healthy, fallback\n", q.qname);
                }
                record_info_free(&info);
            } else {
                fprintf(stderr, "Parse RecordInfo falló\n");
            }
        } else if (resp->status == 404) {
            printf("A: %s 404, fallback\n", q.qname);
        } else {
            fprintf(stderr, "API %s: HTTP %ld\n", q.qname, resp->status);
        }
        if (resp) http_resp_free(resp);
    } else {
        printf("Resolver: %s\n", q.qname[0] ? q.qname : "<sin pregunta>");
    }

    /* Envío: respuesta directa si existe, si no fallback al resolver */
    if (direct) {
        sendto(ctx->sock, direct, direct_len, 0,
               (struct sockaddr *)&ctx->src, sizeof(ctx->src));
        free(direct);
        return;
    }

    size_t rlen;
    uint8_t *r = forward_to_resolver(curl, ctx->query, ctx->qlen, &rlen);
    if (r) {
        sendto(ctx->sock, r, rlen, 0,
               (struct sockaddr *)&ctx->src, sizeof(ctx->src));
        free(r);
        return;
    }

    /* Fallback también falló → SERVFAIL, para no dejar al cliente colgado */
    uint8_t *err = dns_build_response(ctx->query, ctx->qlen, 0, 0, 2, &rlen);
    if (err) {
        sendto(ctx->sock, err, rlen, 0,
               (struct sockaddr *)&ctx->src, sizeof(ctx->src));
        free(err);
    }
    fprintf(stderr, "resolver falló, enviado SERVFAIL\n");
}

static void *thread_main(void *arg) {
    thread_ctx_t *ctx = arg;

    CURL *curl = curl_easy_init();
    if (curl) {
        handle_query(ctx, curl);
        curl_easy_cleanup(curl);
    }

    free(ctx->query);
    free(ctx);
    return NULL;
}



int main(int argc, char **argv) {
    load_dotenv(".env");
    uint16_t port = 53;

    for (int i = 1; i < argc; i++) {
        if ((strcmp(argv[i], "--port") == 0 || strcmp(argv[i], "-p") == 0)
            && i + 1 < argc)
            port = (uint16_t)atoi(argv[++i]);
    }

    int sock = socket(AF_INET, SOCK_DGRAM, 0);
    if (sock < 0) { perror("socket"); return 1; }

    int one = 1;
    setsockopt(sock, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));

    struct sockaddr_in addr = {
        .sin_family = AF_INET,
        .sin_addr.s_addr = INADDR_ANY,
        .sin_port = htons(port),
    };

    if (bind(sock, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
        perror("bind");
        fprintf(stderr, "Puerto <1024 requiere root o CAP_NET_BIND_SERVICE\n");
        return 1;
    }

    printf("DNS Interceptor escuchando en UDP 0.0.0.0:%u\n", port);

    srand((unsigned)time(NULL));
    curl_global_init(CURL_GLOBAL_DEFAULT);

    rr_map_t *rr = rr_new();

    uint8_t buf[4096];
    while (1) {
        struct sockaddr_in src;
        socklen_t src_len = sizeof(src);

        int n = recvfrom(sock, buf, sizeof(buf), 0,
                         (struct sockaddr *)&src, &src_len);
        if (n < 0) { perror("recvfrom"); continue; }

        thread_ctx_t *ctx = malloc(sizeof(*ctx));
        ctx->sock  = sock;
        ctx->src   = src;
        ctx->query = malloc((size_t)n);
        memcpy(ctx->query, buf, (size_t)n);
        ctx->qlen  = (size_t)n;
        ctx->rr    = rr;

        pthread_t t;
        if (pthread_create(&t, NULL, thread_main, ctx) != 0) {
            free(ctx->query);
            free(ctx);
            continue;
        }
        pthread_detach(t);
    }

    /* inalcanzable */
    curl_global_cleanup();
    rr_free(rr);
    return 0;
}