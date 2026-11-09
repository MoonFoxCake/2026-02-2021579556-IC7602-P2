# Integración actual de la UI — 9 de noviembre de 2026

La UI usa React, Vite y Tailwind. Todas las operaciones consultan el API real; no se simula éxito en el navegador.

| Función | Implementación |
|---|---|
| Registro, login y logout | JWT/bcrypt; el JWT vive solo en memoria y se elimina al cerrar sesión. Recargar exige iniciar sesión otra vez. |
| Dominios y verificación TXT | API Node.js + Firestore; el API consulta DNS para verificar propiedad. |
| Reglas wildcard, tamaño, tipos, TTL y política | Administración por dominio; el API valida y transforma al formato de GNU C. |
| Claves y usuarios por URL | Crear/revocar claves y crear/modificar contraseña/eliminar usuarios. |
| Login externo `/cache-login` | Usuario del recurso → ticket firmado → callback de la caché → cookie de sesión. |
| Acceso a caché | Destinos fijos CR/US mediante gateway autenticado; MISS/HIT, credenciales y logout. |
| Interceptor, cachés, Java y Apache | Implementados y desplegados en Kubernetes. |

## Configuración

En Vercel, `VITE_API_BASE_URL=/api`. `API_PROXY_ORIGIN` contiene únicamente el origen HTTPS del API, sin `/api` ni credenciales. `frontend/vercel.mjs` valida ese valor y configura el rewrite antes del fallback SPA. No contiene un destino de producción quemado ni necesita un paquete adicional.

Para desarrollo local se puede usar `VITE_API_BASE_URL=http://localhost:3000/api`; configure ese origen en `CORS_ORIGINS`. Compose utiliza Nginx y `/api` bajo el mismo origen.

El JWT de administración y las sesiones de recursos son distintos. Las cookies HttpOnly/Secure/SameSite=Lax pertenecen al panel de caché y se aíslan por cuenta/regla/zona. No se envía el JWT al origen ni se ejecuta el HTML recibido como resultado.

El contrato vigente está en [API.md](../api-nodejs/API.md), [README del API](../api-nodejs/README.md) y `frontend/src/api.ts`. No existe `/auth/session` ni `/auth/logout`: la cuenta se consulta con `/auth/me` y el logout elimina el JWT local.

## Verificación

Desde `frontend`: `npm run test:deployment`, `npm run typecheck`, `npm run lint` y `npm run build`. Cuatro pruebas verifican el proxy, el rechazo de orígenes inválidos y que API/telemetría no reciban HTML de la SPA.

Pruebas de producción: [PUBLIC-CACHE.md](PUBLIC-CACHE.md). Reproducción de las pruebas C, geográficas y HTTP externo: [TECHNICAL-VALIDATION.md](TECHNICAL-VALIDATION.md).
