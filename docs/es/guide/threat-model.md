# Modelo de amenazas

Esta página enuncia las fronteras de confianza alrededor de las que está diseñado MCP REST
Bridge, las capacidades de atacante contra las que defiende en cada una y — igual de
importante — lo que queda **fuera de alcance**. Complementa el comportamiento endurecido por
defecto de [Seguridad →](/es/guide/security) y el proceso de vulnerabilidades de
[Política de seguridad →](/es/guide/security-policy).

## Activos que proteger

- **Credenciales de backend** — API keys de upstream, client secrets OAuth2 y el
  `Authorization` que el gateway inyecta en nombre del caller. Un caller de tools nunca debe
  verlas.
- **Control admin** — la capacidad de registrar backends, emitir keys, editar guards o leer el
  audit log.
- **Aislamiento de tenants** — un operator acotado a un equipo no debe ver ni actuar sobre
  clientes de otro equipo.
- **Integridad del audit** — el registro a prueba de manipulaciones de cada mutación admin.
- **La red interna** — el gateway está junto a servicios que un caller público no alcanza.

## Fronteras de confianza

### 1. Cliente MCP → gateway (plano de datos)

**La cruza:** JSON-RPC de tool-call sobre `POST /mcp/:client` y `/mcp-custom/:bundle` (y el WS
proxy). **Atacante:** cualquiera que alcance el endpoint; un caller con key acotada que intenta
exceder su scope; un argumento de tool malicioso.

- Key MCP Bearer o JWT OAuth2/OIDC, comparados en tiempo constante (`safeCompare`); las keys
  pueden acotarse a clientes/tools concretos, expirar y revocarse. `REQUIRE_MCP_AUTH=true` falla
  cerrado incluso antes de que exista una key.
- Validación de Origin en requests originados en navegador; rate limits por sesión; body
  acotado (64 kb) y cap de profundidad JSON.
- Los guardrails de input (deny-rules, detección de secretos) corren antes del dispatch; los
  métodos no idempotentes nunca se reintentan.

**Riesgo residual:** si no hay material de auth configurado y `REQUIRE_MCP_AUTH` no está puesto,
el plano de datos está abierto (se loguea un warning ruidoso al arrancar). Un poseedor de key
puede llamar a cualquier tool dentro de su scope.

### 2. Operator/admin → gateway (plano de control + admin API)

**La cruza:** `POST /mcp` (tools `sys_*`) y `/admin-api/*`. **Atacante:** un admin de menor
privilegio que intenta escalar; una sesión robada; CSRF desde una página maliciosa.

- El plano de control `/mcp` es **fail-closed** (`rootMcpAuth`) — sin fallback "sin configurar
  implica abierto"; un caller debe resolver a un rol de sistema real, y las tools sensibles
  requieren step-up.
- Admin API: key Bearer estática **o** login de sesión argon2id; RBAC (`admin`/`operator`/
  `auditor`/`viewer`) aplicado por ruta; las mutaciones autenticadas por cookie requieren un
  `X-CSRF-Token` que coincida; el login tiene rate limit y es anti-enumeración.
- La multi-tenancy por equipos acota cada ruta de cliente (`ensureClientAccess`), incluidas las
  operaciones en bloque.

**Riesgo residual:** un valor `ADMIN_API_KEYS` estático filtrado es admin completo (rótalo ante
sospecha). `AUTH_DISABLED=true` deshabilita todo esto — se niega a arrancar fuera de desarrollo.

### 3. Gateway → backend (saliente)

**La cruza:** la llamada HTTP/WS/GraphQL proxiada a tu upstream. **Atacante:** una URL
registrada apuntada a la red interna o a metadatos de cloud (SSRF); DNS rebinding; un redirect
abierto.

- Cada URL de backend (`health_url`, `base_url`, `openapi_url`, `graphql_url`, `mcp_url`, WS,
  canary, pool de LB, webhooks, token OAuth) se valida con `validateBackendUrl`, y su IP
  resuelta se **ancla** en el registro. El anclaje se re-valida luego con un TTL de 5 minutos
  (`IP_PIN_TTL_MS`/`refreshPinIfStale` en `src/net/ip-validator.ts`) en cada llamada REST
  posterior — el hostname se re-resuelve y la request se rechaza si ahora apunta a un rango
  privado, lo que protege contra DNS rebinding de larga duración.
- Los fetches salientes usan la IP anclada, envían el hostname original como `Host` y ponen
  `redirect: "error"`. Los rangos loopback/privados se rechazan salvo `ALLOW_PRIVATE_IPS=true`
  (solo dev). La auto-paginación sigue solo URLs del mismo host, re-ancladas.

**Riesgo residual:** un backend que esté comprometido puede devolver datos maliciosos (ver
frontera 5). El anclaje confía en la IP resuelta en el momento del registro, y dentro de la
ventana del TTL un hostname re-vinculado (rebound) sigue siendo de confianza.

### 4. Gateway → almacenamiento (en reposo)

**La cruza:** el fichero `bun:sqlite`. **Atacante:** alguien con acceso de lectura (o escritura)
al fichero de DB o a un backup.

- Los secretos de upstream se cifran en reposo con AES-256-GCM (o se delegan a una key Transit
  de Vault); los read models nunca los devuelven. Las API keys y tokens de sesión se almacenan
  como hashes SHA-256, las contraseñas como argon2id. El audit log está encadenado por hash
  (verificable) y puede streamearse a un SIEM.

**Riesgo residual:** la cadena de hash del audit es a prueba de manipulaciones **evidente**, no
**resistente** — un atacante con escritura en DB puede reescribir la historia de forma
consistente (mitiga streameando a un SIEM append-only). El cifrado es solo tan fuerte como la
custodia de `SECRET_ENCRYPTION_KEY`.

### 5. Contenido no confiado → el LLM (prompt injection)

**La cruza:** las descripciones de tools descubiertas de un spec, y las responses de backend
devueltas al modelo. **Atacante:** un backend malicioso o comprometido que intenta dirigir al
agente que llama.

- Las descripciones de tools se sanitizan (`sanitizeToolDescription`) antes de entrar al registro.
- Los guardrails de response buscan fugas de secretos y envuelven las responses no confiadas en
  un sobre seguro; la redacción declarativa puede eliminar campos.

**Riesgo residual:** el prompt injection no es totalmente resoluble en el gateway — el modelo
puede aún actuar sobre contenido adversario. Trata los backends como semi-confiados y mantén
los scopes de tools con mínimo privilegio.

## Explícitamente fuera de alcance

- **Un host comprometido / root en la máquina** — acceso completo a la DB y al material de keys
  es game over; ejecuta el gateway como el proceso aislado y no-root que ya es.
- **Vulnerabilidades del lado del backend** — el gateway gobierna el acceso; no puede volver
  seguro un backend inseguro.
- **Denegación de servicio en el borde de red** — los rate limits acotan el coste por caller,
  pero pon un WAF/LB real delante para protección volumétrica.
- **Un administrador hostil** — el RBAC limita los roles de _menor_ privilegio; un `admin`
  completo es de confianza.

Siguiente: **[Seguridad →](/es/guide/security)** · **[Política de seguridad →](/es/guide/security-policy)**
