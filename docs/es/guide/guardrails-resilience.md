# Guardrails y resiliencia

Cada llamada de tool corre a través de una pila uniforme en el punto de dispatch
(`proxyToolCall`) — consulta el [camino de la request](/es/guide/architecture#el-camino-de-la-request).
Esta página cubre los knobs que se configuran por tool o por cliente.

## Circuit breakers

Cada tool tiene un breaker que se dispara tras fallos repetidos
(`closed → open → half_open`). Mientras está abierto, las llamadas fallan rápido; un único
probe en `half_open` testa la recuperación. Ajusta el umbral de fallos y la ventana de
reset por cliente, o resetea un breaker manualmente desde la página de detalle de un server.

## Guardrails de contenido

Habilita cualquiera de estos en una tool:

- **Reglas de denegación de inputs** — rechaza llamadas cuyos argumentos coincidan con
  patrones configurados.
- **Detección de secretos** — bloquea requests que parezcan llevar credenciales o tokens.
- **Sanitización de responses** — escanea las responses del backend en busca de payloads
  de prompt-injection y envuelve los datos no confiables en un sobre seguro antes de que
  lleguen al modelo.
- **Redacción de campos** — strip de campos sensibles de las responses.
- **Context-budget guard** — trunca deterministamente una tool response demasiado grande,
  u opta por summarization LLM vía un endpoint compatible con OpenAI/Anthropic bring-your-own-key,
  para que una llamada no pueda reventar la context window de un agente.

Los guardrails corren **antes** del circuit breaker de arriba, de modo que una llamada
rechazada nunca consume un slot de probe del breaker.

## Overrides por tool

Define un **rate limit**, **timeout**, **override de circuit-breaker** o restricción
**allowed-key** en cualquier tool individual.

## Políticas de guard reusables

Para evitar repetir el mismo rate limit + timeout en cada tool de un bundle, define una
**guard policy** reusable (solo rate + timeout) una vez y aplícala a todo el bundle.

## Canary y failover

Dale a un cliente REST una URL de backend **secundaria** validada (SSRF-chequeada y
IP-anclada en tiempo de config):

- **canary** — envía un slice ponderado del tráfico al secundario.
- **failover** — enruta al secundario cuando el breaker del primario está abierto,
  **sin** cerrar falsamente el breaker del primario (un éxito del secundario no debe
  enmascarar un outage del primario).

## Caché de responses y load balancing

- **Caché de responses** (opt-in por tool) sirve llamadas idénticas desde memoria;
  delimítalo con `CACHE_MAX_ENTRIES`.
- **Load balancing N-way** reparte un cliente entre varios targets de backend,
  saltándose un target que falló durante `LB_TARGET_COOLDOWN_MS`. Se empareja de forma
  natural con failover.

Siguiente: **[Observabilidad →](/es/guide/observability)** · **[Escalado →](/es/guide/scaling)**
