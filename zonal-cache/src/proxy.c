#include "proxy.h"

#include <ctype.h>
#include <errno.h>
#include <gnutls/gnutls.h>
#include <limits.h>
#include <netdb.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

#define HEADER_BYTES 65536
#define HEADER_COUNT 128
#define ROUTE_COUNT 32

struct origin {
    char domain[256], host[256], authority[264], port[6];
    int tls;
};
struct stream {
    int fd;
    gnutls_session_t tls;
    unsigned char buffer[8192];
    size_t pos, end;
};
struct header { char *name, *value; };
struct message {
    char storage[HEADER_BYTES], *first;
    struct header fields[HEADER_COUNT];
    size_t count;
    uint64_t length;
    int has_length, chunked;
};
struct sink {
    struct stream *stream;
    unsigned char *data;
    size_t used, limit;
    int chunked;
};

static struct origin origins[ROUTE_COUNT];
static size_t origin_count, max_body;
static long timeout_ms, request_timeout_ms;
static const char *port;
static gnutls_certificate_credentials_t credentials;
static volatile sig_atomic_t client_fd = -1, response_started, origin_phase;

static int number(const char *text, uint64_t maximum, uint64_t *value)
{
    uint64_t n = 0;
    if (!*text)
        return -1;
    for (; *text; text++) {
        if (*text < '0' || *text > '9' ||
            n > (maximum - (unsigned)(*text - '0')) / 10)
            return -1;
        n = n * 10 + (unsigned)(*text - '0');
        if (n > maximum)
            return -1;
    }
    *value = n;
    return 0;
}

static int setting(const char *name, const char *fallback, uint64_t max, uint64_t *n)
{
    const char *value = getenv(name);
    if (number(value ? value : fallback, max, n) || !*n) {
        fprintf(stderr, "Invalid %s\n", name);
        return -1;
    }
    return 0;
}

static int authority(const char *text, char host[256], char service[6])
{
    const char *start = text, *end, *p = NULL;
    if (*start == '[') {
        start++;
        end = strchr(start, ']');
        if (!end || (end[1] && end[1] != ':'))
            return -1;
        if (end[1])
            p = end + 2;
    } else {
        end = strchr(start, ':');
        if (end)
            p = end + 1;
        else
            end = start + strlen(start);
    }
    size_t size = (size_t)(end - start);
    if (!size || size >= 256)
        return -1;
    for (size_t i = 0; i < size; i++)
        if (!isalnum((unsigned char)start[i]) && start[i] != '.' &&
            start[i] != '-' && !(text[0] == '[' && start[i] == ':'))
            return -1;
    memcpy(host, start, size);
    host[size] = '\0';
    if (p) {
        uint64_t n;
        if (number(p, 65535, &n) || !n || strlen(p) > 5)
            return -1;
        strcpy(service, p);
    }
    return 0;
}

int proxy_init(void)
{
    uint64_t n;
    if (setting("PORT", "8080", 65535, &n))
        return -1;
    port = getenv("PORT");
    if (!port)
        port = "8080";
    if (setting("ORIGIN_TIMEOUT_MS", "10000", INT_MAX, &n))
        return -1;
    timeout_ms = (long)n;
    if (setting("REQUEST_TIMEOUT_MS", "10000", INT_MAX, &n))
        return -1;
    request_timeout_ms = (long)n;
    if (setting("MAX_BODY_BYTES", "16777216", 1073741824, &n))
        return -1;
    max_body = (size_t)n;
    const char *config = getenv("ORIGINS");
    if (!config || !*config)
        goto bad_config;
    char *copy = strdup(config);
    if (!copy)
        return -1;
    char *next = copy, *entry;
    while ((entry = strsep(&next, ";"))) {
        if (origin_count == ROUTE_COUNT)
            goto bad_copy;
        struct origin *o = &origins[origin_count];
        char *url = strchr(entry, '=');
        char unused[6] = "";
        if (!url)
            goto bad_copy;
        *url++ = '\0';
        if (authority(entry, o->domain, unused) || *unused)
            goto bad_copy;
        if (!strncmp(url, "https://", 8)) {
            o->tls = 1;
            url += 8;
        } else if (!strncmp(url, "http://", 7)) {
            url += 7;
        } else {
            goto bad_copy;
        }
        size_t size = strlen(url);
        if (size && url[size - 1] == '/')
            url[--size] = '\0';
        if (size >= sizeof o->authority)
            goto bad_copy;
        strcpy(o->authority, url);
        strcpy(o->port, o->tls ? "443" : "80");
        if (authority(url, o->host, o->port))
            goto bad_copy;
        for (size_t i = 0; i < origin_count; i++)
            if (!strcasecmp(origins[i].domain, o->domain))
                goto bad_copy;
        origin_count++;
    }
    free(copy);
    if (gnutls_global_init() < 0 ||
        gnutls_certificate_allocate_credentials(&credentials) < 0)
        return -1;
    const char *ca = getenv("CA_BUNDLE");
    int trusted = ca ? gnutls_certificate_set_x509_trust_file(credentials, ca, GNUTLS_X509_FMT_PEM)
                     : gnutls_certificate_set_x509_system_trust(credentials);
    if (trusted <= 0) {
        fprintf(stderr, "Could not load trusted certificates\n");
        return -1;
    }
    return 0;
bad_copy:
    free(copy);
bad_config:
    fprintf(stderr, "Invalid ORIGINS: use domain=http[s]://host[:port];...\n");
    return -1;
}

const char *proxy_port(void) { return port; }

static void expired(int signal_number)
{
    (void)signal_number;
    static const char request[] = "HTTP/1.1 408 Request Timeout\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
    static const char origin[] = "HTTP/1.1 504 Gateway Timeout\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
    if (!response_started) {
        if (origin_phase)
            (void)send(client_fd, origin, sizeof origin - 1, MSG_DONTWAIT | MSG_NOSIGNAL);
        else
            (void)send(client_fd, request, sizeof request - 1, MSG_DONTWAIT | MSG_NOSIGNAL);
    }
    _exit(EXIT_FAILURE);
}

static int deadline(long ms)
{
    struct itimerval timer = {.it_value = {.tv_sec = ms / 1000,
                                          .tv_usec = (ms % 1000) * 1000}};
    return setitimer(ITIMER_REAL, &timer, NULL);
}

static ssize_t read_some(struct stream *s, void *data, size_t size)
{
    ssize_t n;
    do {
        n = s->tls ? gnutls_record_recv(s->tls, data, size) : read(s->fd, data, size);
    } while (s->tls ? n == GNUTLS_E_INTERRUPTED || n == GNUTLS_E_AGAIN
                    : n < 0 && errno == EINTR);
    return n;
}

static int write_all(struct stream *s, const void *data, size_t size)
{
    const unsigned char *p = data;
    while (size) {
        ssize_t n = s->tls ? gnutls_record_send(s->tls, p, size) : write(s->fd, p, size);
        if (s->tls ? n == GNUTLS_E_INTERRUPTED || n == GNUTLS_E_AGAIN
                   : n < 0 && errno == EINTR)
            continue;
        if (n <= 0)
            return -1;
        p += n;
        size -= (size_t)n;
    }
    return 0;
}

static int text(struct stream *s, const char *value)
{
    return write_all(s, value, strlen(value));
}

static int fill(struct stream *s)
{
    if (s->pos < s->end)
        return 1;
    ssize_t n = read_some(s, s->buffer, sizeof s->buffer);
    s->pos = 0;
    s->end = n > 0 ? (size_t)n : 0;
    return n > 0 ? 1 : n == 0 ? 0 : -1;
}

static int line(struct stream *s, char *out, size_t capacity)
{
    size_t size = 0;
    for (;;) {
        if (fill(s) <= 0 || size + 1 >= capacity)
            return -1;
        unsigned char c = s->buffer[s->pos++];
        if (c == '\n') {
            if (!size || out[size - 1] != '\r')
                return -1;
            out[size - 1] = '\0';
            return (int)size - 1;
        }
        if (!c || c == 127 || (c < 32 && c != '\r' && c != '\t') ||
            (size && out[size - 1] == '\r'))
            return -1;
        out[size++] = (char)c;
    }
}

static int token(const char *s)
{
    if (!*s)
        return 0;
    for (; *s; s++)
        if (!((*s >= 'A' && *s <= 'Z') || (*s >= 'a' && *s <= 'z') ||
              (*s >= '0' && *s <= '9') || strchr("!#$%&'*+-.^_`|~", *s)))
            return 0;
    return 1;
}

static int headers(struct stream *s, struct message *m)
{
    memset(m, 0, sizeof *m);
    int n = line(s, m->storage, sizeof m->storage);
    if (n <= 0)
        return -1;
    m->first = m->storage;
    size_t used = (size_t)n + 1;
    for (;;) {
        char *field = m->storage + used;
        n = line(s, field, sizeof m->storage - used);
        if (n < 0)
            return -1;
        if (!n)
            break;
        if (m->count == HEADER_COUNT)
            return -1;
        used += (size_t)n + 1;
        char *value = strchr(field, ':');
        if (!value)
            return -1;
        *value++ = '\0';
        if (!token(field))
            return -1;
        while (*value == ' ' || *value == '\t')
            value++;
        char *end = value + strlen(value);
        while (end > value && (end[-1] == ' ' || end[-1] == '\t'))
            *--end = '\0';
        m->fields[m->count++] = (struct header){field, value};
        if (!strcasecmp(field, "Content-Length")) {
            if (m->has_length || number(value, UINT64_MAX, &m->length))
                return -1;
            m->has_length = 1;
        }
        if (!strcasecmp(field, "Transfer-Encoding")) {
            if (m->chunked || strcasecmp(value, "chunked"))
                return -1;
            m->chunked = 1;
        }
    }
    return m->has_length && m->chunked ? -1 : 0;
}

static int in_list(const char *list, const char *name)
{
    size_t size = strlen(name);
    while (*list) {
        while (*list == ' ' || *list == '\t' || *list == ',')
            list++;
        const char *end = strchr(list, ',');
        if (!end)
            end = list + strlen(list);
        const char *trim = end;
        while (trim > list && (trim[-1] == ' ' || trim[-1] == '\t'))
            trim--;
        if ((size_t)(trim - list) == size && !strncasecmp(list, name, size))
            return 1;
        list = *end ? end + 1 : end;
    }
    return 0;
}

static int hop(const struct message *m, const char *name)
{
    if (in_list("Connection,Keep-Alive,Proxy-Authenticate,Proxy-Authorization,"
                "Proxy-Connection,TE,Trailer,Transfer-Encoding,Upgrade", name))
        return 1;
    for (size_t i = 0; i < m->count; i++)
        if (!strcasecmp(m->fields[i].name, "Connection") &&
            in_list(m->fields[i].value, name))
            return 1;
    return 0;
}

static int forward_headers(struct stream *s, const struct message *m, int request)
{
    for (size_t i = 0; i < m->count; i++) {
        const char *name = m->fields[i].name;
        if (hop(m, name) || (request && (!strcasecmp(name, "Host") ||
            !strcasecmp(name, "Content-Length") || !strcasecmp(name, "Expect"))))
            continue;
        if (text(s, name) || text(s, ": ") || text(s, m->fields[i].value) || text(s, "\r\n"))
            return -1;
    }
    return 0;
}

static int emit(struct sink *out, const void *data, size_t size)
{
    if (out->stream) {
        if (out->chunked) {
            char prefix[32];
            snprintf(prefix, sizeof prefix, "%zx\r\n", size);
            return text(out->stream, prefix) || write_all(out->stream, data, size) ||
                   text(out->stream, "\r\n") ? -1 : 0;
        }
        return write_all(out->stream, data, size);
    }
    if (size > out->limit - out->used)
        return -2;
    if (size)
        memcpy(out->data + out->used, data, size);
    out->used += size;
    return 0;
}

static int transfer(struct stream *s, struct sink *out, uint64_t size)
{
    while (size) {
        if (fill(s) <= 0)
            return -1;
        size_t n = s->end - s->pos;
        if (n > size)
            n = (size_t)size;
        int error = emit(out, s->buffer + s->pos, n);
        if (error)
            return error;
        s->pos += n;
        size -= n;
    }
    return 0;
}

static int chunks(struct stream *s, struct sink *out)
{
    char value[8192];
    for (;;) {
        if (line(s, value, sizeof value) <= 0 || !isxdigit((unsigned char)value[0]))
            return -1;
        errno = 0;
        char *end;
        unsigned long long size = strtoull(value, &end, 16);
        if (errno || (*end && *end != ';'))
            return -1;
        if (!size) {
            size_t total = 0;
            int n;
            while ((n = line(s, value, sizeof value)) > 0) {
                total += (size_t)n + 2;
                if (total > HEADER_BYTES || !strchr(value, ':'))
                    return -1;
            }
            return n;
        }
        int error = transfer(s, out, size);
        if (error)
            return error;
        if (line(s, value, sizeof value) != 0)
            return -1;
    }
}

static void fail(struct stream *client, int status, const char *reason)
{
    char response[256];
    int n = snprintf(response, sizeof response,
                     "HTTP/1.1 %d %s\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", status, reason);
    response_started = 1;
    (void)write_all(client, response, (size_t)n);
}

static int connect_origin(struct stream *s, const struct origin *o)
{
    struct addrinfo hints = {.ai_family = AF_UNSPEC, .ai_socktype = SOCK_STREAM}, *addresses;
    if (getaddrinfo(o->host, o->port, &hints, &addresses))
        return -1;
    for (struct addrinfo *a = addresses; a; a = a->ai_next) {
        s->fd = socket(a->ai_family, a->ai_socktype, a->ai_protocol);
        if (s->fd < 0)
            continue;
        if (!connect(s->fd, a->ai_addr, a->ai_addrlen))
            break;
        close(s->fd);
        s->fd = -1;
    }
    freeaddrinfo(addresses);
    if (s->fd < 0)
        return -1;
    if (o->tls) {
        if (gnutls_init(&s->tls, GNUTLS_CLIENT) < 0 ||
            gnutls_set_default_priority(s->tls) < 0 ||
            gnutls_credentials_set(s->tls, GNUTLS_CRD_CERTIFICATE, credentials) < 0 ||
            gnutls_server_name_set(s->tls, GNUTLS_NAME_DNS, o->host, strlen(o->host)) < 0)
            return -1;
        gnutls_session_set_verify_cert(s->tls, o->host, 0);
        gnutls_transport_set_int(s->tls, s->fd);
        int error;
        do {
            error = gnutls_handshake(s->tls);
        } while (error == GNUTLS_E_INTERRUPTED || error == GNUTLS_E_AGAIN);
        if (error < 0) {
            fprintf(stderr, "Origin TLS: %s\n", gnutls_strerror(error));
            return -1;
        }
    }
    return 0;
}

static int target_valid(const char *target)
{
    if (*target != '/')
        return 0;
    for (const unsigned char *p = (const unsigned char *)target; *p; p++) {
        if (*p <= 32 || *p >= 127 || *p == '#' || *p == '\\')
            return 0;
        if (*p == '%') {
            if (!p[1] || !p[2] || !isxdigit(p[1]) || !isxdigit(p[2]))
                return 0;
            p += 2;
        }
    }
    return 1;
}

void proxy_handle(int client)
{
    struct stream input = {.fd = client}, upstream = {.fd = -1};
    struct message request, response;
    struct sink body = {.limit = max_body};
    struct sigaction action = {.sa_handler = expired};
    sigemptyset(&action.sa_mask);
    client_fd = client;
    if (sigaction(SIGALRM, &action, NULL) || deadline(request_timeout_ms))
        return;
    int status = 400;
    const char *reason = "Bad Request";
    if (headers(&input, &request))
        goto error;
    char *method = request.first, *target = strchr(method, ' '), *version;
    if (!target)
        goto error;
    *target++ = '\0';
    version = strchr(target, ' ');
    if (!version)
        goto error;
    *version++ = '\0';
    if (!token(method) || !target_valid(target) ||
        (strcmp(version, "HTTP/1.1") && strcmp(version, "HTTP/1.0")))
        goto error;
    if (!strcmp(method, "CONNECT") || !strcmp(method, "TRACE")) {
        status = 501;
        reason = "Not Implemented";
        goto error;
    }
    const char *host = NULL, *expect = NULL;
    for (size_t i = 0; i < request.count; i++) {
        if (!strcasecmp(request.fields[i].name, "Host")) {
            if (host)
                goto error;
            host = request.fields[i].value;
        }
        if (!strcasecmp(request.fields[i].name, "Expect")) {
            if (expect)
                goto error;
            expect = request.fields[i].value;
        }
    }
    char domain[256], service[6] = "";
    if (!host || authority(host, domain, service))
        goto error;
    const struct origin *origin = NULL;
    for (size_t i = 0; i < origin_count; i++)
        if (!strcasecmp(domain, origins[i].domain))
            origin = &origins[i];
    if (!origin) {
        status = 421;
        reason = "Misdirected Request";
        goto error;
    }
    if (request.length > max_body) {
        status = 413;
        reason = "Content Too Large";
        goto error;
    }
    if (expect) {
        if (strcasecmp(expect, "100-continue")) {
            status = 417;
            reason = "Expectation Failed";
            goto error;
        }
        if (text(&input, "HTTP/1.1 100 Continue\r\n\r\n"))
            goto done;
    }
    body.data = malloc(request.chunked ? max_body : (size_t)request.length + 1);
    if (!body.data) {
        status = 500;
        reason = "Internal Server Error";
        goto error;
    }
    int result = request.chunked ? chunks(&input, &body) : transfer(&input, &body, request.length);
    if (result) {
        if (result == -2) {
            status = 413;
            reason = "Content Too Large";
        }
        goto error;
    }
    origin_phase = 1;
    status = 502;
    reason = "Bad Gateway";
    if (deadline(timeout_ms) || connect_origin(&upstream, origin))
        goto error;
    char length[64];
    snprintf(length, sizeof length, "Content-Length: %zu\r\n", body.used);
    if (text(&upstream, method) || text(&upstream, " ") || text(&upstream, target) ||
        text(&upstream, " HTTP/1.1\r\nHost: ") || text(&upstream, origin->authority) ||
        text(&upstream, "\r\n") || forward_headers(&upstream, &request, 1) ||
        ((request.has_length || request.chunked) && text(&upstream, length)) ||
        text(&upstream, "Connection: close\r\n\r\n") || write_all(&upstream, body.data, body.used))
        goto error;
    int code = 0;
    for (int interim = 0; interim < 9; interim++) {
        if (headers(&upstream, &response))
            goto error;
        const char *first = response.first;
        if ((strncmp(first, "HTTP/1.1 ", 9) && strncmp(first, "HTTP/1.0 ", 9)) ||
            strlen(first) < 12 || first[9] < '1' || first[9] > '5' ||
            first[10] < '0' || first[10] > '9' || first[11] < '0' || first[11] > '9' ||
            (first[12] && first[12] != ' '))
            goto error;
        code = (first[9] - '0') * 100 + (first[10] - '0') * 10 + first[11] - '0';
        if (code == 101)
            goto error;
        if (code >= 200)
            break;
    }
    if (code < 200)
        goto error;
    int chunked_output = response.chunked && !strcmp(version, "HTTP/1.1");
    response.first[7] = '1';
    response_started = 1;
    if (text(&input, response.first) || text(&input, "\r\n") ||
        forward_headers(&input, &response, 0) ||
        (chunked_output && text(&input, "Transfer-Encoding: chunked\r\n")) ||
        text(&input, "Connection: close\r\n\r\n"))
        goto done;
    struct sink output = {.stream = &input, .chunked = chunked_output};
    if (!strcmp(method, "HEAD") || code == 204 || code == 304)
        goto done;
    if (response.chunked) {
        result = chunks(&upstream, &output);
        if (!result && chunked_output)
            result = text(&input, "0\r\n\r\n");
    } else if (response.has_length) {
        result = transfer(&upstream, &output, response.length);
    } else {
        int available;
        while ((available = fill(&upstream)) > 0) {
            if (emit(&output, upstream.buffer + upstream.pos, upstream.end - upstream.pos))
                goto done;
            upstream.pos = upstream.end;
        }
        result = available < 0 ? -1 : 0;
    }
    if (result)
        fprintf(stderr, "Incomplete origin response\n");
    goto done;
error:
    fail(&input, status, reason);
done:
    (void)deadline(0);
    free(body.data);
    if (upstream.tls)
        gnutls_deinit(upstream.tls);
    if (upstream.fd >= 0)
        close(upstream.fd);
}
