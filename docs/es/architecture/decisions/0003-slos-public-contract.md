# Los SLOs como contrato público de fiabilidad

- Estado: aceptado
- Fecha: 2026-07-06
- Decisores: CarlxsMG (SRE), Claude Sonnet 5 (revisión)

## Contexto y planteamiento del problema

El bridge expone métricas de Prometheus (`mcp_proxy_request_duration_seconds`,
`mcp_tool_calls_total`, `mcp_health_check_runs_total`, …) y trae un tracer
OTLP, pero **no hay contrato publicado** de lo que significa "el bridge está
funcionando". Los operadores que cablean alertas sobre las métricas tienen que
elegir sus propios umbrales, que inevitablemente derivan entre despliegues y
acaban siendo o demasiado estrictos (páginas ruidosas) o demasiado laxos
(fallos silenciosos).

Peor aún, "¿está arriba?" es una pregunta distinta de "¿está sano el camino de
llamada de tools?", y las métricas existentes las confunden:

- Un 5xx de un backend concreto contamina el histograma de latencia y la tasa
  de error, pero un 5xx de otro backend no lo hace — el histograma mide por
  llamada de tool, no por despliegue.
- La cadena de auditoría tiene una propiedad binaria (verifica, o no).
  Tratarla como un SLO del 99,9 % está mal; o está intacta o no lo está, y el
  segundo estado es una página sev-1, no una métrica sobre la que alertar.

La pregunta: ¿cuál es el conjunto mínimo de SLOs que prometemos a un operador,
anclado en nombres de métricas reales de `src/observability/metrics.ts`, y cómo
los formateamos para que se puedan cablear en un pipeline estándar de alertas
de Prometheus / Grafana?

## Drivers de la decisión

- **Cada SLO debe ser exigible desde las métricas existentes.** Sin métrica
  nueva, sin SLO — si tenemos que añadir instrumentación para medir una
  promesa, la promesa es demasiado cara.
- **Ventana de porcentaje para métricas de throughput, binario para
  invariantes.** La disponibilidad de llamadas de tool es un porcentaje sobre
  una ventana. La integridad de la cadena de auditoría es binaria. Mezclar
  ambas bajo un único marco "99,X %" ocultaría la diferencia.
- **Conservador para 1.0.0.** Este es el primer release etiquetado. Los SLOs
  que prometemos ahora son el suelo; los apretamos trimestralmente, nunca los
  aflojamos.
- **Cableable a una alerta estándar de burn-rate de 4 ventanas.** El patrón
  estándar de la comunidad Prometheus de alerta multi-ventana, multi-burn-rate
  (1h corta, 6h media, 24h larga, 72h muy larga) es el default del operador —
  deberíamos encajar con él.

## Opciones consideradas

- **A. Sin SLOs públicos — los operadores eligen sus propios umbrales.**
  Statu quo. Rechazada: descarga silenciosamente el trabajo a cada operador;
  sin verdad compartida sobre "esto es una regresión".
- **B. Un SLO: "el 99 % de las requests tienen éxito".** Rechazada: colapsa el
  p99 de latencia, la integridad de auditoría y la cobertura de probes en un
  único número que no significa nada en particular.
- **C. Seis SLOs a través de disponibilidad, latencia, descubrimiento,
  auditoría y salud, con la plantilla estándar de alerta de burn-rate de 4
  ventanas.** Elegida.

## Resultado de la decisión

Opción elegida: **C — seis SLOs, cuatro ventanas, cuatro burn-rates**.

El conjunto completo, con la señal de origen desde la que se mide cada SLO (una
métrica real donde el gateway emite una, si no el hueco honesto):

| SLO   | Ventana | Objetivo             | Señal de origen                                                                            |
| ----- | ------- | -------------------- | ------------------------------------------------------------------------------------------ |
| SLO-1 | 30 d    | 99,5 %               | `mcp_tool_calls_total{outcome}`                                                            |
| SLO-2 | 30 d    | p95 ≤ 1 s, p99 ≤ 5 s | histograma `mcp_proxy_request_duration_seconds`                                            |
| SLO-3 | 30 d    | p99 ≤ 500 ms         | _Aún no instrumentado — no se emite span ni métrica de `tools/list` (aspiracional)._       |
| SLO-4 | 30 d    | 99 %                 | `http_requests_total{route=~"/admin-api/.*"}` de un reverse proxy — no lo emite el gateway |
| SLO-5 | 24 h    | 100 % (binario)      | ruta `GET /admin-api/audit-log/verify` (`ok: true`) — no es una métrica                    |
| SLO-6 | 24 h    | ≥ 99 %               | `mcp_health_check_runs_total{outcome}`                                                     |

SLO-1, SLO-2 y SLO-4 usan la formulación estándar de alerta de burn-rate de 4
ventanas (1 h × 14,4× presupuesto, 6 h × 6×, 24 h × 4×, 72 h × 1×) para que los
operadores puedan cablear el ejemplo `PrometheusRule` del doc en su stack sin
inventar umbrales de alerta.

SLO-5 (integridad de la cadena de auditoría) es binario: cualquier lectura
distinta de 1 dispara una página sev-1 de inmediato. No usa burn-rates porque
"cadena de auditoría rota a las 3 AM" no es un problema de quemado lento.

SLO-6 (cobertura de probe de salud) rastrea el loop de auto-eliminación — un
backend que falla su probe de salud es eliminado, así que un probe ausente
significa que un backend está obsoleto pero sigue en el registro.

### Consecuencias

- Bueno, porque cada SLO referencia una métrica existente, así que cablear una
  alerta es un copy-paste del doc a la config de Prometheus del operador.
- Bueno, porque la separación entre ventana-de-porcentaje y binario hace el
  contrato honesto — SLO-5 es "o funciona o no funciona", no un porcentaje
  suavizado que oculta una rotura dura.
- Bueno, porque los umbrales de burn-rate son el estándar de la comunidad; los
  operadores que ya corren alertas multi-ventana obtienen esto gratis.
- Bueno, porque los objetivos son deliberadamente conservadores para 1.0.0; el
  propio doc documenta el proceso de revisión trimestral para apretarlos.
- Malo, porque comprometerse a un número público significa que las futuras
  regresiones son ahora violaciones de contrato, no solo deriva de métricas.
  Una vez publicado un SLO, cada apretón requiere una entrada de CHANGELOG y
  una actualización del doc.
- Malo, porque los objetivos dependen de que el exporter de Prometheus esté
  habilitado. Un operador que deshabilitó `/metrics` (por ejemplo para ahorrar
  carga de scrape) pierde silenciosamente la capacidad de exigir estos SLOs.

### Confirmación

- `docs/architecture/slos.md` y `docs/es/architecture/slos.md` publican los
  objetivos, las señales de origen, las ventanas y las fórmulas de alerta.
- Las métricas detrás de SLO-1, SLO-2 y SLO-6 (`mcp_tool_calls_total`,
  `mcp_proxy_request_duration_seconds`, `mcp_health_check_runs_total`) existen
  en `src/observability/metrics.ts` y las exporta `/metrics` (no hace falta
  cambiar esa ruta). SLO-5 se exige desde la ruta
  `GET /admin-api/audit-log/verify`, no una métrica. SLO-3 (latencia de
  `tools/list`) y SLO-4 (disponibilidad de la admin-API) **aún no están
  instrumentados** por el gateway — SLO-3 no emite span ni métrica hoy, y
  SLO-4 depende de una métrica HTTP de un reverse proxy delante del gateway.
- La propagación de traceparent W3C (ADR-0002) hace que las violaciones de
  buckets de latencia sean diagnosticables desde un único trace — los
  operadores pueden encontrar la llamada lenta, no solo el bucket lento.

## Más información

- Commit: `d2e491f` — `docs(slos): initial public reliability contract (P1-8)`
- Doc: `docs/architecture/slos.md` (y el espejo en español)
- Código relacionado: `src/observability/metrics.ts`,
  `src/observability/tracing.ts`, `src/admin/audit/audit.ts`.
