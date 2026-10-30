#include "check.h"
#include "zc_config.h"
#include <string.h>

static const char *CFG =
 "{\"domains\":[{\"domain\":\"Ejemplo.com\",\"origin\":\"https://ejemplo.com\",\"maxCacheBytes\":1048576,\"urls\":["
 " {\"pattern\":\"/*\",\"auth\":{\"mode\":\"none\"},\"fileTypes\":[{\"ext\":\"html\",\"ttl\":60,\"policy\":\"LRU\"},{\"ext\":\"*\",\"ttl\":10,\"policy\":\"fifo\"}]},"
 " {\"pattern\":\"/api/*\",\"auth\":{\"mode\":\"apikey\",\"apiKeyHashes\":[\"2CF24DBA5FB0A30E26E83B2AC5B9E29E1B161E5C1FA7425E73043362938B9824\",\"corto\"]}},"
 " {\"pattern\":\"/privado/*\",\"cacheBytes\":5000,\"auth\":{\"mode\":\"userpass\"},\"fileTypes\":[{\"ext\":\"PNG\",\"ttl\":3600,\"policy\":\"LFU\"}]}]},"
 " {\"domain\":\"*.cdn.test\",\"origin\":\"http://o:8080\",\"maxCacheBytes\":10}]}";

int main(void) {
    printf("test_config\n"); char err[256] = "";
    CHECK(zc_wildcard_match("/a/*", "/a/b/c.png", 0) && !zc_wildcard_match("/a/*", "/b/a/x", 0));
    CHECK(zc_wildcard_match("*.png", "x/y.png", 0) && zc_wildcard_match("*", "", 0) && !zc_wildcard_match("a*b", "ac", 0));
    CHECK(zc_wildcard_match("*.Ejemplo.COM", "www.ejemplo.com", 1) && !zc_wildcard_match("*.ejemplo.com", "ejemplo.com", 1));

    zc_config_t *c = zc_config_parse(CFG, err, sizeof err);
    CHECK(c != NULL && c->n_domains == 2);
    if (!c) { fprintf(stderr, "%s\n", err); DONE(); }

    const zc_domain_t *d = zc_config_find_domain(c, "EJEMPLO.com:8443");
    CHECK(d && d->max_cache_bytes == 1048576 && d->n_rules == 3);
    CHECK(zc_config_find_domain(c, "img.cdn.test") != NULL);
    CHECK(zc_config_find_domain(c, "otro.com") == NULL);

    /* gana el patrón más específico, y la query se ignora */
    CHECK(strcmp(zc_domain_match_rule(d, "/api/users?id=1")->pattern, "/api/*") == 0);
    CHECK(strcmp(zc_domain_match_rule(d, "/privado/x.png")->pattern, "/privado/*") == 0);
    CHECK(strcmp(zc_domain_match_rule(d, "/index.html")->pattern, "/*") == 0);

    const zc_rule_t *pub = zc_domain_match_rule(d, "/index.html");
    const zc_filetype_t *t = zc_rule_filetype(pub, "/index.html?x=1.png");
    CHECK(t && t->ttl == 60 && t->policy == ZC_POLICY_LRU);
    t = zc_rule_filetype(pub, "/foto.jpg");                       /* cae en "*" */
    CHECK(t && t->ttl == 10 && t->policy == ZC_POLICY_FIFO);

    const zc_rule_t *api = zc_domain_match_rule(d, "/api/x");
    CHECK(api->auth == ZC_AUTH_APIKEY && api->n_keys == 1 && zc_rule_filetype(api, "/api/x") == NULL); /* sin tipos => no cacheable */
    CHECK(strcmp(api->key_hashes[0], "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824") == 0); /* normalizado; hash corto descartado */

    const zc_rule_t *priv = zc_domain_match_rule(d, "/privado/a.png");
    CHECK(priv->auth == ZC_AUTH_USERPASS && priv->cache_bytes == 5000);
    CHECK(zc_rule_filetype(priv, "/privado/a.PNG")->policy == ZC_POLICY_LFU);
    zc_config_free(c);

    /* Falla cerrado ante configuraciones inválidas */
    CHECK(zc_config_parse("{\"domains\":[{\"domain\":\"a\",\"urls\":[{\"pattern\":\"/\",\"auth\":{\"mode\":\"magia\"}}]}]}", err, sizeof err) == NULL);
    CHECK(zc_config_parse("{\"domains\":[{\"domain\":\"a\",\"urls\":[{\"pattern\":\"/\",\"fileTypes\":[{\"ext\":\"x\",\"policy\":\"ARC\"}]}]}]}", err, sizeof err) == NULL);
    CHECK(zc_config_parse("no es json", err, sizeof err) == NULL);
    CHECK(zc_config_parse("{}", err, sizeof err) == NULL);
    CHECK(zc_config_load_file("/tmp/no_existe_zc.json", err, sizeof err) == NULL);
    DONE();
}
