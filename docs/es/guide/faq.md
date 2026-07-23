# Preguntas frecuentes

Respuestas rápidas a las preguntas que surgen antes de llegar a las guías más profundas. Para
la historia completa, consulta [Por qué MCP REST Bridge →](/es/guide/why-mcp-rest-bridge).

## ¿Necesito Kubernetes o una base de datos separada?

No. El bridge es un único proceso [Bun](https://bun.sh) con `bun:sqlite` — un binario, un
fichero. Funciona bien dentro de un orquestador de contenedores si ya tienes uno, pero
nada de él requiere Kubernetes, Postgres o cualquier servicio externo. Consulta
[Despliegue →](/es/guide/deployment).

## ¿Funciona con Claude Desktop, Cursor u otros clientes MCP?

Sí — cualquier cliente que hable el Model Context Protocol. El bridge negocia la versión
del protocolo a través del SDK oficial de TypeScript, que soporta desde
`2024-10-07` hasta `2025-11-25` (usando `2025-03-26` por defecto cuando el cliente no indica versión), y está probado contra Claude
Desktop, Cursor y agentes personalizados. El comando CLI `gateway connect` genera configs listas para pegar
específicas para Claude Desktop, Cursor, Windsurf y Continue. Consulta
[Conectar clientes MCP →](/es/guide/connecting-clients).

## ¿Hay una versión hospedada/gestionada?

No — este es open source auto-hospedado con licencia MIT, sin oferta SaaS gestionada ni
SLA. Lo ejecutas tú; los datos son tuyos.

## ¿En qué se diferencia de una herramienta CLI OpenAPI-a-MCP?

Esas herramientas son geniales para una traducción única de spec a tools, pero no gestionan
una flota en ejecución — sin UI de admin, sin política por herramienta, sin log de
auditoría, sin manera de agregar múltiples backends tras un endpoint gobernado. Consulta la
tabla comparativa en [Por qué MCP REST Bridge →](/es/guide/why-mcp-rest-bridge) para la
imagen completa.

## ¿Puede agregar múltiples servidores MCP, no solo APIs REST?

Sí — registra un servidor MCP existente como upstream (`kind: "mcp"`) y se re-expone a
través de la misma pila de guards que un backend REST: los mismos guardrails, el mismo
RBAC, el mismo log de auditoría. Consulta [Registrar backends →](/es/guide/registering-backends).
Para exponer tools de varios backends (REST y/o MCP) a través de **un** único endpoint MCP,
cura un [bundle →](/es/guide/bundles).

## ¿Qué pasa si un backend cae?

Los health checks auto-eliminan backends inaccesibles, y los circuit breakers por
cliente fallan las llamadas rápido cuando un backend está claramente caído, en lugar
de acumular timeouts. Si configuras un canary/failover secundario, el tráfico puede
enrutarse allí automáticamente. Consulta [Guardrails y resiliencia →](/es/guide/guardrails-resilience).

## ¿Puedo gestionar la configuración como código en vez de hacer clic en la UI?

Sí — el CLI `gateway` incluido (`bun run cli`) trata la configuración como un fichero YAML
revisable: `pull` para traer la config en vivo, edítala, `plan` para previsualizar el
drift, `apply` para aplicarla. Útil para CI/CD y revisión estilo GitOps. Consulta
[CLI →](/es/guide/cli).

## ¿Cómo funcionan las actualizaciones?

Las migraciones de schema se ejecutan automáticamente al arrancar y son sólo forward — no
hay rollback automático, así que haz backup de tu base de datos SQLite antes de actualizar a
una nueva versión. Consulta [Despliegue → Actualizar](/es/guide/deployment#actualizar).

## ¿Puedo probarlo sin instalar nada?

Sí — la **[demo en vivo](https://carlxsmg.github.io/mcpbridge/demo/)** ejecuta
la UI de admin real con datos mock, directamente en tu navegador. Sin instalación, sin registro.

La demo también está localizada al español — cambia el selector de idioma en
**Account → Preferences → Language** y cada string traducible del fixture (descripciones
de tools, resúmenes de bundles, labels de API keys, nombres de alertas, labels de
teams / policies / composites / snapshots, descripciones del catálogo) se actualiza
en el sitio sin perder el estado de tu pestaña.

## ¿Qué licencia tiene?

MIT. Consulta [`LICENSE`](https://github.com/CarlxsMG/mcpbridge/blob/main/LICENSE).

## Algo no funciona — ¿dónde miro?

Consulta [Solución de problemas →](/es/guide/troubleshooting) para los problemas comunes (la
mayoría son comportamiento de seguridad deliberado en lugar de bugs), o abre un issue con
el `request_id` de la respuesta de error.

Siguiente: **[Primeros pasos →](/es/guide/getting-started)** ·
**[Contribuir →](/es/guide/contributing)**
