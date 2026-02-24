# ARKAIOS Proxy Server

Este módulo permite crear un servidor proxy para redirigir tráfico hacia el gateway:

https://arkaios-gateway-open.onrender.com

## Uso local:

```bash
cd proxy
npm install
npm start

## Modo degradado (resiliencia)

Cuando los upstreams devuelven `429/5xx`, el proxy mantiene compatibilidad OpenAI y responde `200` con mensaje degradado para no romper el flujo cliente.

- Ruta: `POST /v1/chat/completions`
- Modelos: `arkaios`, `aida`, `lab`
- Fallback en cadena para `arkaios`: `aida -> lab -> degradado`

### Nota sobre `model=lab`

Si LAB responde con `result.via = "degraded"`, el proxy ahora devuelve un texto amigable (no solo `via: degraded`), reutilizando:

- `result.reply.message` / `reply.message` / `message` (si existe), o
- mensaje degradado estándar del proxy.
