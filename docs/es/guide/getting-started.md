# Primeros pasos

MCP REST Bridge convierte tus APIs REST y servidores MCP existentes en un único conjunto gobernado de herramientas MCP — gestionado desde una UI de administración integrada. Esta guía te lleva de cero a un bridge en ejecución con un backend registrado en unos minutos.

## Requisitos previos

- [Bun](https://bun.sh) `1.x` (el bridge usa built-ins de Bun — `bun:sqlite`, `Bun.dns`, `Bun.password` — por lo que Node.js no es un sustituto), **o** Docker.
- Una URL de OpenAPI/Swagger para una API REST, o la URL de un servidor MCP existente.

## Opción A — Docker (la más rápida)

```bash
docker build -t mcpbridge .

export ADMIN_API_KEY=$(openssl rand -hex 24)

docker run -p 3000:3000 \
  -e NODE_ENV=development \
  -e SESSION_COOKIE_SECURE=false \
  -e BOOTSTRAP_ADMIN_USERNAME=admin \
  -e BOOTSTRAP_ADMIN_PASSWORD=change-me-min-12-chars \
  -e ADMIN_API_KEYS=$ADMIN_API_KEY \
  -v "$PWD/data:/app/data" \
  mcpbridge
```

Luego abre **http://localhost:3000/admin** e inicia sesión con las credenciales bootstrap.
`$ADMIN_API_KEY` es el token Bearer que usan los ejemplos `curl` de abajo — mantenlo exportado
en el mismo shell, o reexpórtalo más tarde con el mismo valor.

::: warning Solo HTTP local
`NODE_ENV=development` y `SESSION_COOKIE_SECURE=false` relajan las guardas de arranque para
que la cookie de sesión funcione sobre `http://localhost` plano. **En producción, sirve
sobre HTTPS y elimina ambas** — la cookie se vuelve `__Host-`/`Secure` automáticamente.
:::

::: tip ¿Prefieres no compilar desde el código?
Cuando se publique la primera release, cada release publicará una imagen prebuilt, multi-arch
y firmada en GHCR — entonces podrás quitar el `docker build` y usar
`ghcr.io/aico-dot-team-code/mcpbridge:latest` como imagen en `docker run`. Hasta entonces,
compila en local con el `docker build` de arriba. Consulta [Despliegue →](/es/guide/deployment).
:::

## Opción B — Bun (desarrollo local, con hot reload)

```bash
bun install
cp .env.example .env                 # luego configura BOOTSTRAP_ADMIN_PASSWORD (mín 12 chars)
cd admin-ui && bun install && cd ..

bun run dev:all                      # backend :8790 + admin UI :8791
```

::: tip ¿Por qué puertos distintos al ejemplo Docker de arriba?
El modo dev usa a propósito puertos altos y poco comunes (8790/8791) en lugar del 3000 por
defecto de Docker/producción, para que un servidor de desarrollo local no choque con 3000 — ni
con una instancia real de gateway que puedas estar ejecutando también. Ambos son configurables
(`PORT`, `UI_PORT` en `.env`) — consulta [Configuración →](/es/guide/configuration).
:::

Abre **http://localhost:8791/admin/** e inicia sesión.

El admin bootstrap se crea **solo una vez**, mientras la tabla de usuarios esté vacía. Después
de eso estas variables de entorno se ignoran y gestionas los usuarios desde la UI.

Define `ADMIN_API_KEYS` en `.env` (p. ej. `ADMIN_API_KEYS=$(openssl rand -hex 24)`), reinicia
`bun run dev:all`, y luego exporta el mismo valor como `$ADMIN_API_KEY` para los ejemplos `curl` de abajo.

::: tip Cada comando de abajo asume el puerto de la Opción A
Los ejemplos usan `http://localhost:3000` (Docker / Opción A). En la **Opción B**, el backend
está en `:8790` en su lugar — define `export BASE=http://localhost:8790` y sustituye `$BASE`
por `http://localhost:3000`, o simplemente reemplaza el puerto a mano.
:::

## Registrar una API REST (auto-descubierta desde OpenAPI)

El camino fácil: en la UI, ve a **Añadir servidor → REST**, pega una URL de OpenAPI y envía —
el bridge descarga el spec, genera una herramienta MCP por operación y empieza a hacer
health-checks del backend.

O vía la API (necesita la admin API key que configuraste arriba, enviada como token Bearer):

```bash
curl -X POST http://localhost:3000/register \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "petstore",
    "health_url": "https://petstore3.swagger.io/",
    "openapi_url": "https://petstore3.swagger.io/api/v3/openapi.json"
  }'
```

También puedes usar `include_tags` / `exclude_operations` para seleccionar exactamente qué
operaciones se convierten en herramientas, o pasar un array `tools` manual en lugar de
`openapi_url` cuando no hay spec.

## Registrar un servidor MCP existente como upstream

```bash
curl -X POST http://localhost:3000/register \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "github",
    "kind": "mcp",
    "mcp_url": "https://your-mcp-server.example.com/mcp",
    "mcp_transport": "streamable-http"
  }'
```

El bridge se conecta al upstream, descubre sus tools y las re-expone a través de la misma
pila de guards que todo lo demás. Se soportan tanto `streamable-http` como `sse` como
transportes upstream.

## Apuntar un cliente MCP al bridge

Apunta cualquier cliente MCP (Claude Desktop, Cursor, tu propio agente) a un **shard de
backend** — las tools de un backend registrado. Para el `petstore` que registraste, eso es
`/mcp/petstore`. El bridge negocia la versión del protocolo MCP a través del SDK oficial de
TypeScript, que soporta desde `2024-10-07` hasta `2025-11-25` y usa `2025-03-26` por
defecto cuando el cliente no indica versión — consulta [Conectar clientes MCP →](/es/guide/connecting-clients) para los
detalles de negociación de versión.

```json
{
  "mcpServers": {
    "petstore": { "url": "http://localhost:3000/mcp/petstore" }
  }
}
```

(`:8790` en lugar de `:3000` si estás en la Opción B.)

Tres endpoints, dos planos:

| Endpoint                  | Plano   | Le da al cliente                                                                    |
| ------------------------- | ------- | ----------------------------------------------------------------------------------- |
| `/mcp/:clientName`        | datos   | Las tools de un backend (p. ej. `/mcp/petstore`)                                    |
| `/mcp-custom/:bundleName` | datos   | Un subconjunto curado entre backends — [varios tras un endpoint](/es/guide/bundles) |
| `POST /mcp`               | control | Tools `sys_*` para operar el gateway mismo, **no** tools de backend                 |

El transporte es **Streamable HTTP** en todos los endpoints (el transporte SSE legacy fue eliminado).

::: tip ¿Quieres un endpoint que exponga `petstore` _y_ un upstream juntos?
Eso es un **bundle** — consulta [Agregar backends en un solo endpoint →](/es/guide/bundles).
:::

## Siguientes pasos

- Lee [Arquitectura →](/es/guide/architecture) para el modelo de pipeline completo.
- Lee [Reglas y resiliencia →](/es/guide/guardrails-resilience) para SSRF, secret-detection y las reglas de validación.
- Lee [Configuración →](/es/guide/configuration) para todas las variables de entorno soportadas.
- Blinda el despliegue para producción: define `MCP_API_KEYS`, configura guardrails por tool y sírvelo tras HTTPS — mira [Funcionalidades →](/es/guide/features) para la lista completa de capacidades.

Para preguntas comunes y patrones de resolución de problemas, salta a [Preguntas frecuentes →](/es/guide/faq).
