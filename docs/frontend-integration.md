# Frontend requirements and integration status

This document maps the IC7602 Proyecto 2 specification to the current UI and the services that must be available for live use. The UI does not use mock records or claim that an operation succeeded without an API response.

## Status

| Requirement or service | Frontend state | Needed for full integration |
| --- | --- | --- |
| Account registration, login and logout | Screens and API client implemented | Node API routes and HttpOnly session cookie |
| Domain add/remove and TXT ownership check | Screens, TXT challenge display and verification action implemented | Node API and Firebase persistence; API must return TXT challenge name/value and verification result |
| URL rule create/update/delete | Rule form and list implemented | Node API and Firebase persistence |
| Wildcard URL matching, cache size, file extensions, TTL and replacement policy | Fields support wildcard patterns, per-rule MB limit, extension/TTL pairs and LRU/LFU/FIFO/MRU/Random | Node API validation and Zonal Cache consumption of saved settings |
| API key access using `x-api-key` | Per-rule key list/create/delete UI implemented | Node API key management and Zonal Cache validation |
| Username/password access | Per-rule user create/update/delete UI implemented | Node API credential management and Zonal Cache authentication |
| Zonal Cache login form | Credential form calls the proposed login endpoint | Cache-to-UI session handoff is **pending**; no protocol is defined in the available repositories/specification |
| Node REST API and Firebase/Firestore | Integration point documented; no Node API or Firebase source is in this checkout | Implement the secure API, persist configuration, document the Firebase model and automate Vercel deployment from GitHub |
| DNS Interceptor | Status shown as pending | Integrate deployed DNS routing/geolocation with domain and zonal-cache configuration |
| Zonal Cache | Status shown as pending | Implement the cache service, load configuration, enforce auth, limits, TTLs and replacement policies |
| Java REST API and Apache Server | Status shown as pending | Deploy both test targets and verify end-to-end cache behavior against them |
| Vercel deployment | Existing project configuration preserved | Configure `VITE_API_BASE_URL` and verify the existing Vercel project/build settings when the API is available |

## Proposed Node API contract

Set `VITE_API_BASE_URL` to the Node API origin. An empty value uses same-origin paths. Requests include browser credentials (`credentials: include`) so the API can set an HttpOnly session cookie. The API must configure credentialed CORS and a `Secure`/`HttpOnly` cookie with a `SameSite` policy compatible with the deployment topology. Do not expose session secrets to frontend JavaScript.

All successful JSON collection reads return arrays. Errors should return a JSON object such as `{"message":"Human-readable explanation"}` with an appropriate HTTP status. A `204 No Content` response is accepted for successful deletes and logout.

| Method | Path | Request / response contract |
| --- | --- | --- |
| `POST` | `/auth/register` | `{email, password}`; returns `{user:{id,email}}` and establishes a session |
| `POST` | `/auth/login` | `{email, password}`; returns `{user:{id,email}}` and establishes a session |
| `GET` | `/auth/session` | Returns `{user:{id,email}}`; unauthenticated requests return `401` |
| `POST` | `/auth/logout` | Clears the session cookie; `204` on success |
| `GET` | `/domains` | Returns `Domain[]` with `{id,hostname,verified,verification?}` |
| `POST` | `/domains` | `{hostname}`; returns the created domain and, while unverified, `verification:{name,value}` for its TXT record |
| `DELETE` | `/domains/:domainId` | Deletes the domain and its configuration; `204` on success |
| `POST` | `/domains/:domainId/verify` | Checks the published TXT record; returns `{verified:boolean}` |
| `GET` | `/domains/:domainId/urls` | Returns `UrlRule[]` for the domain |
| `POST` | `/domains/:domainId/urls` | `{pattern,cacheSizeMb,fileTypes,replacementPolicy,authMode}`; returns the created rule |
| `PUT` | `/domains/:domainId/urls/:urlId` | Replaces the rule settings using the same fields; returns the updated rule |
| `DELETE` | `/domains/:domainId/urls/:urlId` | Deletes the rule; `204` on success |
| `GET`, `POST` | `/domains/:domainId/urls/:urlId/users` | Lists users or creates one with `{username,password}`; create returns `{id,username}` |
| `PUT`, `DELETE` | `/domains/:domainId/urls/:urlId/users/:userId` | `PUT` accepts `{username?,password?}`; `DELETE` removes the user; never return a password |
| `GET`, `POST` | `/domains/:domainId/urls/:urlId/api-keys` | Lists key metadata or creates with `{label}`; create returns `{id,label,prefix,secret}` with the secret shown only once |
| `DELETE` | `/domains/:domainId/urls/:urlId/api-keys/:keyId` | Revokes the key; `204` on success |

`UrlRule.fileTypes` is an array of `{extension,ttlSeconds}`. `replacementPolicy` is one of `LRU`, `LFU`, `FIFO`, `MRU`, or `Random`. `authMode` is `api-key` or `credentials`. The Node API must validate authorization and all values; frontend validation is for usability, not a security boundary.

## Verification when services are ready

1. Configure `VITE_API_BASE_URL` in the local environment and Vercel without committing secrets.
2. Confirm registration, login, session restoration, logout, credentialed CORS and cookie behavior against the deployed Node API.
3. Verify TXT challenge delivery and repeated verification checks, domain CRUD, wildcard URL CRUD, cache policy persistence, user/password management and API-key revocation.
4. Agree and implement the zonal-cache login/session handoff; then test protected requests with both `x-api-key` and user credentials.
5. Exercise the full system with the Java REST API, Apache page, external HTTP and HTTPS origins, and DNS Interceptor routing to a zonal cache.
