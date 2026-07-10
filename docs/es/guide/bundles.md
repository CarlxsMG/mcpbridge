# Agregar backends en un solo endpoint (bundles)

Registra dos backends — digamos una API REST `petstore` y un upstream MCP `github` — y cada
uno obtiene su propio shard: `/mcp/petstore`, `/mcp/github`. Pero un agente normalmente quiere
**unas pocas tools de varios backends en un mismo sitio** — no un backend cada vez, y tampoco
_todo_ aplanado junto.

Para eso está un **bundle**: un subconjunto curado por un admin, entre backends, de tools (más
[macros composite](/es/guide/features) opcionales) servido en su propio endpoint MCP en
`/mcp-custom/:bundleName`. Es como conviertes _varias_ APIs REST y servidores MCP en _un_
único endpoint MCP gobernado.

::: tip ¿Por qué no apuntar un agente a `/mcp`?
`/mcp` es el [control plane](/es/guide/architecture) — tools `sys_*` para gestionar el gateway
mismo, no tools de backend. **No** existe, a propósito, un endpoint "todas las tools de backend
aplanadas" (hacía ambiguas las API keys, el RBAC y la superficie de tools de cada bundle —
consulta [ADR-0001](https://github.com/aico-dot-team-code/mcpbridge/blob/main/docs/architecture/decisions/0001-two-planes-three-endpoints.md)).
Un bundle te da exactamente la superficie entre backends que querías, y nada más.
:::

## 1. Registra los backends

Cada backend se registra una vez, de la forma habitual (consulta
[Registrar backends](/es/guide/registering-backends)):

```bash
# una API REST, auto-descubierta desde su spec OpenAPI
curl -X POST https://bridge.example.com/register \
  -H "Authorization: Bearer $ADMIN_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "name": "petstore",
    "health_url": "https://petstore3.swagger.io/",
    "openapi_url": "https://petstore3.swagger.io/api/v3/openapi.json"
  }'

# un servidor MCP existente, re-expuesto a través de la misma pila de guards
curl -X POST https://bridge.example.com/register \
  -H "Authorization: Bearer $ADMIN_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "name": "github",
    "kind": "mcp",
    "mcp_url": "https://your-mcp-server.example.com/mcp",
    "mcp_transport": "streamable-http"
  }'
```

## 2. Cura un bundle entre ambos

Elige las tools exactas que quieres de cada backend. Una entrada de bundle es
`{ client, tool }` — el nombre registrado del backend más el nombre **pelado** de la tool (no
la forma namespaced `client__tool`):

```bash
curl -X POST https://bridge.example.com/admin-api/bundles \
  -H "Authorization: Bearer $ADMIN_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "name": "support-agent",
    "description": "Las tools de solo lectura que un agente de soporte necesita, entre pets e issues",
    "tools": [
      { "client": "petstore", "tool": "getPetById" },
      { "client": "github",   "tool": "search_issues" }
    ]
  }'
```

- `name` debe cumplir `^[a-z0-9][a-z0-9_-]{0,62}$` — se convierte en el segmento de la URL.
- Cada `{ client, tool }` debe referenciar una tool que exista realmente, o la llamada entera
  falla con `400` — no hay bundles a medio crear.
- Crear un bundle requiere el rol **admin** (una sesión admin con su `X-CSRF-Token`, o un token
  Bearer `ADMIN_API_KEYS`).
- Añadir una tool a un bundle nunca la copia ni la clona: la tool sigue viviendo en su backend, y
  cada llamada sigue pasando por la pila de guards completa (SSRF → guardrails → política por
  tool → circuit breaker → dispatch → auditoría), exactamente como si se llamara en su propio
  shard.

¿Prefieres la UI? **Bundles → Nuevo bundle** te da un selector de tools entre clientes, con
búsqueda, que escribe el mismo payload por ti.

## 3. Conéctate al endpoint único

El bundle está vivo en `/mcp-custom/support-agent` inmediatamente. Apunta cualquier cliente MCP
ahí y verá exactamente esas dos tools — de dos backends _distintos_ — como una sola lista
unificada de tools:

```json
{
  "mcpServers": {
    "support-agent": { "url": "https://bridge.example.com/mcp-custom/support-agent" }
  }
}
```

O genera el config del cliente con la CLI en lugar de editarlo a mano:

```bash
gateway connect --client cursor --scope bundle --name support-agent
```

## Ir más allá

- **[Tools composite / macro](/es/guide/features)** — añade un array `composites: ["..."]` al
  bundle para exponer un workflow de varios pasos (cada paso por la pila de guards completa) como
  una sola tool invocable. Los composites solo son alcanzables a través de un bundle que los liste.
- **[Enlaces de instalación de bundle](/es/guide/features)** — emite un enlace de un clic,
  compartible y revocable, que auto-provisiona una MCP key con scope al bundle, para que los
  usuarios finales nunca manejen una key en crudo.
- **[Control de acceso](/es/guide/access-control)** — acota una MCP key a un bundle para que un
  caller pueda alcanzar _solo_ esa superficie curada, nada más del gateway.

Siguiente: **[Conectar clientes MCP →](/es/guide/connecting-clients)** ·
**[Control de acceso →](/es/guide/access-control)**
