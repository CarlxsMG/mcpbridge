<!-- GENERATED FILE — DO NOT EDIT. Written by scripts/generate.ts from src/routes/error-codes.ts. -->

# Códigos de error

Todos los errores que devuelve la pasarela llevan un `code` estable y legible por máquina. Actúa sobre el código, no sobre el mensaje: los mensajes están escritos para personas, llevan detalles concretos de cada petición y pueden cambiar. Los códigos forman parte del contrato de la API.

## El sobre

Los errores comparten una misma forma en la API de administración, en los planos MCP y en el proxy WebSocket. El `request_id` se repite en la cabecera de respuesta `X-Request-ID` y en el registro de auditoría, así que puedes enlazar el mensaje que ve un usuario con la petición exacta que lo produjo.

```json
{
  "error": {
    "code": "CLIENT_NOT_FOUND",
    "message": "Client not found",
    "request_id": "01J8Z5X9WQ4H0T6C3N2K7M1P8R"
  }
}
```

## Códigos

| Código                            | Significado                                                                                         |
| --------------------------------- | --------------------------------------------------------------------------------------------------- |
| `ALERT_NOT_FOUND`                 | No existe ninguna regla de alerta con ese id.                                                       |
| `ALREADY_EXISTS`                  | Ya existe una entidad con ese nombre.                                                               |
| `ALREADY_REVOKED`                 | La clave de API ya estaba revocada.                                                                 |
| `APPROVAL_NOT_FOUND`              | No existe ninguna solicitud de aprobación con ese id.                                               |
| `BACKUP_FAILED`                   | No se pudo crear la copia de seguridad de la base de datos.                                         |
| `BACKUP_STREAM_FAILED`            | La copia de seguridad se creó pero falló al transmitirse al cliente.                                |
| `BAD_REQUEST`                     | Respaldo genérico 4xx para una petición que la pasarela no pudo procesar.                           |
| `BUNDLE_NOT_FOUND`                | No existe ningún bundle con ese nombre.                                                             |
| `CATALOG_ENTRY_NOT_FOUND`         | No existe ninguna entrada de catálogo con ese slug.                                                 |
| `CLIENT_NOT_FOUND`                | No hay ningún cliente registrado con ese nombre — también se devuelve si pertenece a otro equipo.   |
| `COMPOSITE_NOT_FOUND`             | No existe ninguna herramienta compuesta (macro) con ese nombre.                                     |
| `CONSUMER_EXISTS`                 | Ya existe un consumidor con ese nombre.                                                             |
| `CONSUMER_NOT_FOUND`              | No hay ningún consumidor con ese id — también se devuelve si pertenece a otro equipo.               |
| `CSRF_VALIDATION_FAILED`          | Una mutación autenticada por sesión llegó sin una cabecera X-CSRF-Token coincidente.                |
| `DISCOVERY_ERROR`                 | El descubrimiento de herramientas contra el backend no devolvió nada utilizable.                    |
| `EMPTY_BUNDLE`                    | El bundle no tiene herramientas, así que no se puede generar un enlace de instalación.              |
| `EXAMPLE_NOT_FOUND`               | No existe ningún ejemplo guardado con ese id para esta herramienta.                                 |
| `FORBIDDEN`                       | Quien llama está autenticado pero no tiene el rol que requiere esta acción.                         |
| `IMMUTABLE_ENTRY`                 | Las entradas de catálogo integradas no se pueden editar ni borrar en caliente.                      |
| `IMPORT_ERROR`                    | Una importación de configuración no se pudo interpretar o aplicar; el mensaje indica el motivo.     |
| `INSTALL_LINK_NOT_FOUND`          | El enlace de instalación no existe, o ha caducado.                                                  |
| `INTERNAL_ERROR`                  | Fallo interno no controlado; los detalles están en los logs bajo este id de petición.               |
| `INVALID_ARGS`                    | Los argumentos de un ejemplo guardado no encajan con el esquema de entrada de la herramienta.       |
| `INVALID_CREDENTIALS`             | La pareja usuario/contraseña fue rechazada al iniciar sesión.                                       |
| `INVALID_CRON`                    | No se pudo interpretar la expresión cron de una programación.                                       |
| `INVALID_INTERVAL`                | El intervalo de sondeo de un monitor está fuera del rango aceptado.                                 |
| `INVALID_MODE`                    | Se indicó un modo de canary no reconocido.                                                          |
| `INVALID_NAME`                    | Un campo de nombre incumple las reglas de nomenclatura de su entidad.                               |
| `INVALID_SCHEMA`                  | El JSON Schema indicado no es un esquema de objeto válido.                                          |
| `INVALID_SESSION_ID`              | La cabecera Mcp-Session-Id no es un UUID v4.                                                        |
| `INVALID_SLUG`                    | Un slug de catálogo no cumple el formato requerido en minúsculas con guiones.                       |
| `INVALID_STEPS`                   | La lista de pasos de una herramienta compuesta está vacía o no es utilizable.                       |
| `INVALID_STRATEGY`                | Se indicó una estrategia de balanceo de carga no reconocida.                                        |
| `INVALID_TARGET`                  | Una programación o monitor apunta a un objetivo que no corresponde a su tipo.                       |
| `INVALID_URL`                     | Una URL indicada está mal formada, usa un esquema rechazado o resuelve a una dirección bloqueada.   |
| `INVALID_WEIGHT`                  | Un peso de balanceo o de canary está fuera del rango aceptado.                                      |
| `JSON_TOO_DEEP`                   | El cuerpo JSON anida más de lo permitido (protección contra agotamiento del parser).                |
| `LAST_ADMIN_PROTECTED`            | El cambio dejaría la instancia sin ningún usuario administrador, así que se rechazó.                |
| `LAST_SUPERADMIN_PROTECTED`       | El cambio dejaría la instancia sin ningún super-admin sin equipo, así que se rechazó.               |
| `MCP_KEY_NOT_FOUND`               | No existe ninguna clave de API MCP gestionada con ese id.                                           |
| `NAME_COLLISION`                  | El nombre ya está ocupado por otro tipo de entidad en el mismo espacio de nombres.                  |
| `NOT_CONFIGURED`                  | La funcionalidad invocada todavía no tiene configuración en este cliente.                           |
| `NOT_FOUND`                       | 404 genérico para un recurso sin un código más específico.                                          |
| `NOT_PENDING`                     | La aprobación ya no está pendiente, así que no se puede aprobar ni rechazar.                        |
| `NOT_REST`                        | La operación solo se aplica a clientes REST, y este cliente no lo es.                               |
| `ORIGIN_NOT_ALLOWED`              | La cabecera Origin del navegador falta o no está en la lista permitida configurada.                 |
| `POLICY_EXISTS`                   | Ya existe una política de guardas con ese nombre.                                                   |
| `POLICY_NOT_FOUND`                | No existe ninguna política de guardas con ese nombre.                                               |
| `RATE_LIMITED`                    | Se superó un límite de peticiones; reintenta pasado el intervalo que indica la respuesta.           |
| `SCHEDULE_NOT_FOUND`              | No existe ninguna programación de mantenimiento con ese id.                                         |
| `SCHEMA_UNAVAILABLE`              | No se pudo obtener o interpretar el esquema OpenAPI/GraphQL del backend.                            |
| `SECRETS_PROVIDER_ERROR`          | El proveedor externo de secretos (p. ej. Vault) rechazó la petición o no pudo atenderla.            |
| `SECRETS_PROVIDER_UNCONFIGURED`   | La operación necesita un proveedor externo de secretos y no hay ninguno configurado.                |
| `SECRET_BOX_NOT_CONFIGURED`       | SECRET_ENCRYPTION_KEY no está definida, así que la pasarela no guarda ni genera secretos.           |
| `SESSION_NOT_FOUND`               | No existe ninguna sesión MCP con ese id.                                                            |
| `SNAPSHOT_NOT_FOUND`              | No existe ninguna instantánea de configuración con ese id.                                          |
| `SSO_DISCOVERY_FAILED`            | No se pudo obtener el documento de descubrimiento del proveedor OIDC.                               |
| `SSO_NOT_CONFIGURED`              | Se llamó a un endpoint de SSO sin tener OIDC configurado.                                           |
| `TARGET_NOT_FOUND`                | No existe ningún destino de balanceo con ese id.                                                    |
| `TEAM_NOT_FOUND`                  | No existe ningún equipo con ese id.                                                                 |
| `TOOL_ALIAS_CONFLICT`             | El alias ya está en uso por otra herramienta.                                                       |
| `TOOL_ALIAS_INVALID`              | Un alias de herramienta incumple las reglas de nomenclatura de alias.                               |
| `TOOL_NOT_FOUND`                  | El cliente existe pero no expone ninguna herramienta con ese nombre.                                |
| `TOOL_NOT_LIVE`                   | La herramienta está catalogada pero no está activa ahora mismo en el registro.                      |
| `TRACE_NOT_FOUND`                 | No existe ninguna traza con ese id.                                                                 |
| `TRAFFIC_NOT_FOUND`               | No existe ningún registro de tráfico con ese id.                                                    |
| `UNAUTHORIZED`                    | No se presentaron credenciales válidas, o la sesión ha caducado.                                    |
| `UNKNOWN_TOOL`                    | Un bundle o una compuesta referencia una herramienta que no existe.                                 |
| `UPSTREAM_AUTH_VAULT_UNSUPPORTED` | Este modo de autenticación con el upstream no se puede almacenar en el proveedor Vault configurado. |
| `USER_EXISTS`                     | Ya existe un usuario administrador con ese nombre.                                                  |
| `USER_NOT_FOUND`                  | No existe ningún usuario administrador con ese id.                                                  |
| `VALIDATION_ERROR`                | El cuerpo o la query de la petición no pasaron la validación; el mensaje indica el campo.           |
| `WS_PROXY_TARGET_NOT_FOUND`       | No existe ningún destino de proxy WebSocket con ese nombre.                                         |

El estado HTTP no aparece a propósito: varios códigos se emiten con más de un estado. `CLIENT_NOT_FOUND`, por ejemplo, es el 404 de un cliente que no existe **y** —por diseño— el 404 idéntico de uno que pertenece a otro equipo, de forma que quien llama con ámbito de equipo no pueda sondear su existencia.
