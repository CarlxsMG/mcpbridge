# Conectar clientes MCP

Cualquier cliente MCP — Claude Desktop, Cursor, una extensión de IDE o tu propio agente —
se conecta al bridge a través del Model Context Protocol. Apúntalo al endpoint que
corresponde a las tools que debe ver.

::: tip Versión de protocolo soportada
El bridge implementa la **versión `2025-06-18` del protocolo MCP**. Los clientes que
negocien una versión anterior o posterior durante el init aún deberían interoperar (el
SDK maneja la negociación de versiones), pero `2025-06-18` es la versión contra la que
este gateway está construido y probado — vale la pena saberlo si te encuentras con una
rareza específica del cliente.
:::

## Elige un endpoint

El bridge expone **tres endpoints en dos planos**. Para darle a un agente tus tools de
backend, usa uno de los dos endpoints del **plano de datos**:

| Endpoint                  | Le da al cliente                     | Úsalo cuando                                                                              |
| ------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------- |
| `/mcp/:clientName`        | Solo las tools de ese backend        | Quieres un único backend (p. ej. `/mcp/petstore`)                                         |
| `/mcp-custom/:bundleName` | Un subconjunto entre backends curado | Has curado exactamente las tools que un agente necesita — [crea uno →](/es/guide/bundles) |

No hay un endpoint "todo aplanado junto": para exponer varios backends por una sola URL,
[cura un bundle](/es/guide/bundles). El tercer endpoint es el **control plane**:

| Endpoint    | Le da al cliente                                                  | Úsalo cuando                           |
| ----------- | ----------------------------------------------------------------- | -------------------------------------- |
| `POST /mcp` | Tools `sys_*` para gestionar el gateway — **no** tools de backend | Un agente debe operar el gateway mismo |

Todos los endpoints hablan **Streamable HTTP** (el transporte SSE legacy `GET /sse` +
`POST /messages` fue eliminado).

> **Nota:** "client" está sobrecargado en esta página — `:clientName` en una URL es el
> nombre que diste a un **backend** en el registro (p. ej. `petstore`), no a la app que se
> conecta al bridge (Claude Desktop, Cursor, …). Este doc usa "client" para ambos; mira
> el contexto. Consulta [Conceptos y glosario](/es/guide/concepts) para el vocabulario
> completo.

## Apuntar un cliente

La mayoría de los clientes aceptan una URL remota de servidor MCP — apúntalos a un shard de backend:

```json
{
  "mcpServers": {
    "petstore": { "url": "https://bridge.example.com/mcp/petstore" }
  }
}
```

Para un bundle curado, cambia la URL a `https://bridge.example.com/mcp-custom/support-agent`;
para operar el gateway mismo, usa `https://bridge.example.com/mcp`.

¿Prefieres no editar ese JSON a mano? `gateway connect --client cursor --scope client --name petstore`
(y amigos para Claude Desktop, Windsurf, Continue) genera el mismo snippet desde el CLI —
consulta [Referencia CLI →](/es/guide/cli).

## Autenticación

Si configuraste `MCP_API_KEYS` (recomendado en producción), el cliente debe presentar
una key como token Bearer:

```
Authorization: Bearer <mcp-api-key>
```

Los clientes que soportan headers custom pueden configurarlo directamente; para otros, pon
el bridge detrás de un proxy que lo inyecte. Las keys pueden tener **scope** a
clientes/tools específicos y recibir una expiración — consulta [Control de acceso](/es/guide/access-control).
El bridge también puede aceptar **JWTs OAuth2/OIDC** como credencial cuando
`JWT_JWKS_URL` está configurado.

## Verificar la conexión

- `GET /health` debe devolver `{ "status": "ok" }`.
- La lista de tools del cliente debe poblarse después de conectar; si está vacía, el
  cliente/tool puede estar deshabilitado o la key fuera de scope.
- `GET /metrics` (admin autenticado) expone `mcp_tool_calls_total{outcome}` una vez que las
  llamadas empiezan a fluir.

Siguiente: **[Registrar backends →](/es/guide/registering-backends)** para darles algo
a los clientes, o **[Control de acceso →](/es/guide/access-control)** para hacer scope de
quién puede llamar a qué.
