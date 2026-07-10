# Contribuir

El [`CONTRIBUTING.md`](https://github.com/aico-dot-team-code/mcpbridge/blob/main/CONTRIBUTING.md)
raíz es la referencia canónica estilo GitHub (es a la que enlaza GitHub desde el banner de
"new PR" y los Estándares de Comunidad del repo). Esta página es la versión buscable y
cross-linked para lectores ya dentro del sitio de docs — un superset que enlaza fuera a
Arquitectura/Configuración/Seguridad en vez de re-explicarlos, así que mantén ambos
sincronizados si cambias cualquiera.

## Antes de empezar

Lee **[Arquitectura →](/es/guide/architecture)** y
**[Conceptos y glosario →](/es/guide/concepts)** primero — el modelo mental del camino de
la request (cada política aplicada en el dispatch, nunca como middleware HTTP) explica
muchas decisiones que de otro modo tendrías que re-derivar desde el código. Para
cualquier cosa más allá de un fix pequeño, abre un issue para discutir el enfoque antes
de escribir código — ahorra retrabajo a ambas partes.

## Setup del entorno de desarrollo

### Requisitos

- [Bun](https://bun.sh) `1.x` — el gateway usa los built-ins de Bun (`bun:sqlite`,
  `Bun.dns`, `Bun.password`) directamente, así que Node.js no es un sustituto.

### Clonar, instalar, configurar

```bash
git clone https://github.com/aico-dot-team-code/mcpbridge.git
cd mcpbridge
bun install
cp .env.example .env                 # luego configura BOOTSTRAP_ADMIN_PASSWORD (mín 12 chars)

cd admin-ui && bun install && cd ..
```

Define también `ADMIN_API_KEYS` en `.env` si vas a scriptar contra `/register` o
`/admin-api` directamente en lugar de usar solo la UI — consulta [Primeros pasos →](/es/guide/getting-started)
para el tutorial completo de primer arranque (incluyendo las env vars exactas que cada
opción local necesita).

### Ejecutar el stack completo

```bash
bun run dev:all      # backend :8790 + admin UI :8791, ambos con hot reload
```

## Ejecutar tests, typecheck y lint

| Comando                            | Qué ejecuta                                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `bun test`                         | Suite de tests del backend (`src/**/__tests__/`). Debería estar 100% verde.                             |
| `bun run typecheck`                | Typecheck del backend (`tsc --noEmit`)                                                                  |
| `cd admin-ui && bun run test`      | Tests de componente/unidad del admin UI (Vitest)                                                        |
| `cd admin-ui && bun run typecheck` | Typecheck del admin UI (`vue-tsc -b --noEmit`)                                                          |
| `cd admin-ui && bun run build`     | Build de producción del admin UI — atrapa cosas que el typecheck solo no (p. ej. imports Vite sin usar) |
| `bun run test:e2e`                 | End-to-end con Playwright (`e2e/`): smoke, protocolo MCP, auth-fail-closed                              |
| `bun run test:mutate`              | Mutation testing con [Stryker](https://stryker-mutator.io) (`stryker.config.mjs`)                       |

El bridge está cubierto por **varios sistemas de test, no uno**: **el runner de Bun** para la
suite del backend (280+ ficheros bajo `src/**/__tests__/`), **Vitest** para el admin UI,
**Playwright** para end-to-end, y encima **mutation testing con [Stryker](https://stryker-mutator.io)** —
que inyecta fallos en el código y falla si los tests no los atrapan, así que la cobertura mide
_efectividad_, no solo ejecución de líneas. Las corridas de mutación son mucho más pesadas que
un test normal; acótalas a los ficheros que cambiaste mientras iteras (mira `stryker.config.mjs`).

### El gotcha root-vs-package

Backend y admin UI son **proyectos TypeScript separados** con sus propios scripts
`lint`/`typecheck` — ejecutar solo el paquete que tocaste no es lo mismo que el CI gate
real del repo. En particular, **`bun run format:check` (Prettier) es un script solo de
nivel raíz** — el propio `package.json` del admin-ui no tiene `format`/`format:check`.
Es fácil ejecutar `cd admin-ui && bun run lint && bun run typecheck && bun run test && bun run build`,
ver todo pasar, y aún tener drift de formato que solo el chequeo raíz atrapa.

### Un comando antes de pushear

```bash
bun run check
```

Ejecuta el gate completo en orden — check de formato → root lint → admin-ui lint →
root typecheck → root tests → admin-ui typecheck → admin-ui tests → admin-ui build —
deteniéndose en el primer fallo. Esto es lo que corre CI; trata un `bun run check`
limpio como la barra real para "listo para abrir un PR", no solo un run package-scoped
verde.

## Estilo de código y convenciones

- Sin estilo personal forzado más allá de ESLint + Prettier — respeta el formato, naming
  y organización de ficheros ya presentes en el módulo que estés editando.
- TypeScript es **strict** en ambos proyectos — no esquives errores de tipo con `any` o
  non-null assertions a menos que no haya alternativa razonable; prefiere
  narrowing/guards sobre casts.
- Mantén los módulos enfocados: la lógica security-sensitive vive bajo `src/security/`,
  los route handlers bajo `src/routes/`, el acceso a DB bajo `src/db/`. Los componentes
  del admin UI viven bajo `admin-ui/src/components/{ui,charts,guard-editor,
server-detail,layout}/` por rol.
- **Cada política se aplica en el punto de dispatch (`proxyToolCall`), nunca como
  middleware HTTP** — MCP multiplexa muchas tools sobre una única ruta `POST /mcp`,
  así que el bridge tiene que saber qué tool se está llamando antes de poder aplicar
  reglas por tool. No añadas un nuevo guard como middleware de Express; cablealo en el
  pipeline de dispatch en su lugar.

### Un gotcha conocido que vale la pena no redescubrir

No pongas `display` (`flex`/`grid`/etc.) directamente en un `<td>` de una tabla del
admin-ui — sobrescribe el display `table-cell` por defecto y rompe visualmente el layout
de la fila (colapso de sizing y alineación de columnas). Envuelve el contenido de la
celda en un `<div>` hijo y aplica la clase que cambia el display a ese en su lugar; el
`<td>` se queda sin clase.

## Migraciones de base de datos

Los cambios de schema viven en `src/db/migrations.ts`, exportados como un **array
append-only y ordenado** de objetos `{ id, name, sql }`.

- **Nunca edites ni renumeres una migración existente.** Una vez mergeada a `main`, su
  `id` y `sql` quedan congelados — arregla un error con una nueva migración que
  altere/repare el schema.
- **Las migraciones son solo forward.** No hay mecanismo de down-migration — escribe el
  SQL defensivamente (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE` aditivo) y piensa qué
  pasa con las filas/bases de datos existentes cuando se ejecute.
- **Los IDs son enteros secuenciales**, aplicados en orden ascendente al arrancar, cada
  uno dentro de su propia transacción. Mira el tail de `src/db/migrations.ts` para
  conocer el `id` más alto actual antes de añadir uno nuevo.
- Testea una nueva migración localmente contra una DB throwaway (`DB_PATH=:memory:` o
  un fichero de scratch) antes de hacer commit — consulta [Despliegue →](/es/guide/deployment)
  para la historia de upgrade/backup en la que esto encaja en producción.

## Convenciones de branch, commit y PR

Los commits siguen la convención `type(scope): summary` (el `(scope)` es opcional):

- `feat:` / `feat(scope):` — nueva funcionalidad
- `fix:` / `fix(scope):` — bug fixes, incluidas pasadas de hardening
- `docs:` — cambios solo de documentación
- `chore:` — cambios de tooling/config sin cambio de comportamiento en runtime
- `refactor:` — reestructuración interna sin cambio de comportamiento
- `test:` — adiciones/cambios solo de tests

**Feat y luego endurece.** Los cambios grandes suelen aterrizar como un commit `feat`
seguido de uno o más commits `fix` que lo endurecen (edge cases encontrados en review) —
en lugar de un diff gigante, o de doblar el hardening de vuelta al commit de feature
después.

**Tiers de prioridad.** Las descripciones de PR y los commits de hardening en este repo
suelen usar sufijos `[P0]`/`[P1]`/`[P2]` — P0 = corrección/seguridad críticos, P1 =
robustez importante, P2 = pulido. No es obligatorio, pero consistente con la historia
del proyecto si quieres señalar urgencia:

```
fix(admin-ui): stop the .field input recipe double-bordering child components' own inputs [P2]
```

Mantén los PRs con scope a un cambio lógico. Referencia el issue en el que discutiste el
enfoque, si lo hubo.

## i18n de los fixtures del demo

El build público del demo (`VITE_DEMO=true`, servido en `https://<org>.github.io/<repo>/demo/`)
incluye sus propias traducciones al español para cada string user-visible de los fixtures —
descripciones de tools, resúmenes de bundles, labels de API keys, nombres de alertas,
nombres de teams/policies/composites, labels de snapshots, descripciones del catálogo y
las reescrituras del audit-log detail.

Las traducciones viven bajo `demo.fixtures.*` en `admin-ui/src/locales/{en,es}.json`; el
runner es `admin-ui/src/demo/resolve.ts`, conectado a `demoFetch()` para que cada
respuesta del demo se localice contra el locale activo de vue-i18n.

### Al añadir un nuevo string traducible a un fixture

1. Añade el texto literal en inglés al fixture junto a un campo hermano `*Key`:

   ```ts
   // admin-ui/src/demo/fixtures/tools.ts
   {
     name: "my_new_tool",
     method: "GET",
     endpoint: "/new",
     description: "Propósito de mi nueva tool",             // fallback EN
     descriptionKey: demoKey("tools", "myclient.my_new_tool", "description"),
     ...
   }
   ```

   El helper de runtime `demoKey` / `demoKeyByValue` / `demoDetailKey` desde
   `admin-ui/src/demo/i18n-keys.ts` es la única forma de componer claves de fixture —
   se encarga del escape del `punto`-como-separador de vue-i18n (los IDs de entidad usan
   `__` en vez de `.`) y del escape de notación de corchetes para valores free-form que
   contienen espacios o paréntesis.

2. Añade el literal inglés a `scripts/seed-demo-i18n.py` bajo el dominio correspondiente —
   re-ejecuta el script para (re-)generar las claves `demo.fixtures.*` en `en.json`. El
   script REEMPLAZA (no hace merge) la sección demo para que el namespace se mantenga
   canónico.

3. Añade la traducción al español a `scripts/translate-demo-i18n.py` bajo el dominio
   correspondiente — re-ejecuta el script para aterrizar la traducción en `es.json`.

4. Corre `bun run check` — el stage `lint:i18n` falla si `en.json` y `es.json` se
   desincronizan, así que una traducción faltante se captura en CI, no en la página del demo.

### Cuándo NO traducir

- Los nombres de tools como `search_issues`, nombres de clientes como `github`, y cualquier
  otro string que fluya como identificador de URL/path se queda verbatim — son identificadores
  reales del backend, no etiquetas user-facing.
- Los mensajes de error del backend y los payloads JSON-RPC se quedan en inglés (matchea
  el contrato backend-sin-i18n documentado en el repo).
- Los usernames (`demo`, `ops-oncall`, `auditor`) se quedan verbatim — los usernames son
  identificadores.

## Checklist de PR

- [ ] `bun run check` pasa (este es el CI gate real — mira la nota root-vs-package arriba)
- [ ] El schema nuevo/cambiado es una entrada nueva y appendeada en `src/db/migrations.ts`,
      testeada contra una DB fresca — nunca una edición de una existente
- [ ] Docs actualizadas si cambió el comportamiento user-facing, config o API
- [ ] Los mensajes de commit siguen la convención `type(scope): summary` arriba
- [ ] Screenshots incluidos para cualquier cambio visual en admin-ui
- [ ] Los nuevos strings traducibles del fixture demo tienen un campo `*Key`, una entrada
      en `scripts/seed-demo-i18n.py` y una entrada en español en
      `scripts/translate-demo-i18n.py`

Siguiente: **[Changelog →](/es/guide/changelog)** ·
**[Política de seguridad →](/es/guide/security-policy)**
