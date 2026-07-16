# Dos planos, tres endpoints — la división de `/mcp`

- Estado: aceptado
- Fecha: 2026-07-06
- Decisores: CarlxsMG (arquitectura), Claude Sonnet 5 (revisión + hardening)

## Contexto y planteamiento del problema

`/mcp` solía ser un único endpoint que agregaba las tools de backend de cada
cliente habilitado en una sola sesión aplanada. Eso colisionaba con los
endpoints de datos por cliente reales (`/mcp/:clientName`) y con los endpoints
curados entre clientes (`/mcp-custom/:bundleName`) de tres formas concretas:

1. **No había forma de gestionar el gateway en sí sobre MCP.** Los operadores
   que conectaban un LLM de administración al bridge tenían que salir de MCP
   para llamar a endpoints REST de admin en el día a día: listar clientes,
   registrar un backend nuevo, emitir o revocar keys MCP, seguir el log de
   auditoría, resetear un circuit breaker.
2. **Las tools compuestas (macros) se filtraban.** Una composite registrada
   contra un bundle podía invocarse desde una sesión con scope a otro bundle
   distinto, o desde el agregado, lo que rompía el invariante "la superficie de
   API de este bundle".
3. **El transporte SSE legacy (`GET /sse` + `POST /messages`) estaba atado al
   agregado.** Streamable HTTP tuvo que añadirse junto a SSE en lugar de
   reemplazarlo, duplicando la superficie de transporte a mantener.

La pregunta: ¿cómo reestructuramos `/mcp` para que el bridge sea a la vez
gobernable (un LLM de admin puede pilotarlo vía MCP) y acotado (una sesión
solo puede ver las tools a las que se le dio scope)?

## Drivers de la decisión

- **Separación de planos de auth.** El plano de datos (`/mcp/:clientName`,
  `/mcp-custom/:bundleName`) usa `mcpAuth`, que tiene un fallback explícito
  "sin material de auth configurado → permitir todo" (solo para desarrollo).
  El plano de control (gestión del gateway) no puede tener ese fallback — una
  API de admin sin configurar dejaría a cualquiera emitir keys. Los dos planos
  necesitan lógica de auth distinta.
- **Las composites pertenecen a los bundles, no al bridge.** Una composite es
  "la macro de este bundle", no una tool independiente. Su scope debe ser el
  bundle al que se añadió, no la sesión global.
- **Solo Streamable HTTP.** Mantener SSE y Streamable HTTP a la vez duplica la
  superficie de tests, errores de transporte y peculiaridades de proxy
  (ver REVIEW §2.6).
- **Sin breaking change en los endpoints por cliente.** Los clientes MCP
  existentes que se conectan a `/mcp/:clientName` no deberían tener que saber
  que algo cambió.

## Opciones consideradas

- **A. Mantener `/mcp` como el agregado y añadir `/mcp/admin` como hermano.**
  Dos endpoints, mismo hostname, auth distinta. Rechazada: el agregado sigue
  siendo el "endpoint mágico que aplana todo", que es exactamente lo que
  intentamos eliminar; y el problema de las composites persiste porque siguen
  viviendo en el agregado.
- **B. Renombrar `/mcp` a `/mcp/:clientName` y crear `/mcp/admin`.**
  Rechazada: obliga a cada cliente MCP existente (potencialmente externo) a
  actualizar su URL base. Rompe el contrato público el primer día del
  refactor.
- **C. Reutilizar `/mcp` como el plano de control; mantener
  `/mcp/:clientName` y `/mcp-custom/:bundleName` como el plano de datos.**
  Elegida. La auth del plano de control (`rootMcpAuth` /
  `resolveSystemRole`) es fail-closed por diseño y resuelve únicamente desde
  el Bearer de admin de entorno o desde la columna `adminRole` de una key MCP
  gestionada (migración 51). La auth del plano de datos permanece sin cambios.

## Resultado de la decisión

Opción elegida: **C — dos planos, tres endpoints**.

`/mcp` es ahora el **plano de control del sistema**: tools `sys_*`
(listar/registrar/habilitar clientes, emitir/revocar keys MCP, seguir el log
de auditoría, resetear un circuit breaker, …) respaldadas por las mismas
funciones de dominio que la API REST de admin ya llama. `/mcp/:clientName` y
`/mcp-custom/:bundleName` son los shards del **plano de datos**. Las composites
se movieron a la pertenencia a un bundle (migración 52,
`mcp_bundle_composites`) — una composite debe añadirse al `composites[]` de un
bundle para ser alcanzable. El transporte SSE legacy se elimina; Streamable
HTTP es ahora el único transporte MCP entrante.

Cada system tool lleva un nivel de rol (read / operate / admin, reflejando
`requireOperator` / `requireAdminRole` en el middleware de authz REST) y una
puerta de step-up sensible / `__confirm`, reutilizando el mismo mecanismo que
`proxy.ts` ya aplica a las tools de backend sensibles.

### Consecuencias

- Bueno, porque el bridge es ahora totalmente gobernable sobre MCP — un LLM de
  admin puede pilotar todo el ciclo de vida (registrar, configurar, emitir
  key, llamar) a través de un único protocolo.
- Bueno, porque el contrato de auth existente del plano de datos no cambia;
  ningún cliente MCP necesita actualizar su configuración.
- Bueno, porque eliminar el scope del agregado también elimina la fuga de
  composites: las composites solo pueden invocarse a través del bundle al que
  pertenecen.
- Bueno, porque eliminar SSE reduce a la mitad la matriz de transportes — cada
  test e2e y de integración corre ahora contra un único transporte.
- Malo, porque cualquier operador que dependía de `/mcp` como atajo (una URL,
  todas las tools) tiene que elegir entre `/mcp` (control) y los shards por
  cliente / bundle (datos).
- Malo, porque el chequeo de scope de cliente de `mcp-server.ts` solía ser un
  test de prefijo de nombre en lugar de una pertenencia exacta tool→cliente;
  el refactor lo sacó a la luz al ser la primera vez que el plano de datos se
  ejercitaba de forma aislada contra su propia puerta de auth. Cerrado en el
  mismo commit (pertenencia exacta por `Set`, igual que ya hacía la rama de
  bundle).

### Confirmación

- `src/mcp/system-tools.ts` registra cada tool `sys_*` con un nivel de rol
  explícito y el mismo step-up `__confirm` / credencial elevada que el proxy
  ya aplica a las tools de backend sensibles.
- `src/security/system-role.ts` `resolveSystemRole` rechaza a los callers sin
  credencial de rol de sistema — **no** hay un modo abierto de admin sin
  configurar. Cubierto por `src/mcp/__tests__/system-tools.test.ts`.
- `e2e/auth-fail-closed.spec.ts` y `e2e/mcp-protocol.spec.ts` ejercitan el
  plano de datos contra el endpoint `/mcp/:clientName` posterior a la
  división, y cada spec emite su propia key MCP gestionada para que la suite
  sea independiente del orden.

## Más información

- Commit: `69fd8eb` — `feat(mcp): split /mcp into a system control plane,
separate from data-plane shards`
- Código relacionado: `src/mcp/system-tools.ts`,
`src/security/system-role.ts`, `src/mcp/transports.ts`.
</content>

</invoke>
