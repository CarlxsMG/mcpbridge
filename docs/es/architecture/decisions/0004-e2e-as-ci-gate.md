# Los tests E2E como puerta de CI

- Estado: aceptado
- Fecha: 2026-07-06
- Decisores: CarlxsMG (QA + DX), Claude Sonnet 5 (revisión)

## Contexto y planteamiento del problema

El repo tenía un único e2e de happy-path (`e2e/smoke.spec.ts`) desde el primer
release etiquetado. Ejercitaba login → registrar un backend → llamar la tool
descubierta, lo cual está bien como chequeo de humo pero **no ejercita los
modos de fallo** que el bridge existe para gobernar:

- ¿Se cierra el plano de datos en el momento en que se emite una key MCP
  gestionada?
- ¿La capa de protocolo (`initialize`, `tools/list`, `tools/call`) devuelve un
  `serverInfo` real, schemas de tools reales, y expone los errores de upstream
  como `isError: true` en lugar de tirar la sesión?
- ¿Una invocación de tool desconocida falla con `isError: true`
  (recuperable) en lugar de un error de transporte (que mata la sesión)?

Sin estos flujos bajo test, las regresiones en el modelo de auth (el camino de
código de mayor riesgo) y en el envelope de protocolo (el contrato de mayor
visibilidad) solo se detectarían en producción. Los tests unitarios cubren los
componentes de forma aislada; lo que faltaba era confianza de extremo a extremo
en que los componentes **se cablean correctamente entre sí** bajo HTTP real y
semántica de navegador real de Playwright.

La pregunta: ¿cuántos de los flujos e2e de REVIEW §2.4 añadimos, y cómo los
cableamos para que realmente puerteen los merges en lugar de ser un chequeo
"best-effort" que alguien deshabilita cuando se pone flaky?

## Drivers de la decisión

- **Puerta de CI, no consultivo.** Una suite e2e flaky que se permite ignorar
  enseña al equipo a ignorarla. El listón es "debe pasar en cada PR" — no
  "corre por la noche y nos cuenta las tendencias".
- **Independiente del orden.** bun:test corre los ficheros en paralelo; los
  specs e2e en serie. La suite no debe asumir que ningún spec previo corrió.
  Cada spec emite su propia key MCP gestionada con una etiqueta única y
  desmonta sus fixtures en `beforeAll` / `afterAll`.
- **Navegador real, backend real.** Los mocks de `fetch` y `WebSocket` testean
  el cableado dentro del test, no el cableado bajo carga. Playwright nos da un
  Chromium real hablando con un `bun run src/index.ts` real en un puerto real
  — lo más cerca que podemos estar de producción en CI.
- **Cachear el navegador.** Re-descargar Chromium en cada run de CI son ~30 s
  de puro desperdicio. `actions/cache` con clave por la versión de Playwright
  baja el tiempo de instalación a casi cero en cache hit.

## Opciones consideradas

- **A. Mantener un spec de humo; añadir tests e2e como opt-in
  (`bun run test:e2e`, no en CI).** Statu quo antes de esta decisión.
  Rechazada: un e2e opt-in que no es una puerta es documentación, no un test.
- **B. Añadir muchos flujos e2e, correrlos todos en cada PR.** Tentador pero
  rechazado para esta iteración: REVIEW §2.4 lista cuatro flujos (fail-closed,
  protocolo, ciclo de vida de admin, canary). Añadir los cuatro de golpe habría
  producido un único commit masivo; escalonar el rollout mantiene cada commit
  biseccionable.
- **C. Aterrizar dos flujos ahora (auth-fail-closed, protocolo) con un job de
  CI que corre ambos, dejando los flujos de canary y bundle-install para
  seguimiento.** Elegida.

## Resultado de la decisión

Opción elegida: **C — dos specs nuevos, cableados a un job de CI nuevo, con los
dos flujos restantes rastreados como backlog**.

Specs aterrizados:

- `e2e/auth-fail-closed.spec.ts` (5 tests). El plano de datos arranca en modo
  abierto (sin material de auth configurado), luego se cierra en el momento en
  que se emite una key MCP gestionada vía la API de admin: sin Authorization →
  401, Bearer falso → 403, la key correcta → 200, key revocada → 403. Cubre la
  transición de cierre que el test de humo previo no podía detectar.
- `e2e/mcp-protocol.spec.ts` (6 tests). Contrato de protocolo para
  `/mcp/:clientName`: `initialize` devuelve un `serverInfo` real, `tools/list`
  anuncia el `client__tool` descubierto con el nombre derivado de OpenAPI y el
  `inputSchema`, `tools/call` para una tool conocida devuelve el payload del
  upstream, y tres caminos de error (tool desconocida, args inválidos, upstream 404) se exponen todos como `isError: true` en lugar de tirar la sesión. El
  caso de tool-desconocida en particular era un gotcha conocido de MCP — un
  error de transporte aquí mata la sesión, un `isError` la mantiene viva para
  la siguiente llamada.

El spec de humo se actualizó para la división de `/mcp` (ADR-0001) — ahora
golpea `/mcp/:clientName` (el shard del plano de datos) en lugar del `/mcp`
posterior a la división (la puerta del plano de control).

Cableado de CI:

- Nuevo job `e2e` en `.github/workflows/ci.yml`. Depende del job `test` para
  que una rotura de lint o typecheck falle el PR antes de que corra el paso más
  lento del navegador.
- Cachea los navegadores de Playwright entre runs vía `actions/cache` con clave
  por la versión de Playwright.
- Instala Chromium con `--with-deps` en cache miss (la parte `--with-deps`
  importa en runners Linux — sin ella, librerías de sistema ausentes causan
  fallos silenciosos de lanzamiento del navegador).
- Sube los artefactos `test-results/` y `playwright-report/` en fallo, con una
  retención de 7 días, para que un run de CI fallido pueda depurarse desde la
  página del PR sin re-correrlo.

### Consecuencias

- Bueno, porque cada PR ejercita ahora los dos caminos de código de mayor
  riesgo (el modelo de auth y el envelope de protocolo) bajo HTTP real y un
  navegador real antes del merge.
- Bueno, porque la suite es independiente del orden — cada spec emite su propia
  key, así que un desarrollador que corre un spec aislado obtiene el mismo
  resultado que corriendo la suite completa.
- Bueno, porque la cadena de caché + dependencia mantiene el job e2e en ~25 s
  en cache hit, suficientemente rápido para que el feedback de CI siga siendo
  útil.
- Bueno, porque la actualización del spec de humo detecta el contrato de
  ADR-0001 en CI: cualquier regresión futura que re-aplane `/mcp` (por ejemplo
  alguien reintroduciendo el agregado) rompe el test de humo.
- Malo, porque la suite e2e ahora requiere Chromium en cada runner de CI
  (~150 MB de instalación en el primer run, incluso con caché). Para un runner
  self-hosted de GitHub esto está bien; para un CI restringido puede necesitar
  un split de matriz más adelante.
- Malo, porque el `test-results/` y `playwright-report/` de Playwright pueden
  filtrar URLs de backend y datos de test en su salida HTML. El job de CI sube
  estos solo en fallo, lo que limita la exposición, pero un despliegue
  paranoico querría depurarlos antes de publicar.

### Confirmación

- Job `e2e` de `.github/workflows/ci.yml`: debe pasar en cada PR.
- Cada spec emite su propia key MCP en `beforeAll` con una etiqueta única al
  spec (por ejemplo `auth-fail-closed.spec.ts: keyLabel =
"e2e-auth-fail-closed"`) para que la suite sea independiente del orden.
- El modo de fallo de CI es visible: el job sube el reporte de Playwright como
  artefacto del PR, y la línea que falla se captura en el log del job con un
  stack trace.

## Más información

- Commits:
  - `d58fd30` — `test(e2e): add auth-fail-closed + mcp-protocol specs,
fix smoke for new /mcp split (P1-3)`
  - `d5ed472` — `ci: add e2e job running the Playwright suite (3 specs / 12 tests)
on every PR`
- Seguimiento (aún abierto): spec de fail-over de canary, spec de
  bundle-install — ambos esperan una sesión futura; necesitan fixtures reales
  de canary / bundle-install, que es más que un drop-in de 1 hora.
- Código relacionado: `e2e/*.spec.ts`, `.github/workflows/ci.yml`.
</content>
