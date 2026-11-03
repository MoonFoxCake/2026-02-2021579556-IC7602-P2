# Zonal Cache — imagen multi-etapa con el SERVIDOR REAL (src/zonal_cache.c + biblioteca p3/).
#
#   docker build -t zonal-cache:dev ZonalCache
#   docker run --rm -p 8080:8080 -e ZC_ZONE=cr -e ZC_CONFIG_FILE=/etc/zc/config.json \
#     -v $PWD/ZonalCache/docs/ejemplo-config.json:/etc/zc/config.json:ro zonal-cache:dev
#
# Con minikube: scripts/deploy-k8s.sh construye la imagen DENTRO de minikube y despliega las zonas con Helm.

# Base y paquetes de ejecución parametrizables (por defecto Debian 12). Ej. Ubuntu 24.04:
#   --build-arg BASE_IMAGE=ubuntu:24.04 --build-arg RUNTIME_PKGS="libcurl4t64 libssl3t64 ca-certificates"
ARG BASE_IMAGE=debian:bookworm-slim
ARG RUNTIME_PKGS="libcurl4 libssl3 ca-certificates"

FROM ${BASE_IMAGE} AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential libcurl4-openssl-dev libssl-dev openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY Makefile ./
COPY p3 ./p3
COPY src ./src
COPY tools ./tools
COPY tests ./tests
COPY scripts ./scripts
# Las pruebas unitarias corren dentro del build: si fallan, no hay imagen.
RUN make clean && make zonal-cache && make test

FROM ${BASE_IMAGE}
ARG RUNTIME_PKGS
RUN apt-get update \
 && apt-get install -y --no-install-recommends ${RUNTIME_PKGS} \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --home /var/cache/zc zc \
 && mkdir -p /var/cache/zc && chown zc /var/cache/zc
COPY --from=build /src/zonal-cache /usr/local/bin/zonal-cache
USER 10001
ENV ZC_HTTP_PORT=8080 ZC_HTTPS_PORT=8443 ZC_CACHE_DIR=/var/cache/zc
EXPOSE 8080 8443
VOLUME ["/var/cache/zc"]
ENTRYPOINT ["/usr/local/bin/zonal-cache"]
