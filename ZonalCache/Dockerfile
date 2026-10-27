# Zonal Cache — imagen multi-etapa.
# Hoy empaqueta la biblioteca de la Persona 3 (libzc_p3.a) y su servidor de prueba (zc_p3_demo).
# Cuando el servidor de la Persona 2 exista, solo cambia el binario que se copia/ejecuta (ver TODO abajo).
#
#   docker build -t zonal-cache:dev ZonalCache
#   docker run --rm -p 8080:8080 -e ZC_CONFIG_FILE=/etc/zc/config.json \
#     -v $PWD/ZonalCache/docs/ejemplo-config.json:/etc/zc/config.json:ro zonal-cache:dev

FROM debian:bookworm-slim AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential libcurl4-openssl-dev libssl-dev openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY Makefile ./
COPY p3 ./p3
COPY tools ./tools
COPY tests ./tests
COPY scripts ./scripts
# Las pruebas unitarias corren dentro del build: si fallan, no hay imagen.
RUN make clean && make all && make test

FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends libcurl4 libssl3 ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --home /var/cache/zc zc \
 && mkdir -p /var/cache/zc && chown zc /var/cache/zc
# TODO(Persona 2): reemplazar zc_p3_demo por el binario real de la Zonal Cache.
COPY --from=build /src/tools/zc_p3_demo /usr/local/bin/zonal-cache
USER zc
ENV ZC_HTTP_PORT=8080 ZC_HTTPS_PORT=8443 ZC_CACHE_DIR=/var/cache/zc
EXPOSE 8080 8443
VOLUME ["/var/cache/zc"]
ENTRYPOINT ["/usr/local/bin/zonal-cache"]
