<!--
  Versión en español. El repo canónico en inglés sigue siendo README.md.
  Esta duplicación se mantiene sincronizada a mano; si haces un cambio
  significativo en cualquiera de los dos, replica el cambio aquí.

  Repo slug usado en los enlaces/badges de abajo: `aico-dot-team-code/mcpbridge`.
  Si tu repo de GitHub se llama diferente, busca-y-reemplaza ese slug aquí.
-->
<div align="center">

<img src="docs/public/favicon.svg" width="72" height="72" alt="Logo de MCP REST Bridge" />

# MCP REST Bridge

### Convierte cualquier API REST o servidor MCP en herramientas de IA seguras y gobernadas.

**El gateway MCP auto-hospedado con una UI de administración real** — auto-descubrimiento
OpenAPI-a-MCP, guardrails por herramienta, RBAC, circuit breaking. Un único binario. Sin
Kubernetes.

[![Bun](https://img.shields.io/badge/runtime-Bun-black?logo=bon)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Model Context Protocol](https://img.shields.io/badge/Model_Context_Protocol-compatible-00a99a)](https://modelcontextprotocol.io)
[![Licencia: MIT](https://img.shields.io/badge/license-MIT-informational)](LICENSE)
[![PRs bienvenidos](https://img.shields.io/badge/PRs-welcome-00a99a)](#-contribuir)
[![Estrella en GitHub](https://img.shields.io/github/stars/aico-dot-team-code/mcpbridge?style=social)](https://github.com/aico-dot-team-code/mcpbridge)

[**🎮 Demo en vivo**](https://aico-dot-team-code.github.io/mcpbridge/demo/) ·
[**Web y docs**](https://aico-dot-team-code.github.io/mcpbridge/) ·
[Primeros pasos](#-quickstart-de-60-segundos) ·
[Funcionalidades](#-funcionalidades) ·
[¿Por qué esto frente a las alternativas?](#-mcp-rest-bridge-vs-las-alternativas)

</div>

---

**MCP REST Bridge** es un **gateway/proxy/agregador MCP** open-source para el
[Model Context Protocol](https://modelcontextprotocol.io) (implementa la **versión de spec
`2025-06-18`**). Apúntalo a un spec OpenAPI/Swagger y convierte tu API REST en herramientas
MCP automáticamente. Registra un servidor MCP existente y lo re-expone a través del mismo
pipeline gobernado. Cada llamada pasa por protección SSRF, sanitización de prompt-injection,
rate limits por herramienta, circuit breakers, RBAC y un log de auditoría a prueba de
manipulaciones — y todo lo gestionas desde una **UI de administración integrada**, no desde
un montón de YAML. Probado contra **Claude Desktop**, **Cursor** y agentes MCP personalizados.

<div align="center">

![MCP REST Bridge admin UI — servidores, herramientas y salud registrados](docs/public/screenshots/servers.png)

**▶ [Prueba la demo en vivo](https://aico-dot-team-code.github.io/mcpbridge/demo/)** — la UI
de administración completa funcionando con datos mock, sin instalar nada.

</div>

## ✨ Por qué MCP REST Bridge

- **Una UI de admin real, no ficheros de config.** Un dashboard Vue 3 completo para
  registrar servidores, curar bundles de herramientas, definir guardrails, rotar keys,
  supervisar el uso y leer el log de auditoría.
- **Bidireccional en un binario.** REST/OpenAPI → MCP **y** MCP → gateway MCP. Agrega
  muchos backends detrás de un único endpoint.
- **Seguro por defecto.** Protección SSRF + DNS-rebinding con anclaje de IP, sanitización
  de prompt-injection, detección de secretos y restricciones fail-closed de keys por
  herramienta — integrado, no como plugin.
- **Funcionalidades enterprise sin peso enterprise.** RBAC, equipos, audit hash-chain +
  SIEM, canary/failover, tracing OpenTelemetry, versionado de config — **sin Kubernetes y
  sin base de datos externa.**
- **Ejecuta en cualquier sitio.** Proceso único Bun + `bun:sqlite`. Una imagen Docker, o
  `bun src/index.ts`.

## 🚀 Quickstart de 60 segundos

### Docker

```bash
docker build -t mcpbridge .

docker run -p 3000:3000 \
  -e NODE_ENV=development \
  -e SESSION_COOKIE_SECURE=false \
  -e BOOTSTRAP_ADMIN_USERNAME=admin \
  -e BOOTSTRAP_ADMIN_PASSWORD=change-me-min-12-chars \
  -v "$PWD/data:/app/data" \
  mcpbridge
```

Abre la UI de admin en **http://localhost:3000/admin** e inicia sesión con las credenciales
bootstrap. (`NODE_ENV=development` + `SESSION_COOKIE_SECURE=false` son solo para HTTP local —
en producción ejecuta sobre HTTPS y elimina ambas.)

### Bun (desarrollo local, con hot reload)

```bash
bun install
cp .env.example .env                 # luego configura BOOTSTRAP_ADMIN_PASSWORD (mín 12 chars)
cd admin-ui && bun install && cd ..

bun run dev:all                      # backend :8790 + admin UI :8791
# → abre http://localhost:8791/admin/
```

> **Nota:** el modo dev usa a propósito puertos distintos (8790/8791) que el 3000 por
> defecto de Docker/producción — puertos altos y poco comunes para que un servidor dev local
> no choque con 3000 (o con una instancia real de gateway) que también puedas tener
> ejecutándose. Consulta [Configuración](https://aico-dot-team-code.github.io/mcpbridge/guide/configuration)
> para la referencia completa de puertos.

### Registra tu primera API REST (auto-descubierta desde OpenAPI)

Desde la UI: **Añadir servidor → REST**, pega una URL de OpenAPI, listo. O vía API:

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

### Registra un servidor MCP existente como upstream

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

### Apunta un cliente MCP al bridge

```json
{
  "mcpServers": {
    "bridge": { "url": "http://localhost:3000/mcp" }
  }
}
```

Sirve herramientas de cuatro maneras: agregado `/mcp`, por cliente `/mcp/:name`,
bundles curados `/mcp-custom/:bundle`, o SSE legacy `/sse`.

### CLI (config-as-code)

¿Prefieres gestionar la configuración como un fichero YAML revisable en lugar de hacer clic
en la UI? Un CLI `gateway` viene en el repo — sin instalación separada, solo
`bun run cli -- <command>`:

```bash
bun run cli -- login --url http://localhost:3000 --token $ADMIN_API_KEY
bun run cli -- pull    # escribe la config en vivo a gateway.yaml
bun run cli -- plan    # muestra drift vs. gateway.yaml, exit no-cero si hay (CI-friendly)
bun run cli -- apply   # registra servidores + aplica config desde gateway.yaml
```

Consulta **[CLI docs →](https://aico-dot-team-code.github.io/mcpbridge/guide/cli)** para la
referencia completa de comandos y el formato de `gateway.yaml`.

## 🧩 Funcionalidades

**Conecta cualquier cosa**

- Auto-descubrimiento **OpenAPI / Swagger → MCP** — apunta a un spec, obtén tools al instante
- Gateway / agregador **MCP → MCP** (upstreams Streamable HTTP + SSE)
- Definiciones manuales de tools cuando no hay spec
- Cuatro modos de servir: agregado, shard por cliente, bundles curados, SSE legacy

**Gobernar y asegurar**

- Protección SSRF + DNS-rebinding, **anclaje de IP** por upstream
- **Guardrails**: sanitización de prompt-injection, detección de secretos, reglas de denegación de inputs
- **Rate limits, timeouts, circuit breakers, restricciones de keys permitidas** por herramienta
- **RBAC** (admin / operator / auditor / viewer) + **multi-tenancy por equipos**
- **Log de auditoría a prueba de manipulaciones** (encadenado por hash) + streaming a SIEM

**Opera con confianza**

- **UI de admin** (Vue 3): dashboard, servidores, bundles, keys, uso, alertas, programaciones, auditoría
- **CLI** (`bun run cli`) para config-as-code: `login` / `pull` / `plan` / `apply` contra `gateway.yaml` — consulta [CLI docs](https://aico-dot-team-code.github.io/mcpbridge/guide/cli)
- Monitorización de salud + auto-eliminación; **canary / failover** secundarios
- **Versionado de config + rollback**, import / export
- Prometheus `/metrics` + tracing **OpenTelemetry (OTLP)** por llamada de tool
- Alertas de **anomalía / pico de uso** vía webhooks
- Tools compuestas / macro, una meta-tool `search_tools` y un playground de requests

**Ejecuta en cualquier sitio**

- Proceso único Bun, almacenamiento `bun:sqlite` — **sin DB externa, sin Kubernetes**
- Una imagen Docker, o `bun src/index.ts`

## 🔀 Cómo funciona

<p align="center">
  <img
    alt="Los clientes AI envían llamadas de tools por MCP; el bridge ejecuta cada una por SSRF, guardrails, breaker, dispatch y audit, y luego despacha a tus backends REST o MCP"
    src="docs/public/screenshots/how-it-works.png"
    width="860"
  />
</p>

El bridge anuncia una lista unificada de tools a cualquier cliente MCP, luego redirige cada
llamada al backend correcto a través de la pila completa de guards (chequeo SSRF →
guardrails → política por herramienta → circuit breaker → dispatch → sanitización de
response → audit).

## ⚖️ MCP REST Bridge vs. las alternativas

|                                                 | CLIs OpenAPI→MCP | Gateways pesados (k8s) | **MCP REST Bridge** |
| ----------------------------------------------- | :--------------: | :--------------------: | :-----------------: |
| REST / OpenAPI → MCP                            |        ✅        |        parcial         |         ✅          |
| Gateway MCP → MCP                               |        ❌        |           ✅           |         ✅          |
| UI de admin                                     |        ❌        |        algunos         |     ✅ Vue SPA      |
| Seguridad integrada (SSRF, inyección, secretos) |        ❌        |        algunos         |         ✅          |
| RBAC + audit + equipos                          |        ❌        |           ✅           |         ✅          |
| Ejecuta sin Kubernetes                          |        ✅        |           ❌           |         ✅          |
| Sin base de datos externa                       |        ✅        |           ❌           |  ✅ (Bun + SQLite)  |

_Las capacidades varían según el proyecto; esto es posicionamiento general, no un scorecard
de ninguna herramienta específica._

## 📚 Documentación

Las docs completas viven en la **[web del proyecto](https://aico-dot-team-code.github.io/mcpbridge/)**:
[Primeros pasos](https://aico-dot-team-code.github.io/mcpbridge/guide/getting-started) ·
[Funcionalidades](https://aico-dot-team-code.github.io/mcpbridge/guide/features) ·
[¿Por qué MCP REST Bridge?](https://aico-dot-team-code.github.io/mcpbridge/guide/why-mcp-rest-bridge)

## 🛠️ Stack técnico

[Bun](https://bun.sh) · TypeScript (strict) · Express 5 ·
[`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol) ·
`bun:sqlite` · Vue 3 + Vite (admin UI). Sin ORM, dependencias mínimas.

## 🤝 Contribuir

¡Contribuciones bienvenidas! Después de cualquier cambio:

```bash
tsc --noEmit                            # type-check del backend
bun test                                # tests del backend (deberían estar 100% verdes)
cd admin-ui && bun run typecheck        # type-check del admin UI
cd admin-ui && bun run build            # build de producción del admin UI
```

Abre un issue para discutir cambios grandes primero. Las buenas primeras contribuciones
están etiquetadas en el tracker.

## 📄 Licencia

MIT — consulta [`LICENSE`](LICENSE).

---

<div align="center">

**Palabras clave:** MCP gateway · MCP proxy · MCP aggregator · Model Context Protocol ·
OpenAPI to MCP · REST to MCP · self-hosted MCP · MCP admin UI · MCP RBAC · AI tool gateway

Si este proyecto te ayuda, por favor ⭐ **[destácalo en GitHub](https://github.com/aico-dot-team-code/mcpbridge)**
— es la mayor señal que ayuda a otros a descubrirlo.

</div>
