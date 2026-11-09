# Plan: Persona 2 — Núcleo de Zonal Cache

Estado: P2-01 implementada y verificada; P2-02 a P2-05 pendientes.

## Alcance

Según `image.png` y la sección Zonal Cache de `2026-02-IC7602-P2.pdf`:

- Servidor HTTP en GNU C y proxy hacia orígenes HTTP/HTTPS.
- Caché en disco y claves de caché.
- Detección de hit/miss y expiración por TTL.
- Filtrado por tipos de archivo.
- Límite de almacenamiento por dominio.
- Docker, Helm y documentación del componente.

## Solución mínima

Flujo: petición HTTP → buscar recurso vigente en disco → servir hit; si hay miss, consultar el origen → guardar si el tipo, TTL y espacio lo permiten → responder.

- Implementar en `zonal-cache/`, con un módulo de proxy y otro de caché, sin capas adicionales.
- Reenviar método, ruta, query, encabezados aplicables y cuerpo; devolver estado y contenido del origen. Almacenar únicamente respuestas GET elegibles.
- Usar GNU GnuTLS (autorizada) para acceder a orígenes HTTPS y validar sus certificados; el resto del ejecutable usa C estándar y glibc/POSIX.
- Distinguir dominio, origen, ruta y query en la clave; no usar rutas recibidas como rutas directas del disco.
- Guardar cuerpo y metadatos mínimos: clave, tamaño y vencimiento. Publicar solo archivos completos.
- Un hit no extiende el TTL. Una entrada vencida produce miss.
- Aplicar tipos permitidos y límite de bytes por dominio. Si el recurso no cabe, entregarlo sin almacenarlo; no agregar un algoritmo de reemplazo.
- Inyectar configuración por variables de entorno: puerto, origen por dominio, directorio de caché, TTL, tipos permitidos, límite y timeout. No quemar valores en el código.
- Manejar peticiones inválidas, errores del origen y fallos de disco sin dejar entradas incompletas ni exceder el límite. Contabilizar los archivos existentes al iniciar.

## Orden de trabajo

| Tarea | Resultado | Depende de |
| --- | --- | --- |
| P2-01 | Servidor GNU C que reenvía peticiones a orígenes HTTP/HTTPS | — |
| P2-02 | Caché en disco con claves, hit/miss y TTL | P2-01 |
| P2-03 | Tipos de archivo y límite por dominio | P2-02 |
| P2-04 | Imagen Docker y despliegue Helm | P2-03 |
| P2-05 | Pruebas reproducibles y guía de ejecución | P2-04 |

Criterios de aceptación y verificaciones en `tasks/todo.md`.

## Criterio de finalización

El componente puede instalarse con Helm, consultar orígenes HTTP/HTTPS y demostrar hit/miss, TTL, filtrado por tipo y límites por dominio con pruebas documentadas.
