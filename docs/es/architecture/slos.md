# Objetivos de Nivel de Servicio (SLOs)

> **Estado:** borrador inicial. Los objetivos son **deliberadamente conservadores
> para un gateway self-hosted 1.0.0** — la meta es poner una vara medible, no
> prometer cinco nueves. Apriétalos después del primer trimestre con datos reales
> de producción.

Este documento es el **contrato público de fiabilidad** de MCP REST Bridge. Vincula al
equipo del gateway (quien esté de guardia en la instancia) a una serie de promesas sobre
el servicio, y a los consumidores — usuarios del cliente MCP, operadores y auditores — a
una expectativa clara de qué significa "funciona".

Los SLOs no son SLAs. No hay crédito financiero en este documento; existe para que una
regresión sea un evento medible ("hemos quemado el 20% del presupuesto de error mensual
en 6 horas") en vez de una discusión de corazonadas en un post-mortem.

## Alcance

**Dentro del alcance:** el proceso del gateway en sí — la app Express, el registro, la
pipeline de dispatch, la API admin, el audit log, los bucles de health/leader.

**Fuera del alcance (delegado al dueño del upstream):**

- Fiabilidad de cada backend individual. Un backend que devuelve 5xx se registra en
  `mcp_tool_calls_total{outcome="error"}` pero **no** cuenta contra el presupuesto de
  error del gateway — es el SLO del backend.
- Fiabilidad de la red entre el gateway y un backend. Fallos de health-check atribuibles
  a una partición de red se registran en `mcp_health_loop_errors_total` y
  `mcp_health_check_runs_total{outcome="failure"}` y alimentan el **SLO de cobertura de
  sondas** (§[SLO-6](#slo-6-cobertura-de-sondas-de-health)), no el SLO de tasa de éxito.
- Fiabilidad de la red entre el cliente MCP y el gateway. Terminación TLS, ingress y
  protección DDoS son del operador.
- Corrección del cliente MCP (timeouts, reintentos, parseo).

## Inventario de SLOs

Cada SLO se define como: **ID · objetivo · SLI · target · ventana · presupuesto de error
· alerta**.

La columna de implementación apunta a los **nombres reales de métricas Prometheus que
expone el gateway** (ver `GET /metrics` y `src/observability/metrics.ts`). Los buckets del
histograma de duración son `[0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 30]` segundos.

### SLO-1 — Disponibilidad de tool call

|                          |                                                                                                                                                                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Objetivo**             | Una tool call hecha sobre un cliente sano devuelve una respuesta bien formada — o un payload exitoso, o un error estructurado elegante — dentro del timeout de la llamada.                                                                                                |
| **SLI**                  | `sum(rate(mcp_tool_calls_total{outcome="success"}[30d])) / sum(rate(mcp_tool_calls_total[30d]))`                                                                                                                                                                          |
| **Target**               | **99,5%** de las tool calls tienen éxito en una ventana rodante de 30 días.                                                                                                                                                                                               |
| **Ventana**              | 30 días rodantes.                                                                                                                                                                                                                                                         |
| **Presupuesto de error** | 0,5% del total de tool calls = **~3,6 horas** de llamadas degradadas por mes de 30 días al baseline actual de 1 llamada/seg.                                                                                                                                              |
| **Alerta**               | Ver [alertas de burn-rate](#alertas-de-burn-rate) abajo. El presupuesto de 0,5% se vigila con ventanas de 1 h y 6 h.                                                                                                                                                      |
| **Por qué este número**  | El gateway está mayormente idle en el camino feliz; el 0,5% cubre (a) caídas de backend surfadas como 502/504 rápidos y (b) algún disparo ocasional del breaker. Objetivos más estrictos requieren SLOs por backend y un endurecimiento del half-open del breaker (P0-1). |

Una "respuesta bien formada" es cualquier respuesta que el cliente MCP pueda parsear —
los resultados con `isError: true` **cuentan como éxito** para este SLO, porque el gateway
hizo su trabajo al surfar el fallo limpiamente. Lo que falla el SLO es un timeout (sin
respuesta), un 5xx emitido por el propio gateway, o un crash de proceso.

### SLO-2 — Latencia de tool call

|                           |                                                                                                                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Objetivo**              | Las llamadas sobre clientes sanos vuelven dentro de un presupuesto perceptible, con una cola acotada.                                                                                                                                                   |
| **SLI**                   | `histogram_quantile(0.95, sum(rate(mcp_proxy_request_duration_seconds_bucket[30d])) by (le))` y lo mismo para p99.                                                                                                                                      |
| **Target**                | **p95 ≤ 1 s** y **p99 ≤ 5 s** sobre 30 días.                                                                                                                                                                                                            |
| **Ventana**               | 30 días rodantes.                                                                                                                                                                                                                                       |
| **Presupuesto de error**  | Implícito — cuando el p99 sube de 10 s durante 5 minutos, la alerta salta independientemente del SLO a 30 días.                                                                                                                                         |
| **Alerta**                | p99 > 10 s durante 5 min → page. p95 > 2 s durante 15 min → warn.                                                                                                                                                                                       |
| **Por qué estos números** | El par 1 s / 5 s coincide con los bordes de los buckets del histograma, así cada cuantil es un valor observado real, no una interpolación. Aprieta p99 a 2 s cuando P0-1 (refactor de la pipeline del proxy) y el half-open del breaker estén estables. |

La latencia se mide **en el borde del gateway** — el histograma empieza cuando el handler
`proxyToolCall` arranca y termina cuando la respuesta del upstream se ha recibido
completa. El tiempo en la red cliente MCP → gateway y el TLS **no** se incluye.

### SLO-3 — Latencia de descubrimiento de tools

|                              |                                                                                                                                                                                                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Objetivo**                 | Un cliente MCP que abre sesión y llama a `tools/list` recibe el catálogo lo bastante rápido para sentirse "instantáneo".                                                                                                                                              |
| **SLI**                      | p99 de la duración del handler MCP `tools/list`, observado vía el span OTLP existente `mcp.tools.list` (ver `src/observability/tracing.ts`).                                                                                                                          |
| **Target**                   | **p99 ≤ 500 ms** sobre 30 días.                                                                                                                                                                                                                                       |
| **Ventana**                  | 30 días rodantes.                                                                                                                                                                                                                                                     |
| **Presupuesto de error**     | Implícito.                                                                                                                                                                                                                                                            |
| **Alerta**                   | p99 > 1 s durante 10 min → page.                                                                                                                                                                                                                                      |
| **Por qué es un SLO propio** | `tools/list` es un workload distinto a `tools/call` — lee el registro en memoria, aplica presentation overrides, y manda un payload potencialmente grande. Queremos cazar un registro lento o un regression de payload bloat por separado de la latencia por llamada. |

### SLO-4 — Disponibilidad de la API admin

|                          |                                                                                                                                                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Objetivo**             | Los operadores pueden gestionar el gateway — listar clientes, editar tools, ver el audit log, generar keys, disparar verify.                                                                                    |
| **SLI**                  | `sum(rate(http_requests_total{route=~"/admin-api/.*",status!~"5.."}[30d])) / sum(rate(http_requests_total{route=~"/admin-api/.*"}[30d]))` — usando las métricas HTTP que exporte el gateway o su reverse proxy. |
| **Target**               | **99%** de las peticiones admin devuelven no-5xx sobre 30 días.                                                                                                                                                 |
| **Ventana**              | 30 días rodantes.                                                                                                                                                                                               |
| **Presupuesto de error** | 1% = **~7,2 horas** de estado degradado de la API admin por mes de 30 días.                                                                                                                                     |
| **Alerta**               | Tasa de 5xx > 5% durante 5 min → page.                                                                                                                                                                          |
| **Por qué es más laxo**  | La API admin es operacional, no user-facing. Un presupuesto de 7 horas nos permite capear una ventana entera de despliegue sin abrir incidente.                                                                 |

La latencia de la API admin **no** entra en este SLO. Los operadores toleran páginas admin
lentas; los llamantes a tools no.

### SLO-5 — Integridad de la cadena de audit (binario)

|                          |                                                                                                                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Objetivo**             | El audit log con hash-chain está intacto. El `hash` de cada fila coincide con su contenido y con el `hash` de la fila anterior.                                                                                                |
| **SLI**                  | El endpoint de verify (`GET /admin-api/audit-log/verify` — ver `src/routes/admin/audit-log.ts`) devuelve `ok: true` en cada ejecución.                                                                                         |
| **Target**               | **100%** — sin tolerancia. Un solo verify fallido es sev-1.                                                                                                                                                                    |
| **Ventana**              | Por ejecución. Lánzalo con una schedule (cada hora es un default razonable).                                                                                                                                                   |
| **Presupuesto de error** | **0.** Sin presupuesto.                                                                                                                                                                                                        |
| **Alerta**               | Cualquier resultado `verify: false` → pagea al on-call de seguridad inmediatamente.                                                                                                                                            |
| **Por qué es binario**   | La integridad del audit no es un gradiente — o la cadena es válida o no lo es. El hash-chain es la propiedad que nos permite distinguirlo, así que cualquier fallo es un evento de seguridad, no una regresión de rendimiento. |

Este SLO es un **detector**, no un target a cumplir. La postura operativa correcta es
no ver nunca saltar la alerta; si salta, el post-mortem es "¿qué se modificó y por
quién?".

### SLO-6 — Cobertura de sondas de health {#slo-6-cobertura-de-sondas-de-health}

|                          |                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Objetivo**             | El bucle de health-check gated por leader sondea cada backend esperado cerca de su cadencia programada.                                                                                                                                                                                                                                                   |
| **SLI**                  | `sum(rate(mcp_health_check_runs_total[24h])) / (sondas_esperadas_por_segundo * 86400)`, donde `sondas_esperadas_por_segundo = (# clientes registrados) / HEALTH_CHECK_INTERVAL_MS * 1000`.                                                                                                                                                                |
| **Target**               | **≥ 99%** de las sondas esperadas se completan en 24 h.                                                                                                                                                                                                                                                                                                   |
| **Ventana**              | 24 h rodantes.                                                                                                                                                                                                                                                                                                                                            |
| **Presupuesto de error** | 1% de slots de sonda fallidos = ~14 min/día en el conjunto de clientes.                                                                                                                                                                                                                                                                                   |
| **Alerta**               | Cobertura < 95% durante 30 min → page. `mcp_health_loop_errors_total` incrementando (errores no manejados en el bucle) → page.                                                                                                                                                                                                                            |
| **Por qué existe**       | El leader es el único nodo que sondea backends. Si el leader se atasca, el gateway deja de evictar backends muertos y las tool calls siguen dando timeout hasta que algo más lo note. El contador `mcp_health_loop_errors_total` es la señal de aviso temprana — cualquier incremento significa que el bucle se está tragando excepciones que no debería. |

## Alertas de burn-rate

La formulación clásica de burn-rate en 4 ventanas (del workbook de Google SRE) caza
tanto el consumo rápido como el lento del presupuesto:

| Burn rate | Ventana | Alerta     | Significa                                                                      |
| --------- | ------- | ---------- | ------------------------------------------------------------------------------ |
| **14,4×** | 1 h     | **Page**   | 2% del presupuesto de 30 días gone en una hora. Algo está ardiendo.            |
| **6×**    | 6 h     | **Page**   | 1% gone en 6 h. Degradación sostenida.                                         |
| **1×**    | 24 h    | **Ticket** | 5% del presupuesto de 30 días gone en un día. No es un fuego; tampoco está OK. |
| **1×**    | 72 h    | **Ticket** | Quema lenta. Suele ser un regression que gotea.                                |

Se calculan como:

```promql
# burn de 1h al umbral 14,4x, para SLO-1
(
  1 - (
    sum(rate(mcp_tool_calls_total{outcome="success"}[1h]))
    /
    sum(rate(mcp_tool_calls_total[1h]))
  )
) / 0.005 > 14.4
```

…con las variantes análogas `6h / 6`, `24h / 1` y `72h / 1`. Implementa esto en
Prometheus / Grafana; el gateway no emite alertas de burn por sí mismo.

**Por qué multi-ventana.** Una ventana única de 30 días esconde un día caliente dentro
de un mes con holgura. El alerting multi-ventana caza una caída del lunes por la mañana a
tiempo de hacer algo, no un mes después cuando el presupuesto ya está agotado.

## Lo que **no** SLO-amos (y por qué)

- **Latencia, tasa de éxito o tamaño de payload por backend.** Es el SLO del dueño del
  backend. El gateway puede surfarlo; no puede prometerlo.
- **Corrección del protocolo MCP.** El `@modelcontextprotocol/sdk` se encarga del
  framing; el test e2e de protocolo MCP (`e2e/mcp-protocol.spec.ts`) cubre el
  round-trip. Si falla, es un bug, no un miss de SLO.
- **Time-to-first-byte desde cold start.** Proceso Bun único, arranque sub-segundo en la
  práctica. Si el cold start se vuelve user-visible algún día, le haremos su propio SLO.
- **"El dashboard carga en menos de 2 s."** La latencia de la admin-ui es una
  preocupación de UX, no de fiabilidad — trátalo en el repo de admin-ui, no aquí.

## Revisar y cambiar SLOs

- **Trimestral.** Revisa los números reales de 30 días, mira si algún target se falla
  consistentemente (target demasiado estricto) o se supera consistentemente por 10×
  (target demasiado laxo). Ajusta el target, no la métrica.
- **Nunca aflojes un target para que una outage actual "encaje".** Si se está fallando
  el SLO, está haciendo su trabajo. Abre un incidente.
- **Apretar requiere conversación con stakeholders** — la gente que depende del SLO debe
  estar de acuerdo en que la nueva vara es alcanzable, si no creas una cola crónica de
  incidentes.
- **Documenta el cambio** en `CHANGELOG.md` y enlaza el PR que ajusta el target.

## Referencias

- `docs/guide/observability.md` — inventario de métricas, lista de alertas, formato del
  audit log.
- `docs/guide/scaling.md` — leader election, bucle de health, y qué significa
  "horizontal" para este gateway.
- `docs/guide/guardrails-resilience.md` — circuit breakers, rate limiters, canary.
- `src/observability/metrics.ts` — cada nombre de métrica y label de este doc, definido
  ahí.
- `src/admin/audit/audit.ts` — construcción del hash de la cadena de audit y ruta de
  verify.
- [Google SRE Workbook, cap. 5 — "Reliable Design" burn-rate alerting](https://sre.google/workbook/alerting-on-slos/).
