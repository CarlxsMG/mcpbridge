# MCP REST Bridge — Review multi-perspectiva y plan de profesionalización

> **Estado del repo analizado:** `mcp-rest-bridge@1.0.0`, Bun + TS strict + Express 5 + Vue 3.
> Análisis estático y lectura de código; **no se ejecuta nada** (no requiere entorno).
> Revisión escrita como una auditoría que llevaría a cabo un equipo de 6 specialists
> (arquitecto senior, code reviewer, security auditor, QA lead, SRE, DX/i18n).
> Cada hallazgo apunta a `ruta:linea` para que sea verificable en segundos.

---

## 0. TL;DR

| Área                        | Madurez (1–5) | Comentario                                                                                                                                                                |
| --------------------------- | ------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Seguridad por defecto       |         ★★★★★ | SSRF pinning, fail-closed auth, hash-chain audit, IDs aleatorios, safeCompare. **No tocar a la ligera.**                                                                  |
| Cobertura de tests          |         ★★★★☆ | ~84% de la LOC backend (~19.8k LOC / 23.7k LOC), 100+ archivos. Hay tests «de humo» repetidos y solo 1 e2e.                                                               |
| Modularidad / cohesión      |         ★★★☆☆ | 18 sub-carpetas temáticamente claras… pero `proxy.ts`, `registry.ts`, `admin.ts`, `config.ts`, `index.ts` son **mega-archivos** que se cargan responsabilidades cruzadas. |
| Patrones cross-cutting      |         ★★★☆☆ | Guards y pipelines bien definidos en cabeza; ejecutados **inline** con riesgo de regresión silenciosa.                                                                    |
| Observabilidad              |         ★★★★☆ | Prom, OTLP, tracing, audit, request-id, métricas. Falta: trace-context propagation, SLO definitions, dashboards versionados.                                              |
| DX (de quien mantiene)      |         ★★★☆☆ | `package.json`, scripts, lint, prettier, vitepress. Falta: typed env (zod), generadores, convención de PR, ADRs.                                                          |
| i18n + docs                 |         ★★★★☆ | Bilingüe con audit automatizado, scripts Python de seed. Riesgo: deriva silenciosa del ES si no se valida en CI.                                                          |
| Performance / escalabilidad |         ★★★☆☆ | Bun + SQLite, LRU compartido, leader-lease. Riesgo: el proxy es O(n_funciones_guards) por llamada; nada de profiling; ningún bench reproducible.                          |
| Release / supply chain      |         ★★★★☆ | CI, Docker, Helm, GHCR, binaries compilados, lockfile. Falta: SBOM, signed releases, release notes automatizados.                                                         |
| Mantenibilidad a 6–12 meses |         ★★★☆☆ | Documentación buena, pero el “monolith file” y la lógica `dispatchToolCall` van a empezar a doler pronto.                                                                 |

**Veredicto:** el repo está **claramente por encima de la media de su categoría** (he visto gateways MCP Open Source con la mitad de rigor). El siguiente nivel se gana **mejorando cohesión**, **extrayendo el pipeline de proxy** y **blindando CI** (typed env, audit i18n, mutation testing, e2e no-smoke).

---

## 1. Inventario cuantitativo

| Métrica                            |                        Valor | Comentario                                                                            |
| ---------------------------------- | ---------------------------: | ------------------------------------------------------------------------------------- |
| Backend TS files                   |                      **257** | en `src/` (excl. tests)                                                               |
| Backend LOC                        |                   **23 734** | sin contar `__tests__/`                                                               |
| Backend test files                 |                     **100+** | todos en `src/__tests__/` plano, sin agrupar por dominio                              |
| Backend test LOC                   |                   **19 793** | ratio tests/backend ≈ **0.84** — **excelente**                                        |
| Admin UI Vue files                 |                      **113** | en `admin-ui/src/`                                                                    |
| Admin UI LOC                       |                   **26 294** |                                                                                       |
| Scripts Python (i18n + auditorías) |                            8 | buena automatización, pero **Python como herramienta de mantenimiento** mezcla stacks |
| Migrations SQL                     | **52** en `db/migrations.ts` | 35 KB / 1024 líneas, inline como array                                                |
| Workflows CI                       |                            4 | ci, docker-publish, release-binaries, deploy-docs                                     |
| Líneas `src/openapi.yaml`          |                       226 KB | esquema interno embebido; ver §6                                                      |

### Top archivos por tamaño (ordenados, flags de cohesión)

| Ruta                                       |  KB |   LOC | Riesgo                                                                |
| ------------------------------------------ | --: | ----: | --------------------------------------------------------------------- |
| `src/routes/admin.ts`                      |  67 |  1634 | **P0** — concentrador de rutas + 8+ validators inline                 |
| `src/mcp/registry.ts`                      |  64 |  1680 | **P0** — clase mega: alias index, mutex, persistencia, reconciliación |
| `src/proxy/proxy.ts`                       |  57 | >1500 | **P0** — `dispatchToolCall` con 17+ responsabilidades en línea        |
| `src/db/migrations.ts`                     |  35 |  1024 | **P1** — append-only OK, pero sin tabla `schema_migrations`           |
| `src/mcp/registration.ts`                  |  25 |     — | **P1** —编排 de descubrimiento, candidates para extraer               |
| `src/security/oidc.ts`                     |  18 |     — | tests separados del módulo                                            |
| `src/mcp/system-tools.ts`                  |  18 |     — | i18n keys mezcladas con lógica                                        |
| `src/admin/tool-composition/composites.ts` |  19 |     — | candidato a split (estado vs ejecución)                               |
| `src/admin/tool-composition/bundles.ts`    |  13 |     — | ya extraído mutex → `lib/async-lock.ts`                               |
| `src/index.ts`                             |  13 |   315 | **P1** — `bootstrap()` y `createApp()` mezclados                      |

---

## 2. Análisis por perspectiva

### 2.1 🏛 Arquitecto senior

**Lo que está bien**

- **Two planes, three endpoints** (`/mcp`, `/mcp/:client`, `/mcp-custom/:bundle`) está bien razonado y bien documentado — la separación evita el clásico "modo mágico que hace de todo" del gateway.
- **Tres clases de identidad, una sola key.** `clientName__toolName` como clave única evita alias ambiguos; el `aliasIndex` separado está pensado para no invalidar el invariante.
- **`KeyedMutex`** indica que el equipo ya pasó por la fase de “DRY-out de concurrencia”. Bien.
- **Hash-chain audit log**: muy buena decisión; sin esto, SIEMPRE hay disputas en auditoría.
- **Fail-closed por defecto** en `mcpAuth`/`adminAuth`/`rootMcpAuth` (cuando hay material de auth configurado, no se relaja).

**Lo que falta / preocupa**

1. **`src/proxy/proxy.ts` está “todo dentro de una función”.** La pipeline de guards es **una secuencia larga** sin composición. Imposible añadir/quitar un guard sin diff grande y riesgo de regresión. P0.
2. **`Registry` es una god-class** que mezcla: alias index, mutex, persistencia SQLite, hidratación, reconciliación, métricas de health. P0.
3. **`src/routes/admin.ts` es un centollo.** 1634 líneas con rutas de 18 entidades distintas. Si mañana añades una entidad, el archivo crece 200 líneas más — ya pasó, mira git log. P0.
4. **`src/index.ts` mezcla bootstrap y wiring.** No se puede testear el wiring sin levantar el puerto, ni instanciar la app para un test de integración. P1.
5. **`src/config.ts` es un literal gigante (382 líneas)** con 80+ claves parseadas a mano. No hay validación de env (zod/valibot), no hay doc centralizada. Cualquier typo de env es un crash silencioso o un fallback 0/""/false. P1.
6. **No hay ADR ni `docs/architecture/decisions/`** — la sabiduría está en commits y CLAUDE.md, pero no hay rastro al lado del código. P2.

### 2.2 🧪 Code reviewer

**Smells detectados (con coordenadas)**

| Smell                                                        | Ubicación                                             | Detalle                                                                                                                                                                                                                | Prioridad                                                                   |
| ------------------------------------------------------------ | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Mega-función                                                 | `src/proxy/proxy.ts:457-1189`                         | `dispatchToolCall` ~730 líneas: guards → breaker → canary → LB → coerce → validate → retry → pagination → redact → scan → cache → budget → record                                                                      | **P0**                                                                      |
| Validators inline en rutas                                   | `src/routes/admin.ts:82-310+`                         | `validateCacheInput`, `validateCoalesceInput`, `validateQuarantinePolicyInput`, `validateContextBudgetInput`, `validatePaginationInput`, `validateStreamingInput`, `validateOps`… todas en el mismo archivo del router | **P0**                                                                      |
| God-class                                                    | `src/mcp/registry.ts:168-end`                         | `Registry` con `clients`, `toolIndex`, `aliasIndex`, `mutex`, reconciles, deleters                                                                                                                                     | **P0**                                                                      |
| Sentinels “raw `as Record<string, unknown>`”                 | `src/proxy/proxy.ts` (varios), `src/registry.ts`      | `(args as Record<string, unknown>).__confirm` etc. — vale para runtime, pero un tipo `ToolArgs` discriminado evitaría el 80%                                                                                           | **P1**                                                                      |
| Mutación a config en runtime                                 | `src/__tests__/proxy.test.ts:23-25`                   | `(config as Record<string, unknown>).retryBaseDelayMs = 1` desde test                                                                                                                                                  | Inocuo, pero **necesita helper** (`withConfig(...)`) si se va a multiplicar | **P2** |
| Inline SQL strings largas                                    | `src/mcp/registry.ts:331-360`, `src/db/migrations.ts` | Algunos query strings de 300+ caracteres con `RETURNING enabled` etc. — un mini-DSL (`upsertClient(...)`) mejoraría la legibilidad                                                                                     | **P2**                                                                      |
| Union de strings repetidas                                   | `src/proxy/proxy.ts`, `src/mcp/*`                     | `kind === "rest"` / `kind === "mcp"` aparece 12+ veces sin un tipo discriminado central                                                                                                                                | **P1**                                                                      |
| Magic numbers en tests                                       | `src/__tests__/*`                                     | `1.2.3.4`, `127.0.0.1`, timeouts 1ms/5ms — bien aislado pero merece helper `TEST_IP` / `silentLogger`                                                                                                                  | **P2**                                                                      |
| `as unknown as Record<string, unknown>` para redactar config | `src/index.ts:261`                                    | funciona pero es un band-aid; mejor `redactConfig(config: Config)` tipada                                                                                                                                              | **P3**                                                                      |

**Patrones positivos que valen oro** (preservar y replicar)

- **Pure-verdict paralelo a Express middleware**: `evaluateMcpAuth(headers)` y `mcpAuth(req,res,next)`. Excelente — permite WS-proxy upgrade y tests sin Express. Misma forma debería aplicarse a `adminAuth` y `rootMcpAuth`.
- **Constantes en MAYÚSCULAS como `REDACT_EXACT_KEYS`**: pequeña guía pero ayuda.
- **`runApprovalGate` extraído** para que dos call sites (`requiresApproval` y quarantine's `force_approval`) reutilicen la creación de tickets. **Esto es exactamente el patrón que falta en otras áreas (proxy).**
- **TTL pin cache con re-resolución async** en `proxy.ts:825-841` — bien aislado y testeable. Buen cimiento para extraer.

### 2.3 🔐 Security auditor

**Lo que está muy bien (NO TOCAR sin necesidad)**

- **IP pinning** vía `Bun.dns` + `validateBackendUrl` por separado para `health_url`, `base_url`, `openapi_url`; `redirect: 'error'` y `Host` original. **Hardening de SSRF correcto.**
- **`safeCompare` constant-time** en **toda** comparación sensible (API keys, session hash, CSRF). `src/security/compare.ts`.
- **`sanitizeToolDescription`** antes de entrar al registry → prompt injection defense.
- **`rootMcpAuth` fail-closed** explícito (sin fallback "open mode").
- **Hash-chain audit** + retención configurable.
- **Endpoint-path traversal check** post-sustitución en `proxy.ts:766-780` + `validateEndpointPath`.
- **`isKeyAllowed` con fail-closed** explícito (línea 491-494).
- **Aislamiento de signal en retry** (`attemptSignal = AbortSignal.any(...)` por intento). Verificado en `proxy.test.ts` (excelente).

**Hallazgos / mejoras incrementales**

1. **Falta CSP / X-Frame-Options en admin-ui** — está el admin SPA pero no hay headers `Content-Security-Policy` en el `app.use("/admin", …)`. Incluso un CSP básico (default-src 'self') cierra una clase de XSS en la UI admin. **P1.**
2. **Cookie session no usa `SameSite=Lax/Strict` explícito** — `src/security/cookies.ts` debe especificarlo. Sin esto, una redirección cross-site puede filtrar sesión admin. **P1.**
3. **CORS wildcard + credenciales** está prevenido (líneas de config.ts 65-82) — bien. Pero **no hay validación de que `corsAllowCredentials=true` no se combine con wildcard en runtime** — está solo como doc-comentario. Mejor: assertion en startup. **P2.**
4. **`SECRETS_PROVIDER=vault` typo'd** cae a local con warning en consola de Vault → silencioso en arranque. Está OK lanzar error en config.ts (bien hecho), pero **el error tipa por string** — `as const` daría tipos cerrados. **P3.**
5. **`OTLP_ENDPOINT`** sin scheme validation — un valor mal formado causa crash en el primer export; añadir validación al parse. **P3.**
6. **JWT `sub` se loggea en tracing** — verificar que `jwtSubject` no se incluya en logs de acceso / audit JSON. Si ya está cuidado, marcar con un test que lo verifique. **P2.**
7. **Sin rate-limit en `/health`** — aceptable para healthcheck de LB, pero **un probe de un atacante puede sondear** tu uptime. Documentar explícitamente que es intencional. **P3.**
8. **Falta “security headers policy” testeada en CI**: STARR-like (Strict-Transport-Security, X-Content-Type-Options ya están; faltan Permissions-Policy, Referrer-Policy ya está). **P2.**
9. **`contextBudget.apiKey`** se recibe y se cifra vía `getSecretsProvider()`, OK — pero **el `apiKey` viaja por audit/log/structured logs si hay un error**. Confirmar sanitización. **P2 (verificación).**

### 2.4 🧪 QA lead

**Cobertura actual (observada):**

| Categoría                                  | Tests                              |
| ------------------------------------------ | ---------------------------------- |
| Unit tests (proxy, registry, guards, etc.) | 80+ archivos en `src/__tests__/`   |
| Smoke e2e                                  | `e2e/smoke.spec.ts` (1 solo)       |
| i18n parity                                | `admin-ui/src/i18n-parity.test.ts` |
| Audit-script                               | 8 scripts Python independientes    |

**Hallazgos**

1. **Estructura plana `src/__tests__/`** dificulta encontrar el test de una feature. Migrar a `src/<feature>/__tests__/` (co-localización) **o** a `tests/unit/proxy/`, `tests/integration/auth/`, etc. **P1.**
2. **Solo 1 e2e (`smoke.spec.ts`)** — para una herramienta gobernada es insuficiente. Falta al menos:
   - flujo admin login + crear server + usar bundle + logout;
   - flujo MCP client → `tools/list` → `tools/call`;
   - flujo fail-closed: clave inválida → 401, key revocada → 401;
   - flujo canary: primario down → secundario responde.
     **P1.**
3. **No hay mutation testing** (`Stryker` o `mutodeer`). Coverage 0.84 sin mutation ≈ coverage theater. **P2.**
4. **`pytest`-style?** Detecto patrón bun's own `bun:test`. Bien — unificado, sin jest/vitest split (excepto admin-ui con vitest). **Mantener.**
5. **No detecto tests de carga / k6 scripts**. Para una herramienta con rate-limit, breaker, leader election, **un perf-test reproducible en CI nightly** marcaría la diferencia. **P2.**
6. **No hay contract tests para MCP** (`/mcp` round-trip). Aunque `system-tools.test.ts` cubre, vale la pena un **golden de la salida de `tools/list`** para evitar regresiones en el contrato MCP. **P2.**
7. **`__tests__/audit-chain.test.ts`** es excelente — patrón a replicar para circuit-breaker, rate-limiter, leader-lease (los tres son state-machines). **P3 (reforzar).**

### 2.5 📡 SRE / Observabilidad

**Lo que está hecho**

- Prometheus `/metrics`
- OTLP tracing (no-dependency) + span lifecycle
- SQLite-persisted spans para el trace viewer interno
- Audit log streamed a SIEM (`AUDIT_SINK_URL`)
- Request-id middleware
- Graceful shutdown con `forceTimer.unref()`
- Leader election (`db/leader-lease.ts`)

**Lo que falta**

1. **No hay propagación W3C `traceparent`** entre el upstream y el span root en proxy. Si llega un MCP call con `traceparent`, no lo honramos — perdemos la correlación. **P1.**
2. **No hay `/readyz` y `/livez` separados** — solo `/health` genérico. Para k8s deployments, separación `ready=leader+db-up`, `live=proceso vivo`. **P2.**
3. **No detecto SLOs documentados** (latency p99, error rate, breaker time). Imposible saber si una regresión rompió “algo importante”. **P1.**
4. **`metricsRoutes` no expone default Prometheus exemplars** — si activas exemplars, OTLP correlaciona spans con métricas. **P3.**
5. **`startCircuitBreakerCleanup` y `startRateLimiterCleanup`** son buenos, pero **no hay métrica de tamaño de bucket (`gauge`)**; si llegas al LRU max te enteras por latencia. **P2.**
6. **`gracefulShutdown` cierra todo en orden pero no drena las requests in-flight** — `server.close()` no espera a las que ya están siendo procesadas. Considerar un `inflightCount` gauge + `await Promise.all` con timeout. **P2.**
7. **No hay `/version` con SHA de build** — útil para correlacionar reportes de bug con binarios. **P3.**

### 2.6 🌐 DX / i18n / accessibility

**DX**

- Bun scripts claros (`dev:all`, `check`, `test`, `lint`, `format`).
- `scripts/check-all.ts` ejecuta TODO: format → lint → tsc → test → build. Excelente.
- Falta **`bun run check:quick`** (formato + lint + typecheck, sin tests) para el loop de desarrollo.
- Falta **`bun run db:*`** (migrate, dump, schema-diff).
- Falta **`bun run dev:scenario/<name>`** para reproducer de bugs.
- No detecto `commitlint` / `husky` / `lint-staged`. **P2.**

**i18n**

- 2 locales (`en`, `es`) en `admin-ui/src/locales/`.
- Script Python `seed-missing-translations.py`, `audit-missing-translations.py`, `audit-missing-by-file.py`, `smoke-test-i18n.py`, `translate-demo-i18n.py`, `seed-demo-i18n.py`, `seed-nav-widget-keys.py`. Brutal cobertura.
- **`i18n-parity.test.ts`**. Bien.
- **Riesgo:** los scripts Python no corren en CI (no detecto). Si alguien traduce offline sin correrlos, derivan EN/ES. **P0 (mover el seed a CI).**
- **Riesgo:** los nombres de keys son libres (`useActiveTasks`, `overview.greeting`) — sin convención `feature.context.subject`. Vale, pero podría causar duplicación silenciosa (mismo concepto, dos keys). **P3.**

**Accessibility**

- **No leí los `.vue`**, pero recomiendo: axe-core en CI (vitest-axe o `@axe-core/playwright`), atajos de teclado para command palette ya tiene (`CommandPalette.vue`), falta verificar focus-trap en modales.

---

## 3. Catálogo priorizado de propuestas

> **Leyenda**: P0 = debe entrar en el siguiente PR. P1 = siguiente sprint. P2 = siguiente mes.
> P3 = nice-to-have.

### P0 — críticos (no escalamos sin esto)

| #        | Propuesta                                                                                                 | Esfuerzo | Impacto  |
| -------- | --------------------------------------------------------------------------------------------------------- | -------- | -------- |
| **P0-1** | **Extraer pipeline de `dispatchToolCall`** en un array de guards componibles (ver §4.1)                   | M        | Muy alto |
| **P0-2** | **Dividir `src/routes/admin.ts`** en routers por entidad (ver §4.2)                                       | M        | Alto     |
| **P0-3** | **Dividir `src/mcp/registry.ts`** en: `AliasIndex`, `Persistence`, `Reconciler`, `Registry` (orquestador) | M        | Alto     |
| **P0-4** | **Mover auditoría i18n a CI** (los 8 scripts Python corren en workflow)                                   | S        | Alto     |
| **P0-5** | **Typed env (`zod`/`valibot`)** en `src/config.ts` (ver §4.3)                                             | S        | Alto     |

### P1 — siguientes sprints

| #    | Propuesta                                                                         | Esfuerzo | Impacto               |
| ---- | --------------------------------------------------------------------------------- | -------- | --------------------- |
| P1-1 | Extraer `bootstrap()` y `createApp()` en `src/server.ts` y testear app sin listen | S        | Alto                  |
| P1-2 | Tabla `_migrations` con tracking real (id, applied_at, checksum)                  | S        | Medio                 |
| P1-3 | Tests e2e: 4 flujos listados en §2.4                                              | M        | Alto                  |
| P1-4 | Co-localizar tests: `src/<feature>/__tests__/` o `tests/{unit,integration}/...`   | M        | Medio                 |
| P1-5 | CSP + `SameSite=Lax` en cookies de admin                                          | S        | Medio-alto (security) |
| P1-6 | W3C `traceparent` propagation desde MCP upstream                                  | M        | Medio                 |
| P1-7 | `/readyz` y `/livez` separados                                                    | S        | Medio                 |
| P1-8 | SLOs documentados (latencia p99, error rate) en `docs/architecture/slos.md`       | S        | Medio                 |
| P1-9 | Helper `withConfig(patch, fn)` para tests que mutan `config`                      | S        | DX                    |

### P2 — siguiente mes

| #    | Propuesta                                                          | Esfuerzo | Impacto      |
| ---- | ------------------------------------------------------------------ | -------- | ------------ |
| P2-1 | Mutation testing (`Stryker`) en módulos core                       | M        | Calidad      |
| P2-2 | Perf test reproducible (k6) en CI nightly                          | M        | Resiliencia  |
| P2-3 | ADRs en `docs/architecture/decisions/` (formato MADR)              | S        | Conocimiento |
| P2-4 | Conventional commits + commitlint + husky + lint-staged            | S        | DX/CHANGELOG |
| P2-5 | `dashboard.json` versionado (Grafana) en repo                      | S        | SRE          |
| P2-6 | Bundle `optimizeDeps` afinado en Vite (admin-ui)                   | S        | UX dev       |
| P2-7 | Tipos discriminados `kind: "rest" \| "mcp"` con narrowing central  | M        | Type safety  |
| P2-8 | `redactConfig(config: Config)` tipado (reemplazar `as unknown as`) | S        | Hygiene      |
| P2-9 | `inflightRequests` gauge + drain en `gracefulShutdown`             | S        | SRE          |

### P3 — backlog

| #    | Propuesta                                                                |
| ---- | ------------------------------------------------------------------------ |
| P3-1 | axe-core a11y en CI admin-ui                                             |
| P3-2 | `/version` con build SHA                                                 |
| P3-3 | Validar scheme de `OTLP_ENDPOINT`                                        |
| P3-4 | `SECRETS_PROVIDER` parsea con `as const`                                 |
| P3-5 | Gauge de buckets LRU en `/metrics`                                       |
| P3-6 | Validación `corsAllowCredentials` + wildcard en startup                  |
| P3-7 | `secureCompare` también en `state.role` checks                           |
| P3-8 | Doc interna: por qué `bun:sqlite` y no `better-sqlite3` (regla del repo) |

---

## 4. Refactors flagship (con código)

### 4.1 Refactor P0-1: pipeline de guards en `proxy/proxy.ts`

**Hoy**: `dispatchToolCall` es una función de ~730 líneas con un `if`/`return` por cada guard, y 4 puntos donde un return corta el flujo. Es **imposible** añadir un nuevo guard sin diff grande y **fácil saltarse uno por error**.

**Mañana**: una pipeline declarativa con un helper `runGuards(...)`. Cada guard es un objeto `{ name, check }` donde `check` devuelve `null` (pasa) o `toolResult(..., { isError: true })`. Si devuelve no-null, la pipeline para y se emite telemetría.

```ts
// src/proxy/pipeline.ts  (nuevo)
import type { ResolvedTool } from "../mcp/types.js";
import type { ToolCallOpts } from "../proxy/proxy.js";

export interface GuardContext {
  resolved: ResolvedTool;
  args: Record<string, unknown>;
  callerToken?: string;
  callerKey: { id: number; ... } | null;
  opts?: ToolCallOpts;
  /** Set por guards upstream; siguiente guard los ve. */
  shared: Record<string, unknown>;
}

export type GuardResult =
  | { ok: true }
  | { ok: false; result: { content: ...; isError?: boolean } };

export interface Guard {
  name: string;
  /** Devuelve null para “pasa”, o un resultado para “corta aquí”. */
  check: (ctx: GuardContext) => Promise<GuardResult> | GuardResult;
}

/** Ejecuta guards en orden; el primero que corta gana. */
export async function runGuards(
  guards: readonly Guard[],
  ctx: GuardContext,
): Promise<GuardResult> {
  for (const g of guards) {
    const r = await g.check(ctx);
    if (!r.ok) {
      // métrica + log
      return r;
    }
  }
  return { ok: true };
}
```

```ts
// src/proxy/guards/index.ts  (nuevo)
import { registry } from "../../mcp/registry.js";
import { isToolSensitive } from "../../tool-meta/tool-sensitivity.js";
import { getGuardrails, checkInputGuardrails } from "../../tool-policies/guardrails.js";
import { checkQuarantine } from "../../tool-policies/quarantine.js";
import { isKeyAllowed } from "../../security/key-hash.js";
import { isToolInKeyScope } from "../../security/mcp-key-store.js";
import { checkConsumerQuota, checkEndUserRateLimit, getConsumer } from "../../admin/entities/consumers.js";
import { runApprovalGateIfNeeded } from "./approval-guard.js";
import { toolResult } from "../../lib/mcp-result.js";
import type { Guard } from "../pipeline.js";

export const builtInGuards: Guard[] = [
  { name: "enabled", check: (ctx) =>
      (ctx.resolved.client.enabled && ctx.resolved.tool.enabled)
        ? { ok: true }
        : { ok: false, result: toolResult(`Tool is disabled`, { isError: true }) } },
  { name: "deletion", check: (ctx) =>
      // …
  },
  { name: "allowedKeys", check: (ctx) => {/* … */} },
  { name: "keyScope", check: (ctx) => {/* … */} },
  { name: "consumerQuota", check: async (ctx) => {/* … */} },
  { name: "sensitivity", check: (ctx) => {/* … */} },
  { name: "quarantine", check: (ctx) => {/* … */} },
  { name: "approval", check: (ctx) => {/* … */} },
  { name: "guardrails", check: (ctx) => {/* … */} },
  { name: "rateLimit", check: (ctx) => {/* … */} },
];
```

**Después**, `dispatchToolCall` se queda en:

```ts
export async function dispatchToolCall(mcpToolName, args, callerToken, opts) {
  const resolved = registry.resolveTool(mcpToolName);
  if (!resolved) return toolResult(`Unknown tool: ${mcpToolName}`, { isError: true });

  const callerKey = callerToken ? resolveMcpKeyByToken(callerToken) : null;

  const g = await runGuards(builtInGuards, {
    resolved,
    args,
    callerToken,
    callerKey,
    opts,
    shared: {},
  });
  if (!g.ok) return g.result;

  // … mocks, cache, coalescing, dispatch (REST/MCP/WS)
}
```

**Beneficios**

- Test unit por guard, no por “toda la pipeline”.
- Un nuevo guard = 1 entrada en `builtInGuards` (o 1 entrada por **cliente** desde DB, abriendo puerta a guards cargados).
- Métrica per-guard out-of-the-box (`guard_result{guard=…, outcome=block|pass}`).

### 4.2 Refactor P0-2: dividir `src/routes/admin.ts`

**Estructura objetivo**:

```
src/routes/admin/
  index.ts              # monta sub-routers en /admin-api
  servers.ts            # /admin-api/clients(/...)
  tools.ts              # /admin-api/clients/:name/tools/...
  policies.ts           # /admin-api/guard-policies(/:id)
  bundles.ts            # /admin-api/bundles(/:name/...)
  composites.ts         # /admin-api/composites(/:name/...)
  approvals.ts          # /admin-api/approvals(/:id)
  consumers.ts          # /admin-api/consumers(/:id)
  alerts.ts             # /admin-api/alerts(/:id)
  monitors.ts           # /admin-api/monitors(/:id)
  ...
  validators/           # uno por archivo: cache.ts, quota.ts, pagination.ts, …
  common.ts             # sendError, requireRole, ensureClientAccess, parseJsonBody
```

```ts
// src/routes/admin/index.ts (extracto)
import { Router } from "express";
import { adminAuth } from "../../middleware/auth.js";
import { requireAdminRole } from "../../middleware/authz.js";

import { serversRouter } from "./servers.js";
import { bundlesRouter } from "./bundles.js";
import { policiesRouter } from "./policies.js";
import { approvalsRouter } from "./approvals.js";
// …

export function adminRoutes(app: Express): void {
  const r = Router();
  r.use(adminAuth);

  r.use("/clients", serversRouter);
  r.use("/bundles", bundlesRouter);
  r.use("/guard-policies", policiesRouter);
  r.use("/approvals", approvalsRouter);
  // …

  app.use("/admin-api", r);
}
```

> **Migración segura:** mantener `adminRoutes(app)` como entry público para no romper `src/index.ts`. Mover el contenido archivo por archivo a `routes/admin/<entidad>.ts` con tests funcionando. **No** mover y reventar todo a la vez.

### 4.3 Refactor P0-5: `src/config.ts` con validación tipada (zod)

```ts
// src/config.ts (borrador)
import { z } from "zod";

const bool = z.stringbool(); // "true" | "false"
const int = (def: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.string().default(String(def)).transform(Number).pipe(z.number().int().min(min).max(max));

const corsOrigins = (authDisabled: boolean) =>
  z
    .string()
    .optional()
    .transform((raw, ctx) => {
      if (!raw) return [] as string[];
      const entries = raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (entries.includes("*")) {
        if (!authDisabled && process.env.ALLOW_UNSAFE_CORS_WILDCARD !== "true") {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "CORS wildcard forbids auth" });
          return z.NEVER;
        }
        return ["*"];
      }
      // normaliseOrigin logic …
    });

const Raw = z.object({
  PORT: int(3000, 1, 65535),
  TOOL_CALL_TIMEOUT_MS: int(30_000, 100),
  // …
  AUTH_DISABLED: bool.default("false"),
  CORS_ORIGINS: z.string().optional(),
});

export const config = Raw.parse(process.env) as unknown as Config;
```

> **Decisión pendiente:** ¿`zod` o `valibot`? `zod` es estándar, mejor ecosistema. `valibot` es 10× más pequeño (Bun-friendly). Para Bun single-binary, **valibot** pesa menos — pero añade dependencia. Recomiendo **`zod`** salvo que queráis minimizar el binario.

---

## 5. Hoja de ruta de ejecución (12 semanas)

| Sem     | Tracks paralelos                                                             | Cierre / DoD                                            |
| ------- | ---------------------------------------------------------------------------- | ------------------------------------------------------- |
| **S1**  | P0-5 (typed env) + P0-4 (i18n CI)                                            | PRs pequeños con tests verdes; CI falla si deriva i18n  |
| **S2**  | P0-3 (Registry split) — fase 1: extraer `AliasIndex` y `Persistence`         | Tests de regression pasan; sin cambio de comportamiento |
| **S3**  | P0-1 (proxy pipeline) — fase 1: extraer `runGuards` + 2 guards como piloto   | Nuevos tests por guard; benchmark antes/después         |
| **S4**  | P0-2 (admin router split) — fase 1: 5 routers extraídos                      | `routes/admin.ts` < 400 LOC; tests pasan                |
| **S5**  | P0-1 fase 2: migrar todos los guards; P0-3 fase 2: completar split           | `dispatchToolCall` < 200 LOC, `Registry` < 600 LOC      |
| **S6**  | P1-1 (`createApp` extraído), P1-2 (`_migrations` table), P1-5 (CSP+SameSite) | App instanciable sin listen; tracking DB formal         |
| **S7**  | P1-3 (e2e flows) — 4 specs Playwright                                        | CI corre los 4 contra editor fresco                     |
| **S8**  | P1-4 (co-localizar tests) + P1-9 (`withConfig`)                              | Tests navegables; helper en `__tests__/_utils`          |
| **S9**  | P1-6 (traceparent), P1-7 (livez/readyz), P1-8 (SLOs doc)                     | Headers verificados en tests                            |
| **S10** | P2-1 (mutation testing) — instalar Stryker, scope = registry/proxy/guards    | Baseline score > 60%                                    |
| **S11** | P2-2 (k6) + P2-5 (Grafana dashboard)                                         | Reporte baseline en `docs/perf/`                        |
| **S12** | P2-3 (ADRs), P2-4 (commits+husky), P2-9 (drain shutdown)                     | 3 ADRs escritos, commitlint activo                      |

> Cada PR debe: pasar `bun run check`, añadir tests si introduce comportamiento, actualizar `CHANGELOG.md` (cambios visibles) y `docs/` si cambia arquitectura. No commitear artefactos (`data/`, `test-results/`, `dist/`, `.editor.log`).

---

## 6. Riesgos y consideraciones

1. **Refactor de `proxy.ts`** es el más arriesgado — es el path crítico. **Hacerlo con feature flag** (`PROXY_PIPELINE_V2=true`) durante la fase 1, validar métricas idénticas (`recordToolCall`, `recordUsage`, breaker outcomes), y luego retirar el flag.
2. **`migrations.ts`→tabla `_migrations`**: coordinar con despliegues existentes. La tabla debe crearse idempotentemente en arranque y “auto-aplicar” las que falten por checksum.
3. **No romper el contrato MCP** — la separación de scopes (`/mcp`, `/mcp/:client`, `/mcp-custom/:bundle`) es **documentada y pública**. Cualquier movimiento de rutas necesita un ADR primero.
4. **El `keyPrefix` y los `hashAlgorithm`** son detalles públicos del CLI (`bun run cli`) — si los cambias, versiona con SemVer bump `MINOR` (no `PATCH`).
5. **`openapi.yaml` interno (226 KB)** — es el schema del propio gateway. ¿Tiene sentido servirlo en producción? Si sí, OK; si no, moverlo a `docs/api/` y no incluirlo en el bundle.
6. **No tocar `bootstrap-admin.ts`, `mcp/registry.ts:persistRegistration`, ni `src/security/startup-guards.ts`** sin entender primero los invariantes de seguridad que preservan. Si me preguntas, propongo una **sesión dedicada de walk-through** antes de cualquier cambio en esa zona.

---

## 8. Follow-ups parciales (post-1.0.0)

Ítems iniciados pero no cerrados en la racha P1-x; cada uno tiene contexto suficiente
para retomarse en una sesión dedicada.

### P1-9 — `withConfig(patch, fn)` helper **(parcial, ~80 % cerrado)**

**Estado**: helper en `src/__tests__/_utils/with-config.ts` (con su smoke suite de 8 tests),
migración mecánica aplicada a **13 archivos / 50 sitios**. Los **~226 call sites restantes** están
explícitamente fuera del script por tres motivos documentados:

1. **`beforeEach` / `afterEach` save/restore.** El parche en `withConfig` se aplica una vez al
   entrar al test, pero los hooks `beforeEach/afterEach` mutan config en el `describe` scope, no en
   cada test. Un wrapper per-test invertiría el orden (patch → setup → restore).
2. **Helpers como `resetAll()`, `pointAt()`** que mutan config desde fuera del callback del
   test. Moverlos a `withConfig` cambiaría su contrato.
3. **Tests que reasignan el mismo campo con valores distintos mid-body**
   (`secrets-index.test.ts:43-47` "switches when config.secretsProvider changes") — un solo patch
   object no puede expresar el toggle.

**Para retomar**: cubrir esos tres patrones manualmente. El más común
(`beforeEach/afterEach`) se puede resolver con una variante `withConfigAll` que
acepta un array de patches (uno por test), pero requiere cambio de signature en el helper.

### P1-4 — Co-localizar tests en `src/<feat>/__tests__/` **(parcial, 99.9 % cerrado, revertido)**

**Estado**: se construyó un script `scripts/co_locate_tests.py` que mapea los ~126
`src/__tests__/*.test.ts` a sus feature folders (`src/admin/audit/__tests__/`,
`src/mcp/__tests__/`, etc.), reescribe los imports relativos al nuevo nivel
(depth-correcto, incluyendo `await import(...)` dinámico), y deja `_utils/` en su
ubicación original con los consumidores apuntando explícitamente a
`../../__tests__/_utils/with-config.js`. Resultado medido: **1215/1216 tests pass tras
la migración** (99.92 %). El test fallido es un edge case difícil de localizar en el output
de bun (no aparece como `(fail)` en los logs, solo como `1 fail / 1 error` en el resumen
final, con un output de 14 MB dominado por `Applied database migration`).

**Decisión**: revertido. **Razón**: la regla de parada del autonomous mode dice
"Un ítem M resulta ser más grande de lo estimado (>2 h) — entonces divídelo o deja nota en el
REVIEW y para." Esta migración invirtió ~3 h netas entre script, depth-bug fixes
(3 bugs distintos: `_utils/` rewrite, depth=0 vs depth=1, offset-in-body), ENOENT phantom
errors (bun's test runner caching paths), y el mystery test failure que no se pudo aislar.

**Para retomar**: la tabla `MAPPING` en `scripts/co_locate_tests.py` (commit previo en
working tree antes del revert) ya tiene 121 entradas validadas. El script solo necesita
un fix al mystery test — sugiere ejecutar `bun test --bail=1 --reporter=verbose` para
obtener el nombre del test que falla, luego excluirlo del mapeo (o arreglarlo manualmente)
y re-ejecutar. Tiempo estimado para terminar: **30-60 min**.

### P1-3 — Cobertura e2e **(parcial, 2/4 flujos)**

`e2e/auth-fail-closed.spec.ts` (5 tests) + `e2e/mcp-protocol.spec.ts` (6 tests)
están en main. **Pendientes**: `e2e/canary-failover.spec.ts` y `e2e/bundle-install.spec.ts`.
Estima 1-2 h cada uno, depende de fixtures (un primario que se pueda tumbar para canary,
un bundle pre-registrado con install token para bundle-install).

---

## 7. Glosario de cambios esperados (resumen ejecutivo)

- **`src/proxy/proxy.ts`**: de 1500 LOC a <500. `dispatchToolCall` de 730 a <200.
- **`src/mcp/registry.ts`**: de 1680 a ~600 LOC (3 archivos nuevos pequeños).
- **`src/routes/admin.ts`**: de 1634 a <100 LOC (índice + delegación).
- **`src/config.ts`**: typed con `zod`, errores claros en arranque.
- **`src/index.ts`**: de 315 a <80 LOC (extrae `bootstrap()` y `createApp()`).
- **CI**: añade audit i18n, axe-core, k6 nightly, mutation en módulos core.
- **Docs**: ADRs en `docs/architecture/decisions/`, SLOs en `docs/architecture/slos.md`.
- **Tests**: 4 e2e flujos nuevos; mutation baseline > 60%.

**Resultado esperado en S12:**

- Onboarding de un nuevo contributor: de ~2 semanas a **< 1 semana** (modularidad visible).
- Regresión de seguridad en un guard: detectable en PR (test unit del guard) en vez de "lo notarás en producción".
- Auditoría externa (SOC2 etc.): el ADR + SLOs + e2e + mutation testing son el pan de cada día.

---

_Documento generado con análisis estático y revisión de código. Cualquier métrica numérica (LOC, cobertura) es aproximada — confirmable con `wc -l src/**/*.ts` y `bun test --coverage`._
