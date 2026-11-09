# Tareas: Persona 2 — Núcleo de Zonal Cache

Plan: `tasks/plan.md`. Las rutas son propuestas para la implementación.

## P2-01 — Servidor HTTP y proxy al origen

- [ ] Crear compilación GNU C y servidor HTTP con configuración por entorno.
- [ ] Reenviar método, ruta, query, encabezados aplicables y cuerpo hacia orígenes HTTP/HTTPS; devolver estado, encabezados y cuerpo del origen.
- [ ] Validar peticiones y certificados HTTPS; manejar timeouts y errores del origen.

**Verificación:** compilar con advertencias; comparar respuestas a través del proxy con las del origen para GET, HEAD, POST, PUT y DELETE. Probar contenido binario, petición inválida, timeout y certificado inválido.
**Dependencias:** ninguna.
**Archivos previstos:** `zonal-cache/Makefile`, `zonal-cache/src/main.c`, `zonal-cache/src/proxy.c`, `zonal-cache/include/proxy.h`, `zonal-cache/tests/proxy.sh`.

## P2-02 — Caché en disco, claves y TTL

- [ ] Crear claves que distingan dominio, origen, ruta y query sin permitir acceso fuera del directorio de caché.
- [ ] Guardar respuestas GET elegibles y metadatos; servir hit desde disco y consultar el origen en miss o expiración. Un hit no renueva el TTL.
- [ ] Evitar almacenar respuestas privadas o incompletas; mantener coherencia de archivos y metadatos al reiniciar.

**Verificación:** demostrar miss → hit → expiración → miss con un contador en el origen. Comprobar separación de dominios y queries, contenido binario idéntico, descarga interrumpida y reinicio.
**Dependencias:** P2-01.
**Archivos previstos:** `zonal-cache/src/cache.c`, `zonal-cache/include/cache.h`, `zonal-cache/src/proxy.c`, `zonal-cache/tests/cache.c`, `zonal-cache/Makefile`.

## Punto de control: proxy y disco

- [ ] Compilación y pruebas de P2-01/P2-02 pasan; HTTP/HTTPS, hit/miss y TTL demostrados.

## P2-03 — Tipos de archivo y límite por dominio

- [ ] Almacenar solo los tipos permitidos por configuración.
- [ ] Contabilizar bytes por dominio, incluidos archivos existentes al iniciar, y no sobrepasar el límite durante descargas de tamaño conocido o desconocido.
- [ ] Entregar sin almacenar recursos que no caben o no son elegibles; manejar falta de disco sin publicar entradas parciales.

**Verificación:** probar tipo permitido/excluido, TTL cero, objeto mayor al máximo, descarga sin tamaño anunciado y dos dominios con cuotas independientes. Verificar los bytes almacenados.
**Dependencias:** P2-02.
**Archivos previstos:** `zonal-cache/src/cache.c`, `zonal-cache/include/cache.h`, `zonal-cache/src/proxy.c`, `zonal-cache/tests/cache.c`.

## P2-04 — Docker y Helm

- [ ] Crear imagen Docker con el binario y las dependencias necesarias para orígenes HTTPS.
- [ ] Crear chart con Deployment, Service y volumen para la caché; inyectar configuración por entorno.
- [ ] Permitir instalación y desinstalación mediante comandos reproducibles.

**Verificación:** construir imagen, ejecutar `helm lint` y `helm template`, instalar en Kubernetes y realizar una petición HTTP al componente. Comprobar uso del volumen tras reiniciar el pod.
**Dependencias:** P2-03.
**Archivos previstos:** `zonal-cache/Dockerfile`, `zonal-cache/helm/Chart.yaml`, `zonal-cache/helm/values.yaml`, `zonal-cache/helm/templates/workload.yaml`, `zonal-cache/helm/templates/storage.yaml`.

## Punto de control: límites y despliegue

- [ ] Tipos y cuotas pasan sus pruebas; el componente se instala con Helm y responde desde Kubernetes.

## P2-05 — Pruebas y documentación del núcleo

- [ ] Automatizar comprobaciones de proxy HTTP/HTTPS, hit/miss, TTL, tipos, límites y errores básicos.
- [ ] Documentar requisitos, compilación, variables, instalación Helm y comandos de prueba en Markdown.
- [ ] Registrar resultados y limitaciones del núcleo implementado.

**Verificación:** ejecutar las pruebas y seguir la guía desde una instalación limpia; contrastar resultados con los criterios de P2-01 a P2-04.
**Dependencias:** P2-04.
**Archivos previstos:** `zonal-cache/tests/smoke.sh`, `zonal-cache/docs/test-results.md`, `zonal-cache/README.md`.

## Punto de control final

- [ ] Todas las tareas tienen evidencia de verificación.
- [ ] Automatización y documentación permiten ejecutar y probar el núcleo de forma reproducible.
