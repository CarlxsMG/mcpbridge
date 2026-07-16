# Control de acceso y multi-tenancy

El bridge separa **quién lo administra** (usuarios admin, roles) de **quién llama a las
tools** (API keys MCP / JWTs, con scope a consumidores y equipos).

## Roles de admin (RBAC)

Los usuarios admin inician sesión en la UI de admin Vue; cada acción mutante está restringida
por rol y auditada.

| Rol        | Puede hacer                                                                      |
| ---------- | -------------------------------------------------------------------------------- |
| `admin`    | Todo, incluida la gestión de usuarios, equipos y config global                   |
| `operator` | Registrar/configurar backends, guards, bundles, keys — operaciones del día a día |
| `auditor`  | Solo lectura más el log de auditoría y su verificación de integridad             |
| `viewer`   | Dashboards de solo lectura                                                       |

Los callers programáticos/CI pueden usar un token Bearer estático `ADMIN_API_KEYS` en lugar
de una sesión; las llamadas Bearer están exentas de CSRF (no son cookie-based).

Los admins también pueden iniciar sesión vía **SSO** (OIDC Authorization Code + PKCE) en
lugar de una contraseña local — una superficie de auth entrante separada de la auth del
plano de datos MCP (JWT/API-key) de abajo. Los usuarios SSO auto-provisionados siempre
reciben el rol `viewer`. Cualquier admin autenticado puede listar y revocar remotamente
sus propias sesiones activas, y cambiar su propia contraseña (lo que revoca cualquier otra
sesión) — sin superadmin para ninguna de las dos.

## API keys MCP

Las keys son lo que los callers de tools presentan. Se almacenan hasheadas (nunca en
plaintext) y el valor crudo se muestra exactamente una vez al crearse.

- **Con scope** — restringe una key a clientes y/o herramientas específicas.
- **Elevadas** — marca una key como permitida para llamar a tools marcadas como
  sensitive/elevated.
- **Lifecycle** — define expiración, revoca al instante, ve timestamps de último uso.
- **Fail-closed** — una restricción de allowed-key por herramienta se aplica incluso si la
  auth global está deshabilitada: configurarla señaliza claramente la intención.
- **Rol de sistema** — opcionalmente otorga a una key acceso `admin`/`operator`/`auditor`/
  `viewer` al control plane `/mcp` (solo super-admin puede configurarlo, desde la página Keys
  de la admin UI) — un permiso separado y aditivo al scope de arriba, ya que autoriza las
  tools `sys_*` de gestión del gateway, no llamadas a tools de backend. Consulta la sección
  "Control plane" de la [Referencia de API →](/es/guide/api-reference).

## Consumidores y cuotas

Agrupa keys bajo un **consumidor** (equipo, producto o tenant) y dale una **cuota mensual**.
El uso se trackea por consumidor para que puedas ver quién está gastando llamadas y
limitarlo.

## Equipos (multi-tenancy)

Los **equipos** acotan los clientes para que los tenants solo vean y gestionen sus propios
backends. Un super-admin con bearer lo ve todo; un usuario de sesión sin equipo es
super-admin; un usuario scoped a un equipo está limitado a su equipo. El acceso
cross-team devuelve la misma respuesta "no encontrado" que un recurso inexistente, para
que la pertenencia a equipos nunca se filtre por la forma de los errores.

## JWT / OAuth entrante

Configura `JWT_JWKS_URL` para aceptar tokens de acceso OAuth2/OIDC como credencial MCP,
verificados contra un endpoint JWKS (RS256/ES256 vía WebCrypto — sin dependencia extra).
Define `JWT_AUDIENCE` con la audiencia propia del gateway — es **obligatorio en producción**
cuando `JWT_JWKS_URL` está configurado (el bridge se niega a arrancar sin ella fuera de
desarrollo, salvo `ALLOW_UNSAFE_JWT_NO_AUDIENCE=true`), para que un token emitido para otra app
en un IdP compartido no pueda reutilizarse aquí. `JWT_ISSUER` es opcional. Esto se añade a
`MCP_API_KEYS` y a keys
gestionadas en DB.

Siguiente: **[Guardrails y resiliencia →](/es/guide/guardrails-resilience)** ·
**[Seguridad →](/es/guide/security)**
