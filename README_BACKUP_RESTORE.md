# Backup y Restore desde el proxy

Este documento describe cómo exponer las operaciones de **backup** y **restore** del core de Arkaios a través del servicio proxy. La idea es ofrecer un único endpoint protegido que pueda ser consumido por los mantenedores sin exponer directamente la infraestructura interna.

## Requisitos

- Node.js 18+
- Variables de entorno configuradas (ver `.env.example`).
- API key del proxy (`PROXY_API_KEY`) para autenticar las solicitudes.
- Llave interna del servicio de backup (`BACKUP_INTERNAL_KEY` / `RESTORE_INTERNAL_KEY`).

## Variables de entorno relevantes

| Variable | Descripción |
|----------|-------------|
| `BACKUP_BASE_URL` | URL base del servicio que ejecuta el proceso de exportación. |
| `BACKUP_PATH` | Ruta relativa para la exportación (default `/backup/export`). |
| `BACKUP_INTERNAL_KEY` | Token Bearer que el core espera para autorizar el backup. |
| `RESTORE_BASE_URL` | URL base del servicio que recibe restauraciones. |
| `RESTORE_PATH` | Ruta relativa para el restore (default `/backup/restore`). |
| `RESTORE_INTERNAL_KEY` | Token Bearer para autorizar la restauración. |
| `BACKUP_TIMEOUT_MS` | Tiempo máximo de espera para completar la operación (default 60000 ms). |

> **Nota:** Si `RESTORE_*` no se especifica se reutilizarán los valores de `BACKUP_*`.

## Endpoints expuestos por el proxy

| Método | Ruta | Descripción |
|--------|------|-------------|
| `POST` | `/v1/backup/export` | Ejecuta el proceso de backup y devuelve el artefacto recibido (por ejemplo un `.tar.gz`). |
| `POST` | `/v1/backup/restore` | Reenvía el payload recibido al servicio de restore. Útil para cargar un backup previamente generado. |
| `GET` | `/v1/healthz` | Health check autenticado (útil para monitoreo interno y validar API key). |
| `GET` | `/healthz` | Health check público sin autenticación. |

Ambas rutas de backup/restore requieren enviar el header `Authorization: Bearer <PROXY_API_KEY>` igual que el resto de los endpoints bajo `/v1/*`.

## Ejemplos con `curl`

### 1. Exportar un backup

```bash
curl -X POST \
  https://arkaios-service-proxy.example.com/v1/backup/export \
  -H "Authorization: Bearer $ARKAIOS_PROXY_KEY" \
  --output arkaios-backup.tar.gz
```

Si el backend responde con `application/octet-stream` el proxy mantendrá los encabezados `content-type` y `content-disposition` para facilitar la descarga directa.

### 2. Restaurar desde un archivo

```bash
curl -X POST \
  https://arkaios-service-proxy.example.com/v1/backup/restore \
  -H "Authorization: Bearer $ARKAIOS_PROXY_KEY" \
  -H "Content-Type: application/json" \
  -d '{"archive":"base64-del-backup"}'
```

El cuerpo enviado se reenvía tal cual al servicio de restore. Si tu backend espera multipart/form-data puedes adaptar el fetch o enviar los campos correspondientes desde el cliente.

## Seguridad

- Rotar los tokens del proxy y del servicio core después de cada uso sensible.
- Mantener el proxy detrás de HTTPS.
- Registrar las descargas y restauraciones en logs protegidos.
- Asegurarse de que el rol asociado a la key del core solo tenga permisos mínimos necesarios.

## Resolución de problemas

1. **Timeout alcanzado:** incrementa `BACKUP_TIMEOUT_MS` si la exportación tarda más de un minuto.
2. **Errores 401/403:** confirma que la llave interna configurada coincide con la esperada por el core.
3. **Respuesta inesperada:** habilita el nivel `debug` en `morgan` o agrega logs temporales para inspeccionar el cuerpo devuelto por el backend.

