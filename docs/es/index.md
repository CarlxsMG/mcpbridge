---
layout: home
title: El gateway MCP auto-hospedado con una UI de administración real
titleTemplate: MCP REST Bridge

hero:
  name: MCP REST Bridge
  text: Cualquier API REST o servidor MCP → herramientas de IA seguras y gobernadas
  tagline: El gateway MCP auto-hospedado con una UI de administración real. Auto-descubrimiento OpenAPI-a-MCP, guardrails por herramienta, RBAC y circuit breaking — en un único binario. Sin Kubernetes.
  actions:
    - theme: brand
      text: Probar la demo en vivo ↗
      link: https://aico-dot-team-code.github.io/mcpbridge/demo/
    - theme: alt
      text: Primeros pasos
      link: /es/guide/getting-started
    - theme: alt
      text: ⭐ Destacar en GitHub
      link: https://github.com/aico-dot-team-code/mcpbridge

features:
  - icon:
      src: /icons/connect.svg
      width: 28
      height: 28
      wrap: true
    title: Conecta cualquier cosa
    details: Apunta a un spec de OpenAPI/Swagger y obtén herramientas MCP al instante — o registra un servidor MCP existente como upstream. REST-a-MCP y MCP-a-MCP en el mismo gateway.
  - icon:
      src: /icons/dashboard.svg
      width: 28
      height: 28
      wrap: true
    title: Una UI de administración real
    details: No es un montón de YAML. Un dashboard Vue 3 completo para servidores, bundles de herramientas, keys, uso, alertas, programaciones y el log de auditoría.
  - icon:
      src: /icons/shield.svg
      width: 28
      height: 28
      wrap: true
    title: Seguro por defecto
    details: Protección SSRF + DNS-rebinding con anclaje de IP, sanitización de prompt-injection, detección de secretos y restricciones fail-closed de keys por herramienta — integrado, no como plugin.
  - icon:
      src: /icons/sliders.svg
      width: 28
      height: 28
      wrap: true
    title: Gobernanza por herramienta
    details: Rate limits, timeouts, circuit breakers y reglas de keys permitidas en cualquier herramienta. RBAC (admin / operator / auditor / viewer) más multi-tenancy por equipos.
  - icon:
      src: /icons/activity.svg
      width: 28
      height: 28
      wrap: true
    title: Observable y auditable
    details: Prometheus /metrics, tracing OpenTelemetry por llamada, alertas de anomalías de uso y un log de auditoría encadenado por hash, a prueba de manipulaciones, con stream a SIEM.
  - icon:
      src: /icons/server.svg
      width: 28
      height: 28
      wrap: true
    title: Ejecuta en cualquier sitio
    details: Proceso único Bun con almacenamiento bun:sqlite. Sin base de datos externa, sin Kubernetes. Una imagen Docker, o `bun src/index.ts`.
---

## Véalo en acción

Todo el bridge se gestiona desde un dashboard integrado — registra backends, cura lo que
ve cada cliente y observa salud, uso y rastros de auditoría en vivo.

<DemoReel />

> 🎮 **[Prueba la demo en vivo →](https://aico-dot-team-code.github.io/mcpbridge/demo/)** — la UI
> de administración real ejecutándose con datos mock, directamente en tu navegador. Sin
> instalación, sin registro.

## Quickstart de 60 segundos

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

Abre **http://localhost:3000/admin**, inicia sesión y añade tu primer servidor. Luego apunta
cualquier cliente MCP a `http://localhost:3000/mcp`. Tutorial completo en
**[Primeros pasos →](/es/guide/getting-started)**

## Cómo funciona

<HowItWorks />

Sirve herramientas de cuatro maneras: **agregado** `/mcp`, **por cliente** `/mcp/:name`,
**bundles curados** `/mcp-custom/:bundle`, o **SSE legacy** `/sse`.

## Por qué los equipos lo eligen

- **La UI es el producto.** La mayoría de gateways MCP open-source son solo ficheros de
  config. Este trae un dashboard que realmente le pasarías a un compañero.
- **Una herramienta, dos direcciones.** Bridge de APIs REST _y_ agregador de servidores MCP
  tras un único endpoint gobernado.
- **La seguridad no es un añadido.** SSRF, sanitización de inyección y detección de
  secretos están activadas por defecto, en cada path.
- **Sin infraestructura pesada.** Sin Kubernetes, sin Postgres, sin sidecars. Un binario y
  un fichero SQLite.

<div style="margin-top: 2.5rem; text-align: center;">

**[Empezar en 60 segundos →](/es/guide/getting-started)** &nbsp;·&nbsp;
**[⭐ Destacar en GitHub](https://github.com/aico-dot-team-code/mcpbridge)**

</div>
