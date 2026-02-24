# WORKLOG

## 2026-02-24

### Cambios
- Ajuste en `server.js` para `model=lab`:
  - Si LAB devuelve `result.via = "degraded"`, el proxy retorna mensaje degradado amigable.
  - Se agregan rutas de extracción de texto: `result.reply.message|reply.message|message`.
- Ajuste en fallback `arkaios -> lab`:
  - Si LAB viene en `degraded`, se construye salida degradada estándar cuando no hay mensaje útil.
- Documentación actualizada en `README.md`:
  - comportamiento de resiliencia/fallback,
  - aclaración de salida para `model=lab` en modo degradado.

### Resultado esperado
- Flujo e2e estable con respuesta `200` incluso ante `429/5xx` upstream.
- Mensaje final legible para usuario final en lugar de `via: degraded`.
