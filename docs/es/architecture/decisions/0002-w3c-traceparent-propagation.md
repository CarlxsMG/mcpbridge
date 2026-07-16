# Propagación de traceparent W3C a través del pipeline del proxy

- Estado: aceptado
- Fecha: 2026-07-06
- Decisores: CarlxsMG (SRE + arquitectura), Claude Sonnet 5 (revisión)

## Contexto y planteamiento del problema

El bridge tiene tracing OTLP (`src/observability/tracing.ts`) y el exporter de
Prometheus (`src/observability/metrics.ts`) para el pipeline del proxy, pero
los spans que emite son **huérfanos**: cada bucket del histograma
`mcp_proxy_request_duration_seconds` tiene un trace-id nuevo, así que la vista
del bridge en Jaeger / Tempo / Honeycomb muestra una lista plana de traces sin
relación. El caller — típicamente un host de agente — tiene su propio árbol de
traces, y no hay forma de correlacionar los spans del bridge con él.

Sin correlación, un operador que persigue una llamada de tool lenta en su
propio visor de traces no puede responder: ¿el bridge añadió 800 ms, o fue el
upstream? ¿Se disparó el breaker, o el upstream devolvió un 5xx? Los buckets de
`mcp_proxy_request_duration_seconds` no se pueden trocear por trace de upstream.

La pregunta: ¿deberíamos honrar una cabecera `traceparent` entrante y
propagarla tanto al span OTLP del bridge (para que el árbol de traces se cosa)
como al fetch saliente (para que los propios traces del upstream también vivan
bajo el mismo trace-id)?

## Drivers de la decisión

- **Estándar de la industria.** W3C Trace Context (`traceparent`,
  `tracestate`) es el formato de propagación de facto; OpenTelemetry, Jaeger,
  Datadog y Honeycomb lo emiten y lo aceptan. Adoptarlo es interoperabilidad
  gratis con cualquier visor de traces que el operador ya use.
- **La entrada malformada nunca debe fallar la request.** Un caller pilotado
  por un LLM podría enviar `traceparent: garbage`; no podemos devolver un 502
  a toda la llamada MCP por una cabecera malformada.
- **Estado por request sin threading de parámetros.** El contexto de trace
  tiene que estar disponible en `proxyToolCall`, en el fetch pinneado del
  transporte y en el exporter OTLP — sin convertir cada firma en
  `(args, callerToken, opts, traceCtx)`.
- **Tanto upstreams REST como MCP.** El bridge despacha a ambos, y la
  propagación tiene que funcionar para los dos tipos de backend, no solo uno.

## Opciones consideradas

- **A. Solo la cabecera `traceparent` nueva — ignorar `tracestate` y no emitir
  en el saliente.** Rechazada: la mitad de la spec W3C; pierde la información
  de enrutamiento específica de vendor (`tracestate`); el visor de traces del
  upstream no se cose con el del agente.
- **B. Threadear a mano el contexto de trace parseado por cada firma de
  función.** Rechazada: se propaga por más de 5 ficheros (`proxyToolCall`, el
  `pinnedFetch` del transporte del upstream, el exporter OTLP, el middleware de
  request-id, el dispatcher de system-tools); cada firma existente cambia; cada
  test existente tendría que actualizarse.
- **C. Parsear + entrar en un contexto `AsyncLocalStorage` por request; tanto
  el camino entrante como el saliente leen del scope ALS.** Elegida.

## Resultado de la decisión

Opción elegida: **C — `AsyncLocalStorage` (ALS) con parser / serializer W3C
estricto**.

La implementación vive en `src/observability/trace-context.ts`. El flujo:

1. `requestIdMiddleware` parsea el `traceparent` entrante (si lo hay) y el
   `tracestate` (pasado tal cual, con un cap de longitud por vendor), y entra
   en la ejecución ALS durante el resto del ciclo de vida de la request.
2. `startSpan()` hereda el `trace-id` del upstream y registra el `span-id` del
   upstream como su propio parent. El exporter OTLP emite un atributo
   `parentSpanId` para que los visores de traces cosan correctamente.
3. `outboundTraceHeaders()` devuelve el `traceparent` (y el `tracestate` sin
   cambiar) que el bridge debe enviar en su fetch saliente — tanto REST
   (`src/proxy/proxy.ts`) como upstream MCP (el wrapper de fetch a nivel de
   transporte de `src/mcp/mcp-upstream.ts`).
4. Las cabeceras malformadas o ausentes se tratan silenciosamente como "sin
   parent" — nunca un error duro.

El parser maneja cada caso límite que la spec W3C señala: se rechaza el
trace-id todo-a-ceros (por spec, esto significa "inválido"), se rechazan
caracteres no-hex en el id, se toleran versiones futuras de la spec extrayendo
de todos modos la porción de 16 bytes del trace-id, y el byte de versión se
preserva al serializar para que un upstream v00 reciba un saliente v00.

### Consecuencias

- Bueno, porque `mcp_proxy_request_duration_seconds` es ahora correlacionable
  con el trace del upstream en cualquier visor compatible con W3C — un operador
  puede ver exactamente de dónde vino la latencia del bridge (chequeo de auth,
  chequeo de breaker, serialización del body, fetch, decodificación de la
  respuesta).
- Bueno, porque el enfoque ALS añade cero parámetros a cualquier firma
  existente; la migración es mecánica (sin cambios de API pública).
- Bueno, porque el parser estricto rechaza la entrada malformada limpiamente en
  lugar de propagar basura al exporter OTLP.
- Bueno, porque tanto los upstreams REST como MCP están cubiertos por el mismo
  helper, así que futuros transportes (por ejemplo WebSocket) obtienen
  propagación gratis.
- Malo, porque `AsyncLocalStorage` añade un pequeño overhead por request
  (~1–2 µs por lectura ALS, según los docs de Node). A nuestro volumen de
  requests esto es inmensurable, pero conviene saberlo.
- Malo, porque el bridge ahora revela su `trace-id` parent a los backends. Un
  operador que trate los IDs de trace de su backend como secretos tiene que
  confiar en que el upstream no los loguee — la misma exposición que tiene
  cualquier service mesh, pero conviene documentarlo.

### Confirmación

- `src/observability/__tests__/trace-context.test.ts` — 39 tests que cubren
  parse, serialize, round-trip, entradas malformadas (no-hex, todo-a-ceros,
  versión futura, longitud incorrecta, tracestate con claves de vendor), el
  contexto AsyncLocalStorage y el helper `outboundTraceHeaders()`.
- `e2e/mcp-protocol.spec.ts` ejercita un `tools/call` real y el contexto de
  trace sobrevive de extremo a extremo.
- `docs/architecture/slos.md` menciona la correlación de traces como
  prerrequisito para diagnosticar violaciones de SLO en los buckets de
  latencia.

## Más información

- Commit: `aebe04b` — `feat(tracing): W3C traceparent propagation through
proxy pipeline (P1-6)`
- Spec W3C: <https://www.w3.org/TR/trace-context/>
- Código relacionado: `src/observability/trace-context.ts`,
`src/middleware/request-id.ts`, `src/proxy/proxy.ts`,
`src/mcp/mcp-upstream.ts`.
</content>
