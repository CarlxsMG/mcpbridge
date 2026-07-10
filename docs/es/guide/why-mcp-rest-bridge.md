# Por qué MCP REST Bridge

El ecosistema del [Model Context Protocol](https://modelcontextprotocol.io) se mueve
rápido, y el espacio de gateway/agregador está concurrido. Aquí es donde encaja MCP REST
Bridge y por qué podrías elegirlo.

> **Para quién es esto:** equipos que exponen APIs REST o agregan servidores MCP para
> agentes AI, que quieren una UI de admin y governance (RBAC, guardrails, audit) sin
> tener que levantar Kubernetes o una base de datos. Consulta "Cuando encaja bien" más
> abajo para la imagen completa, o el [FAQ →](/es/guide/faq) para preguntas específicas.

## El problema

En cuanto tienes más de un servidor MCP — o una API REST que quieres que un agente AI
use — te encuentras con las mismas preguntas:

- ¿Cómo expongo una API REST/OpenAPI a clientes MCP **sin escribir un server a mano**?
- ¿Cómo pongo **muchos backends detrás de un endpoint** y le entrego a cada cliente solo
  las tools que necesita?
- ¿Cómo evito que una tool call golpee mi **red interna** (SSRF), filtre **secretos** o
  sea manipulada por **prompt injection**?
- ¿Cómo consigo **rate limits, RBAC, audit y observabilidad** — sin levantar Kubernetes y
  una base de datos?

## El enfoque

MCP REST Bridge es un único gateway auto-hospedado que hace todo lo anterior y se
**gestiona desde una UI de admin real, o como YAML versionado vía el CLI `gateway`** — no
scripteando una admin API raw a mano.

- **Bidireccional.** REST/OpenAPI → MCP **y** MCP → MCP, en un único proceso.
- **Seguro por defecto.** Protección SSRF/DNS-rebinding, anclaje de IP, sanitización de
  prompt-injection y detección de secretos siempre activas.
- **Baterías incluidas.** Guardrails por tool, RBAC, equipos, canary/failover, versionado
  de config, tracing OpenTelemetry y un log de auditoría encadenado por hash.
- **Testeado con rigor.** Una suite de 280+ ficheros en el backend, Vitest para el admin UI,
  e2e con Playwright, y mutation testing con Stryker que verifica que los tests atrapan de
  verdad los bugs inyectados.
- **Ligero.** Bun + SQLite. Sin DB externa, sin Kubernetes.

## Cómo se compara

La mayoría de herramientas en este espacio caen en tres categorías:

|                                                 | CLIs OpenAPI→MCP | Gateways pesados (k8s) | **MCP REST Bridge** |
| ----------------------------------------------- | :--------------: | :--------------------: | :-----------------: |
| REST / GraphQL / OpenAPI → MCP                  |        ✅        |        parcial         |         ✅          |
| Gateway MCP → MCP                               |        ❌        |           ✅           |         ✅          |
| UI de admin                                     |        ❌        |        algunos         |     ✅ Vue SPA      |
| Seguridad integrada (SSRF, inyección, secretos) |        ❌        |        algunos         |         ✅          |
| RBAC + audit + equipos                          |        ❌        |           ✅           |         ✅          |
| Ejecuta sin Kubernetes                          |        ✅        |           ❌           |         ✅          |
| Sin base de datos externa                       |        ✅        |           ❌           |  ✅ (Bun + SQLite)  |

- **Conversores/CLIs OpenAPI→MCP** son geniales para una traducción única, pero no
  gestionan una flota en ejecución — sin UI, sin policy por tool, sin audit.
- **Gateways pesados/enterprise** son potentes pero asumen contenedores, Kubernetes y
  a menudo una base de datos y un identity provider cloud.

MCP REST Bridge apunta al medio: **el governance de un gateway enterprise con el footprint
de un único binario**, más una UI que realmente le pasarías a un compañero.

_Las capacidades de otros proyectos varían y evolucionan rápido — esto es posicionamiento
general, no un scorecard de ninguna herramienta específica. Comprueba cada proyecto para
su feature set actual._

## Cuando encaja bien

- Quieres exponer APIs REST internas a agentes AI **de forma segura y rápida**.
- Estás agregando varios servidores MCP y necesitas **un endpoint gobernado** con control
  de acceso.
- Quieres control **auto-hospedado** y un audit trail, sin operar infra pesada.

## Cuando podría no encajar

- Necesitas SaaS gestionado con SLA (esto es open source auto-hospedado con licencia MIT).
- Requieres Kubernetes-nativo, routing multi-cluster como un hard requirement hoy.

¿Listo? **[Primeros pasos →](/es/guide/getting-started)**
