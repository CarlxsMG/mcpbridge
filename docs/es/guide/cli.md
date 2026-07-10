# CLI (config-as-code)

Junto a la UI de admin y la `/admin-api` raw, el bridge envía un pequeño **CLI `gateway`**
para gestionar la configuración como un fichero YAML versionado — útil para CI/CD, review
estilo GitOps de cambios de guardrails/policies, o simplemente para scriptear cambios
bulk. Es un thin wrapper sobre los endpoints existentes `/register` y
`/admin-api/config/export` + `/admin-api/config/import`; no hay lógica de servidor separada
que instalar.

Sin instalación separada: el CLI vive en `src/cli/index.ts` y se ejecuta vía el script `cli`
ya presente en `package.json`.

```bash
bun run cli -- <command> [...flags]
```

(El `--` reenvía todo lo que viene después al CLI como su propio argv, así que `--flag` no
se lo come `bun run`.)

## Autenticación

El CLI se autentica como un **cliente admin de la API con bearer token** — el mismo
mecanismo que para scriptar contra `/admin-api` directamente (consulta
[`ADMIN_API_KEYS`](/es/guide/configuration)). `gateway login` guarda el gateway URL y el
token en `~/.mcpbridge/config.json` (escrito con permisos `0600` — trátalo como una
contraseña admin, porque lo es):

```bash
bun run cli -- login --url http://localhost:3000 --token $ADMIN_API_KEY
```

Cualquier otro comando lee esas credenciales guardadas; no hay flag `--token` por comando.
Si no has hecho login (o el fichero de credenciales falta/está corrupto), los comandos fallan
rápido con un mensaje diciendo que re-ejecutes `login`.

## Comandos

### `login`

```bash
gateway login --url <gateway-url> --token <admin-api-key>
```

Guarda el URL del gateway y la admin API key localmente. Ejecuta esto una vez por máquina
(o cada vez que rote el token).

### `pull`

```bash
gateway pull [--file gateway.yaml]
```

Trae la configuración en vivo desde `GET /admin-api/config/export` y la escribe en la sección
`config:` del fichero. Si ya existe un `gateway.yaml` con una lista `servers:` escrita a
mano, esa lista se preserva intacta — `pull` nunca deriva `servers:` del gateway en vivo,
solo `config:`. Por defecto `gateway.yaml` en el directorio actual.

### `plan`

```bash
gateway plan [--file gateway.yaml]
```

Dry-run: muestra qué haría `apply` sin cambiar nada.

- Para cada entrada bajo `servers:`, indica si ya está registrada (`=`) o si se registraría
  nueva (`+`).
- Para `config:`, hace diff del fichero contra el export en vivo y lista cada add/change/
  remove.

Sale **con código no-cero cuando hay drift**, así que es CI-friendly:

```bash
gateway plan --file gateway.yaml || echo "drift detectado"
```

### `apply`

```bash
gateway apply [--file gateway.yaml] [--dry-run]
```

Aplica `gateway.yaml` en dos fases, en este orden:

1. **Registra cualquier entrada `servers:` que falte** vía `POST /register` (se salta las que
   ya existen — idempotente).
2. **Aplica `config:`** vía `POST /admin-api/config/import` (guardrails, policies, bundles,
   etc.).

El orden es importante: `config/import` solo configura _clientes ya registrados_, así que
un fichero que registra un server nuevo y le define guards en la misma ejecución depende
de que los servers se creen primero. Pasa `--dry-run` para previsualizar la fase 1 sin
registrar nada (el endpoint de import de la fase 2 tiene su propio modo `dryRun`, reportado
inline).

### `connect`

```bash
gateway connect --client <claude-desktop|cursor|windsurf|continue|generic-json> \
  --scope <client|bundle|system> [--name <clientOrBundleName>] [--out <file>]
```

Genera un config de cliente MCP listo para pegar (`claude_desktop_config.json`,
`.cursor/mcp.json`, `mcp_config.json` de Windsurf, `config.yaml` de Continue, o un snippet
JSON genérico) para uno de los modos de servir, en lugar de editar el fichero a mano:

- `--scope client --name petstore` — un shard por cliente (`/mcp/petstore`)
- `--scope bundle --name support-agent` — un bundle curado (`/mcp-custom/support-agent`)
- `--scope system` — el control plane `/mcp` (tools `sys_*` de gestión del gateway, **no**
  tools de backend; sin necesidad de `--name`)

Verifica que el target exista realmente (y esté habilitado) contra la admin API en vivo antes
de generar nada, así que un nombre con typo falla con un mensaje claro en lugar de un
config que silenciosamente devuelve cero tools. Sin `--out` el snippet se imprime a stdout;
con él, se escribe directamente al fichero.

## Formato de `gateway.yaml`

```yaml
version: 1

servers:
  - name: petstore
    health_url: https://petstore3.swagger.io/
    base_url: https://petstore3.swagger.io/api/v3
    openapi_url: https://petstore3.swagger.io/api/v3/openapi.json
    include_tags: [pet]
  - name: github
    kind: mcp
    mcp_url: https://your-mcp-server.example.com/mcp
    mcp_transport: streamable-http

config:
  # Forma verbatim de GET /admin-api/config/export — normalmente no escribes esta
  # sección a mano, la traes con `gateway pull` y la editas.
  ...
```

- **`servers:`** es solo del CLI — no es parte del shape de export/import de la admin API,
  así que siempre se escribe a mano (o se copia de un `pull` previo, que la preserva tal
  cual). El `kind` de cada entrada (`rest` por defecto, `mcp`, o `graphql`) determina qué
  campos aplican, replicando el payload de `POST /register` — consulta
  [Registrar backends →](/es/guide/registering-backends).
- **`config:`** es la forma byte-a-byte devuelta por `/admin-api/config/export` — el mismo
  export que produce la pantalla de versionado de config de la UI de admin. Consigue un
  punto de partida con `gateway pull`, edítalo y luego `gateway plan` / `gateway apply`.

## Flujo típico

```bash
bun run cli -- login --url https://bridge.example.com --token $ADMIN_API_KEY
bun run cli -- pull                    # escribe gateway.yaml desde el gateway en vivo
# ...edita gateway.yaml, haz commit en control de versiones...
bun run cli -- plan                    # revisa el drift antes de tocar nada
bun run cli -- apply                   # registra servers, luego aplica config
```

Si el import de config de `apply` falla porque el fichero se exportó de una versión de
gateway diferente, te dice que re-ejecutes `pull` y re-apliques tus ediciones sobre el
export refrescado.
