# Seguridad

La seguridad está integrada en el camino por defecto de MCP REST Bridge, no añadida
después. Como el bridge llama a backends _en nombre de_ clientes AI, defiende ambas
direcciones: evita que el bridge se convierta en una herramienta de ataque (SSRF), y evita
que la salida no confiable del backend manipule el modelo (prompt injection).

## Egreso de red (SSRF y DNS rebinding)

- Cada URL de backend — URLs base/health de REST y URLs upstream de MCP — se valida
  **antes del registro** y se bloquea si resuelve a una dirección privada/loopback/
  link-local (salvo que `ALLOW_PRIVATE_IPS=true`, pensado solo para dev local).
- La IP resuelta se **ancla**, así un cambio posterior de DNS no puede redirigir un
  backend ya registrado a un host interno (protección DNS-rebinding).
- La resolución DNS usa el resolver de Bun directamente, para resultados estructurados y
  resistentes a spoofing.

## Validación de requests del navegador

- **Allowlisting CORS** — la admin API rechaza requests cross-origin fuera de un
  allowlist explícito; los orígenes wildcard nunca se combinan con requests
  autenticadas.
- **Validación de Origin / Sec-Fetch-Site** — cada endpoint de transporte MCP (incluidos
  upgrades WebSocket raw) aplica las verificaciones de origen de la spec MCP,
  independientemente de CORS.
- **Limitación de profundidad JSON** — los cuerpos de request entrantes se chequean
  contra una profundidad máxima de anidamiento configurable, bloqueando intentos de
  denegación de servicio por payloads profundamente anidados antes de que lleguen al
  código de aplicación.

## Guardrails de contenido

Guardrails por herramienta — reglas de denegación de inputs, detección de secretos,
sanitización de responses, redacción de campos — escanean ambas direcciones de cada llamada,
y se ejecutan **antes** del circuit breaker, de modo que una llamada rechazada nunca consume
un slot de probe del breaker. Consulta **[Guardrails y resiliencia →](/es/guide/guardrails-resilience)**
para el conjunto completo.

## Control de acceso

Admin RBAC (`admin` / `operator` / `auditor` / `viewer`), API keys MCP (con scope,
hasheadas, restricciones fail-closed de allowed-key) y multi-tenancy por equipos controlan
quién puede administrar el bridge y quién puede llamar a qué tools. Consulta
**[Control de acceso y multi-tenancy →](/es/guide/access-control)** para roles, scoping de
keys y aislamiento por equipos.

## Auditoría a prueba de manipulaciones

Cada mutación admin se escribe en un **log de auditoría encadenado por hash**
(`hash = SHA256(JSON.stringify([prev_hash, actor, action, target, detail, created_at]))`) —
una pre-imagen codificada en JSON, no una unión por delimitador, ya que campos influenciados
por el caller como `target` y `detail` podrían colisionar entre filas distintas — de modo que
cualquier edición o eliminación retroactiva rompe la cadena y es detectable vía un endpoint
de verificación. Los eventos también pueden streamarse a un SIEM en tiempo real
(`AUDIT_SINK_URL`).

## Checklist de hardening para producción

- Sirve sobre **HTTPS** y deja `SESSION_COOKIE_SECURE=true` (las cookies pasan a ser
  `__Host-`/Secure).
- Define `MCP_API_KEYS` fuertes y, donde aplique, restricciones de allowed-key por
  herramienta.
- Mantén `ALLOW_PRIVATE_IPS` **sin definir** (los backends de producción deben ser públicos
  o explícitamente allow-listados).
- Solo habilita `TRUST_PROXY` cuando estés realmente detrás de un reverse proxy de
  confianza.
- Nunca ejecutes con auth deshabilitada fuera de desarrollo local.

Consulta **[Configuración →](/es/guide/configuration)** para todas las variables relevantes.
