# Registrar backends

Un backend es una **API REST**, una **API GraphQL**, o un **servidor MCP** existente —
cada uno se convierte en (o re-expone) tools MCP a través de la misma pila de guards.
Registra desde la UI de admin (**Añadir servidor**) o la API `POST /register`. El registro
requiere auth admin — una sesión, o un token Bearer `ADMIN_API_KEYS`.

::: tip Muestras listas para enviar
El directorio [`examples/register/`](https://github.com/CarlxsMG/mcpbridge/tree/main/examples/register)
del repo trae un body completo de `POST /register` para cada modo de abajo (OpenAPI, importación
cURL, Postman, manual, GraphQL, MCP upstream), más un
[`examples/gateway.yaml`](https://github.com/CarlxsMG/mcpbridge/blob/main/examples/gateway.yaml)
para registrar los mismos backends como config-as-code.
:::

## REST desde un spec OpenAPI

Apunta al spec y el bridge genera una tool por operación:

```bash
curl -X POST https://bridge.example.com/register \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "petstore",
    "health_url": "https://petstore3.swagger.io/",
    "openapi_url": "https://petstore3.swagger.io/api/v3/openapi.json"
  }'
```

Campos útiles:

| Campo                                 | Propósito                                                                                           |
| ------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `openapi_url`                         | Descubre tools desde un spec (mutuamente exclusivo con `tools`, `curl_input`, `postman_collection`) |
| `tools`                               | Provee definiciones de tools manualmente cuando no hay spec                                         |
| `curl_input`                          | Deriva una tool de un comando `curl` pegado (más abajo)                                             |
| `postman_collection`                  | Deriva tools de una exportación Postman Collection v2.1 (más abajo)                                 |
| `base_url`                            | Sobrescribe el base de la API (por defecto el host de `health_url`)                                 |
| `include_tags` / `exclude_operations` | Selecciona exactamente qué operaciones se convierten en tools (solo discovery OpenAPI)              |
| `retry_non_safe_methods`              | Permite reintentos en métodos no idempotentes (off por defecto)                                     |

`tools`, `openapi_url`, `curl_input` y `postman_collection` son **mutuamente exclusivos** —
provee exactamente uno.

## Desde un comando cURL o colección Postman

¿Sin spec OpenAPI? Pega una invocación `curl` funcional y el bridge deriva una sola tool de
su método, URL, headers y body:

```bash
curl -X POST https://bridge.example.com/register \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "internal-search",
    "health_url": "https://search.internal.example.com/health",
    "curl_input": "curl -X GET '\''https://search.internal.example.com/v1/query?q=hello'\'' -H '\''Authorization: Bearer TOKEN'\''"
  }'
```

O apunta `postman_collection` a una exportación Postman Collection v2.1 (un objeto, o su
forma como string JSON) para derivar una tool por request de la colección — útil cuando un
equipo ya mantiene una en lugar de un spec OpenAPI:

```bash
curl -X POST https://bridge.example.com/register \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "team-api",
    "health_url": "https://team-api.example.com/health",
    "postman_collection": "{\"info\":{\"schema\":\"https://schema.getpostman.com/json/collection/v2.1.0/collection.json\"},\"item\":[{\"name\":\"Get order\",\"request\":{\"method\":\"GET\",\"url\":\"https://team-api.example.com/orders/:id\"}}]}"
  }'
```

Las carpetas anidadas se aplanan en un prefijo de nombre unido por guiones bajos (`Users` ›
`Get` se convierte en `users_get`) para que requests con el mismo nombre en carpetas distintas
no colisionen.

## Definiciones de tools manuales

¿Sin spec, sin `curl`, sin Postman? Describe tú mismo las tools con un array `tools`. Cada
entrada es un método HTTP + path sobre `base_url` más un JSON Schema para sus argumentos; los
`:placeholders` estilo Express en el path se rellenan con los argumentos de la llamada en el
momento del dispatch:

```bash
curl -X POST https://bridge.example.com/register \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "customer_service",
    "health_url": "https://api.example.com/health",
    "base_url": "https://api.example.com",
    "tools": [
      {
        "name": "get_customer",
        "method": "GET",
        "endpoint": "/customers/:id",
        "description": "Recupera un único registro de cliente por ID.",
        "inputSchema": {
          "type": "object",
          "properties": { "id": { "type": "string", "description": "El ID del cliente." } },
          "required": ["id"]
        }
      }
    ]
  }'
```

## Una API GraphQL

```bash
curl -X POST https://bridge.example.com/register \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "storefront",
    "kind": "graphql",
    "graphql_url": "https://storefront.example.com/graphql"
  }'
```

El bridge introspecciona el schema y genera una tool por query y mutation (`include_mutations: false`
para exponer solo queries). `health_url` es opcional — por defecto es `graphql_url`, pero
muchos servidores GraphQL rechazan un `GET` desnudo en el endpoint de operaciones, así que
proveer un endpoint de liveness dedicado evita fallos de health positivos falsos y
auto-eliminación (la response incluye un array `warnings` si te lo saltas).

## Un servidor MCP existente (upstream)

```bash
curl -X POST https://bridge.example.com/register \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "github",
    "kind": "mcp",
    "mcp_url": "https://your-mcp-server.example.com/mcp",
    "mcp_transport": "streamable-http"
  }'
```

El bridge se conecta hacia fuera, descubre las tools del upstream y las re-expone a través
de la misma pila de guards. Se soportan tanto `streamable-http` como `sse` como transportes
upstream.

## Desde el catálogo de instalación

La UI de admin también tiene una página de **catálogo**: un marketplace curado de
instalación con un clic que combina plantillas de servidor integradas con las personalizadas
que añada un admin. Instalar una entrada del catálogo pasa por el mismo camino de registro
(check SSRF, discovery, IP pinning) que un `POST /register` escrito a mano — es un atajo
a un formulario pre-rellenado, no un code path separado.

## Qué pasa en el registro

- **Check SSRF + anclaje de IP.** La URL del backend se valida y su IP resuelta se ancla,
  para que un cambio posterior de DNS no pueda redirigirlo. Direcciones loopback/privadas
  se rechazan salvo que `ALLOW_PRIVATE_IPS=true` (solo dev local).
- **Monitorización de salud.** Un loop en background chequea cada backend y auto-elimina los
  no saludables (un probe `ping` para upstreams MCP). La eliminación nunca destruye config
  admin.
- **Las tools se activan** inmediatamente — en el shard propio del backend (`/mcp/:name`), y
  disponibles para añadir a cualquier [bundle curado](/es/guide/bundles).

## Mantener las tools al día

Re-ejecuta el discovery en cualquier momento (la acción **Re-descubrir tools** en la página
de detalle de un server, o re-`POST /register`) después de que cambie el spec del backend.
La config por tool — guards, aliases, enable flags — sobrevive al re-descubrimiento.

## Eliminar un backend

`DELETE /admin-api/clients/:name` (ver [Referencia de API](/es/guide/api-reference)) elimina
un backend — el registro se encarga de la limpieza de requests en vuelo, el estado del
circuit-breaker y la eliminación del índice de tools por ti, y su config admin persistida
(guards, enable flags, etc.) también se purga. La UI de admin expone la misma acción desde la
página de detalle del server.

También existe un `DELETE /clients/:name` más ligero a nivel raíz: da de baja el mismo estado
en memoria/en vivo pero deja intacta la fila del cliente en SQLite, así que el backend puede
reaparecer en la siguiente reconciliación con la base de datos. Prefiere
`/admin-api/clients/:name` para una eliminación real y permanente; la ruta de nivel raíz
existe sobre todo para el propio código de auto-eliminación por salud, y no está pensada como
la forma principal de dar de baja un backend a mano.

Siguiente: **[Agregar backends en un solo endpoint →](/es/guide/bundles)** ·
**[Conectar clientes MCP →](/es/guide/connecting-clients)** ·
**[Guardrails y resiliencia →](/es/guide/guardrails-resilience)**
