# Política de seguridad

Esta es la política de reporte de vulnerabilidades del proyecto — cómo reportar un
issue de seguridad y qué está ya endurecido. Para configurar las features de seguridad
integradas del bridge (protección SSRF, guardrails, RBAC), consulta **[Seguridad →](/es/guide/security)**
en su lugar.

Refleja el [`SECURITY.md`](https://github.com/aico-dot-team-code/mcpbridge/blob/main/SECURITY.md)
raíz del repo.

## Versiones soportadas

MCP REST Bridge se publica actualmente como una sola línea de versiones. Los fixes de
seguridad se hacen contra la última release solo.

| Versión | Soportada |
| ------- | --------- |
| 1.0.0   | ✅        |
| < 1.0.0 | ❌        |

A medida que el proyecto madure más allá de 1.0, esta tabla se expandirá para reflejar
qué versiones mayores reciben fixes de seguridad backportados.

## Reportar una vulnerabilidad

**Por favor no abras un issue público de GitHub para vulnerabilidades de seguridad.**

Usa el [reporte privado de vulnerabilidades de GitHub](https://github.com/aico-dot-team-code/mcpbridge/security/advisories/new)
para este repositorio (pestaña "Security" → "Report a vulnerability"). Esto abre un hilo
de advisory privado solo con los maintainers, para que puedas revelar los detalles sin
abrir un issue público.

Al reportar, por favor incluye:

- Una descripción de la vulnerabilidad y su potencial impacto
- Pasos para reproducir (un repro mínimo es ideal — esto es un proxy/gateway, así que
  los traces de request/response son especialmente útiles)
- La versión/commit contra la que testaste
- Si crees que es explotable pre-auth o requiere un admin/sesión autenticado

Nuestro objetivo es acusar recibo de los reportes en pocos días laborables y mantenerte
informado mientras investigamos y arreglamos el issue. Por favor, danos tiempo razonable
para shippear un fix antes de cualquier divulgación pública.

## Qué está ya manejado vs. qué reportar

MCP REST Bridge tiene defensas integradas para varias clases de ataques específicas de
gateway. Familiarizarte con ellas te ayuda a distinguir "hardening esperado" de un bypass
real:

- **Protección SSRF / DNS-rebinding.** El registro de upstreams resuelve y _ancla_ la IP
  target (incluyendo checks para IPv4-mapped IPv6, rangos CGNAT y direcciones IPv6
  unspecified/loopback), así que un bypass de este anclaje es un reporte de alta prioridad.
- **Cifrado de secretos.** Las credenciales upstream (API keys, OAuth client secrets,
  etc.) se cifran en reposo (consulta `src/security/secret-box.ts`), no se almacenan
  como config en plaintext.
- **Log de auditoría a prueba de manipulaciones.** Las acciones admin y de proxy se
  registran en un log encadenado por hash; una forma de romper o reescribir
  silenciosamente esa cadena es un hallazgo válido.
- **Hardening de sesión/auth.** Los identificadores de sesión y las comparaciones de
  auth usan comparaciones constant-time/hashed, las guardas refuse-to-start evitan arrancar
  con config insegura (p. ej. auth deshabilitada fuera de desarrollo, CORS wildcard en
  producción), y las cookies se nombran/limitan según la seguridad de transporte efectiva.
- **Guardrails por herramienta.** Rate limiting, circuit breaking y RBAC se aplican por
  cliente/tool — una forma de saltarse estos guards para una herramienta o cliente
  específico merece reporte.

Cosas que **no** están endurecidas aún y generalmente _no_ son útiles como reportes de
seguridad salvo que lleven a un exploit concreto: gates faltantes de linter/CI, nits de
best-practice sin impacto demostrado, o denegación de servicio vía carga auto-infligida
arbitrariamente grande (salvo que cruce un límite de confianza, p. ej. un cliente no
autenticado agotando recursos pensados para ser aislados por tenant).

## Scope

Esta política cubre el código en este repositorio (el gateway, el CLI, el admin UI y la
capa de migración/persistencia de base de datos). Las vulnerabilidades en dependencias
upstream deberían reportarse generalmente a esos proyectos directamente, pero por favor
haznos saber también si las estamos usando de una forma que es explotable.

Siguiente: **[Contribuir →](/es/guide/contributing)** · **[Changelog →](/es/guide/changelog)**
