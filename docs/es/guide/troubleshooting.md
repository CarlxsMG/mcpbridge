# Solución de problemas

Problemas comunes y sus soluciones. La mayoría son comportamiento de seguridad deliberado
en lugar de bugs.

## Un backend en localhost/IP privada es rechazado

La protección SSRF bloquea direcciones loopback y privadas por diseño. Para **desarrollo
local solo**, define `ALLOW_PRIVATE_IPS=true` para registrar backends en `127.0.0.1` etc.
Nunca lo habilites en producción.

## El login admin falla sobre http://localhost

La cookie de sesión es `__Host-`/`Secure` por defecto y los navegadores no la guardan sobre
HTTP plano. Para dev local, define `SESSION_COOKIE_SECURE=false` **y** `NODE_ENV=development`
(que relaja la guarda de arranque). En producción, sirve sobre HTTPS y deja ambos en sus
defaults.

## El login funcionaba, ahora la cookie no se establece en localhost

Alternar `SESSION_COOKIE_SECURE` en el mismo origen puede dejar una cookie `__Host-`
obsoleta que ensombrece a la plana. **Limpia las cookies del sitio** e inicia sesión de
nuevo.

## Un endpoint sharded/bundle devuelve 404 para mi sesión

Los endpoints per-client y bundle rechazan una sesión creada para un scope _diferente_, y
devuelven el **mismo 404** que una sesión desconocida (así un caller no puede distinguir
"shard equivocado" de "sin sesión"). Abre la sesión contra la URL exacta que usarás.

## El discovery no encuentra tools / errores

- **Sin tools** — comprueba que tus filtros `include_tags` / `exclude_operations` no están
  excluyendo todo.
- **`OPENAPI_CYCLIC_REFERENCE`** — el spec tiene un ciclo auto-referencial (a menudo un loop
  de anchor YAML); el bridge lo rechaza en lugar de colgarse. Aplana el schema
  ofensor.

## Las tool calls son rechazadas

- **Restricción allowed-key** — la key que llama no está en la allow-list de la tool (fail-closed
  incluso si la auth global está off).
- **Guardrail** — el input coincidió con una deny-rule o patrón de secreto, o la key
  carece del scope _elevated_ para una tool sensible.
- **Circuit breaker open** — el backend está fallando; las llamadas fallan rápido hasta que
  se recupere.

## El admin UI no se está sirviendo

El backend sirve el SPA buildeado desde `admin-ui/dist` en `/admin`. Si ves un warning de
que falta `admin-ui/dist`, ejecuta `bun run build` en `admin-ui/` (la imagen Docker lo hace
en una stage dedicada).

## ¿Aún atascado?

Abre un issue con el request ID de la response de error (`error.request_id`) — vincula el
fallo al log estructurado del servidor.
