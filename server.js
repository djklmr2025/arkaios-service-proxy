import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import fetch from 'node-fetch';
import { Buffer } from 'node:buffer';

const app = express();
app.use(cors());
// Aumentamos el límite para permitir payloads grandes (p.ej. metadatos de backups)
app.use(express.json({ limit: '50mb' }));
app.use(morgan('dev'));
// Almacenamiento en memoria del último snapshot JSON (opcional)
let latestSnapshot = null;

const {
  PORT = 4000,
  PROXY_API_KEY,
  UPSTREAM_MAX_ATTEMPTS = '4',
  UPSTREAM_RETRY_BASE_MS = '700',
  UPSTREAM_RETRY_MAX_MS = '8000',

  // ARKAIOS
  ARKAIOS_BASE_URL,
  ARKAIOS_INTERNAL_KEY,
  ARKAIOS_OPENAI = 'false',
  ARKAIOS_PATH = '/api/chat',
  ARKAIOS_REQ_FIELD = 'input',
  ARKAIOS_RESP_PATH = 'data.text',

  // AIDA
  AIDA_BASE_URL,
  AIDA_INTERNAL_KEY,
  AIDA_PUBLIC_KEY,
  AIDA_AUTH_MODE = 'internal',    // public | internal
  AIDA_OPENAI = 'false',
  AIDA_MODE = 'gateway',          // gateway | custom | openai
  AIDA_PATH = '/aida/gateway',
  AIDA_AGENT_ID = 'puter',
  AIDA_ACTION = 'plan',
  AIDA_OBJECTIVE_FIELD = 'objective',
  AIDA_RESP_PATH = 'data.text|result.note|result.text|text|reply|response',
  // LAB MCP (wrapper HTTP)
  LAB_MCP_BASE_URL,
  LAB_MCP_PATH = '/mcp/run',
  LAB_MCP_RESP_PATH = 'result.text|data.text|text|reply|response',

  // Backup / Restore
  BACKUP_BASE_URL,
  BACKUP_INTERNAL_KEY,
  BACKUP_PATH = '/backup/export',
  RESTORE_BASE_URL,
  RESTORE_INTERNAL_KEY,
  RESTORE_PATH = '/backup/restore',
  BACKUP_TIMEOUT_MS = '60000'
} = process.env;

const asBool = v => String(v || '').toLowerCase() === 'true';
const asTimeout = ms => {
  const parsed = Number.parseInt(ms, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60000;
};
const asInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/* ---------- Auth SOLO /v1/* ---------- */
const authMiddleware = (req, res, next) => {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!PROXY_API_KEY || token === PROXY_API_KEY) return next();
  res.status(401).json({ error: 'Invalid API key' });
};
app.use('/v1', authMiddleware);

/* ---------- Helpers ---------- */
const dotGet = (obj, path) => {
  if (!path) return undefined;
  return path.split('.').reduce((acc, k) => (acc && acc[k] !== undefined ? acc[k] : undefined), obj);
};
// Permite definir múltiples rutas separadas por '|', devolviendo la primera que exista
const pickPath = (obj, pathStr) => {
  if (!pathStr) return undefined;
  const candidates = String(pathStr).split('|').map(s => s.trim()).filter(Boolean);
  for (const p of candidates) {
    const val = dotGet(obj, p);
    if (val !== undefined && val !== null) return val;
  }
  return undefined;
};
const buildDegradedText = (promptText = '') => [
  'Servicio temporalmente saturado (rate-limit en proveedores).',
  'Tu solicitud fue recibida y el sistema esta en modo degradado.',
  `Prompt: ${promptText || '(vacio)'}`,
  'Sugerencia: reintentar en 30-90 segundos.',
].join('\n');
const trimBase = b => (b || '').replace(/\/+$/, '');
const buildUrl = (base, path, query = {}) => {
  const baseTrim = trimBase(base);
  if (!baseTrim) return '';
  const raw = `${baseTrim}${path.startsWith('/') ? path : `/${path}`}`;
  const url = new URL(raw);
  const entries = Object.entries(query || {});
  for (const [key, value] of entries) {
    if (Array.isArray(value)) {
      for (const v of value) url.searchParams.append(key, v);
    } else if (value !== undefined && value !== null) {
      url.searchParams.append(key, value);
    }
  }
  return url.toString();
};

const shouldRetryStatus = status => status === 429 || (status >= 500 && status <= 599);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const retryAfterMs = response => {
  const raw = response?.headers?.get?.('retry-after');
  if (!raw) return null;
  const sec = Number.parseFloat(raw);
  if (Number.isFinite(sec) && sec > 0) return Math.round(sec * 1000);
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) {
    const diff = dateMs - Date.now();
    return diff > 0 ? diff : null;
  }
  return null;
};

async function fetchWithRetry(url, init = {}, label = 'upstream') {
  const maxAttempts = asInt(UPSTREAM_MAX_ATTEMPTS, 4);
  const baseDelay = asInt(UPSTREAM_RETRY_BASE_MS, 700);
  const maxDelay = asInt(UPSTREAM_RETRY_MAX_MS, 8000);

  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const res = await fetch(url, init);
      if (!shouldRetryStatus(res.status) || attempt === maxAttempts) return res;

      const hinted = retryAfterMs(res);
      const backoff = Math.min(maxDelay, baseDelay * 2 ** (attempt - 1));
      const jitter = Math.floor(Math.random() * 250);
      const waitMs = Math.max(hinted || 0, backoff + jitter);
      console.warn(`[${label}] retry ${attempt}/${maxAttempts} status=${res.status} wait=${waitMs}ms`);
      await sleep(waitMs);
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) throw error;
      const backoff = Math.min(maxDelay, baseDelay * 2 ** (attempt - 1));
      const jitter = Math.floor(Math.random() * 250);
      const waitMs = backoff + jitter;
      console.warn(`[${label}] retry ${attempt}/${maxAttempts} error=${String(error?.message || error)} wait=${waitMs}ms`);
      await sleep(waitMs);
    }
  }
  throw lastError || new Error('Unknown upstream error');
}

async function forwardPost({ base, path, key, body, query, timeoutMs, contentType }) {
  const url = buildUrl(base, path, query);
  if (!url) throw new Error('Missing base URL');

  const headers = key ? { authorization: `Bearer ${key}` } : {};
  let payload;
  if (Buffer.isBuffer(body)) {
    payload = body;
  } else if (typeof body === 'string') {
    payload = body;
    if (contentType) headers['content-type'] = contentType;
  } else if (body && typeof body === 'object') {
    payload = JSON.stringify(body);
    headers['content-type'] = headers['content-type'] || 'application/json';
  } else if (contentType) {
    headers['content-type'] = contentType;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: payload,
      signal: controller.signal,
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    return { response, buffer, url };
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- Backends ---------- */
function pick(modelId) {
  const m = (modelId || '').toLowerCase();
  if (m === 'aida') {
    return {
      name: 'aida',
      base: trimBase(AIDA_BASE_URL),
      openai: asBool(AIDA_OPENAI),
      mode: (AIDA_MODE || 'gateway').toLowerCase(),
      path: AIDA_PATH,
      // auth seleccionable
      authMode: (AIDA_AUTH_MODE || 'public').toLowerCase(),
      keyPublic: AIDA_PUBLIC_KEY,
      keyInternal: AIDA_INTERNAL_KEY,
      // campos gateway
      agentId: AIDA_AGENT_ID,
      action: AIDA_ACTION,
      objectiveField: AIDA_OBJECTIVE_FIELD,
      // fallback custom
      reqField: 'input',
      respPath: 'data.text',
    };
  }
  if (m === 'lab') {
    return {
      name: 'lab',
      base: trimBase(LAB_MCP_BASE_URL || 'http://localhost:8090'),
      openai: false,
      mode: 'mcp',
      path: LAB_MCP_PATH,
      reqField: 'prompt',
      respPath: LAB_MCP_RESP_PATH,
    };
  }
  // default arkaios
  return {
    name: 'arkaios',
    base: trimBase(ARKAIOS_BASE_URL),
    openai: asBool(ARKAIOS_OPENAI),
    path: ARKAIOS_PATH,
    reqField: ARKAIOS_REQ_FIELD,
    respPath: ARKAIOS_RESP_PATH,
    keyInternal: ARKAIOS_INTERNAL_KEY,
  };
}

async function callOpenAI({ base, key, modelName, messages, prompt, stream }) {
  const url = `${base}/v1/chat/completions`;
  const body = messages ? { model: modelName, messages, stream: !!stream }
                        : { model: modelName, prompt, stream: !!stream };
  return fetchWithRetry(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
  }, `openai:${modelName}`);
}

async function callCustom({ base, path, key, reqField, payload }) {
  const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;
  const body = { [reqField]: payload, model: 'custom' };
  const r = await fetchWithRetry(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
  }, 'custom');
  const text = await r.text();
  return { ok: r.ok, status: r.status, text, url };
}

// Llamada específica al MCP HTTP wrapper
async function callMCP({ base, path, payload }) {
  const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;
  const body = { command: 'arkaios.chat', params: { prompt: payload } };
  const r = await fetchWithRetry(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, 'mcp');
  const text = await r.text();
  return { ok: r.ok, status: r.status, text, url };
}

function toOpenAIChat(text) {
  return {
    id: 'proxy-chat',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
  };
}

async function fallbackArkaiosToAida(lastPrompt) {
  const a = pick('aida');
  if (!a.base || a.mode !== 'gateway') {
    return { ok: false, reason: 'aida_gateway_unavailable' };
  }

  const url = `${a.base}${a.path.startsWith('/') ? a.path : `/${a.path}`}`;
  const authKey = a.authMode === 'public' ? a.keyPublic : a.keyInternal;
  const body = { agent_id: a.agentId, action: a.action, params: { [a.objectiveField]: lastPrompt } };

  const r = await fetchWithRetry(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(authKey ? { authorization: `Bearer ${authKey}` } : {}) },
    body: JSON.stringify(body),
  }, 'aida-fallback');

  const txt = await r.text();
  if (!r.ok) return { ok: false, status: r.status, body: txt.slice(0, 600) };

  let out = txt;
  try {
    const j = JSON.parse(txt);
    const objective = dotGet(j, `result.params.${a.objectiveField}`) || dotGet(j, `params.${a.objectiveField}`);
    const picked = pickPath(j, AIDA_RESP_PATH) || j?.content;
    const steps = dotGet(j, 'result.steps') || dotGet(j, 'steps') || dotGet(j, 'result.plan') || dotGet(j, 'plan');
    const note = dotGet(j, 'result.note') || j?.note || dotGet(j, 'data.text') || j?.text;
    const parts = [];
    if (objective) parts.push(`Objetivo: ${objective}`);
    if (typeof picked === 'string' && picked) parts.push(picked);
    else if (note) parts.push(`${note}`);
    if (Array.isArray(steps) && steps.length) {
      const list = steps.map((s, i) => `${i + 1}. ${typeof s === 'string' ? s : JSON.stringify(s)}`).join('\n');
      parts.push(list);
    }
    out = parts.length ? parts.join('\n') : (typeof picked === 'string' ? picked : JSON.stringify(j));
  } catch {}

  return { ok: true, text: out };
}

async function fallbackArkaiosToLab(lastPrompt) {
  const l = pick('lab');
  if (!l.base || l.mode !== 'mcp') {
    return { ok: false, reason: 'lab_mcp_unavailable' };
  }

  const { ok, status, text, url } = await callMCP({ base: l.base, path: l.path, payload: lastPrompt });
  if (!ok) return { ok: false, status, body: text.slice(0, 600), url };

  let out = text;
  try {
    const j = JSON.parse(text);
    const picked = pickPath(j, `${l.respPath}|result.reply.message|reply.message|message`);
    const via = dotGet(j, 'result.via') || j.via;
    if (via === 'degraded') {
      out = typeof picked === 'string' && picked.trim() ? picked : buildDegradedText(lastPrompt);
    } else {
      out = typeof picked === 'string' ? picked : (j.text || j.reply || j.response || j.content || JSON.stringify(j));
    }
  } catch {}
  return { ok: true, text: out };
}

/* ---------- /v1/models ---------- */
app.get('/v1/models', (_req, res) => {
  res.json({
    object: 'list',
    data: [
      { id: 'arkaios', object: 'model', owned_by: 'arkaios' },
      { id: 'aida', object: 'model', owned_by: 'aida' },
      { id: 'lab', object: 'model', owned_by: 'arkaios-lab' },
    ],
  });
});

/* ---------- /v1/chat/completions ---------- */
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model = 'arkaios', messages = [], stream = false } = req.body || {};
    const b = pick(model);
    if (!b.base) return res.status(500).json({ error: `Missing base URL for ${b.name}` });

    // OpenAI directo
    if (b.openai) {
      const k = b.keyInternal; // si tu backend OpenAI requiere llave
      const r = await callOpenAI({ base: b.base, key: k, modelName: b.name, messages, stream });
      const dataText = await r.text();
      if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        return res.send(dataText);
      }
      return r.ok ? res.type('application/json').send(dataText) : res.status(r.status).send(dataText);
    }

    const last = messages?.length ? messages[messages.length - 1].content : '';

    // ---- AIDA modo gateway ----
    if (b.name === 'aida' && b.mode === 'gateway') {
      const url = `${b.base}${b.path.startsWith('/') ? b.path : `/${b.path}`}`;
      const authKey = b.authMode === 'public' ? b.keyPublic : b.keyInternal;
      const body = { agent_id: b.agentId, action: b.action, params: { [b.objectiveField]: last } };

      const r = await fetchWithRetry(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(authKey ? { authorization: `Bearer ${authKey}` } : {}) },
        body: JSON.stringify(body),
      }, 'aida-gateway');

      const txt = await r.text();
      if (!r.ok) return res.status(502).json({ error: `Backend aida ${r.status} @ ${url}`, body: txt.slice(0, 600) });

      // Humanizar salida AIDA
      let out = txt;
      try {
        const j = JSON.parse(txt);
        const objective = dotGet(j, `result.params.${b.objectiveField}`) || dotGet(j, `params.${b.objectiveField}`);
        const picked = pickPath(j, AIDA_RESP_PATH) || j?.content;
        const steps = dotGet(j, 'result.steps') || dotGet(j, 'steps') || dotGet(j, 'result.plan') || dotGet(j, 'plan');
        const note = dotGet(j, 'result.note') || j?.note || dotGet(j, 'data.text') || j?.text;
        let parts = [];
        if (objective) parts.push(`Objetivo: ${objective}`);
        if (typeof picked === 'string' && picked) parts.push(picked);
        else if (note) parts.push(`${note}`);
        if (Array.isArray(steps) && steps.length) {
          const list = steps.map((s, i) => `${i + 1}. ${typeof s === 'string' ? s : JSON.stringify(s)}`).join('\n');
          parts.push(list);
        }
        out = parts.length ? parts.join('\n') : (typeof picked === 'string' ? picked : JSON.stringify(j));
      } catch {}
      return res.json(toOpenAIChat(out));
    }

    // ---- LAB MCP wrapper ----
    if (b.name === 'lab' && b.mode === 'mcp') {
      const { ok, status, text, url } = await callMCP({ base: b.base, path: b.path, payload: last });
      if (!ok) {
        // Si LAB esta protegido/saturado, devolver degradado en 200 y no romper flujo.
        if (Number(status) === 429 || Number(status) === 403) {
          return res.json(toOpenAIChat(buildDegradedText(last)));
        }
        return res.status(502).json({ error: `Backend lab ${status} @ ${url}`, body: text.slice(0, 600) });
      }
      let out = text;
      try {
        const j = JSON.parse(text);
        // Humanización similar a AIDA, adaptada al wrapper MCP
        const origin = dotGet(j, 'result.via') || j.via || undefined;
        const payload = dotGet(j, 'result.reply') || j.reply || j.result || j;
        const objective = dotGet(payload, 'result.params.objective') || dotGet(payload, 'params.objective');
        const picked = pickPath(payload, `${b.respPath}|message|result.message|reply.message`) || payload?.content;
        const steps = dotGet(payload, 'result.steps') || dotGet(payload, 'steps') || dotGet(payload, 'result.plan') || dotGet(payload, 'plan');
        const note = dotGet(payload, 'result.note') || payload?.note || dotGet(payload, 'data.text') || payload?.text;
        if (origin === 'degraded') {
          const degraded = typeof picked === 'string' && picked.trim() ? picked : buildDegradedText(last);
          return res.json(toOpenAIChat(degraded));
        }
        let parts = [];
        if (objective) parts.push(`Objetivo: ${objective}`);
        if (typeof picked === 'string' && picked) parts.push(picked);
        else if (note) parts.push(`${note}`);
        if (Array.isArray(steps) && steps.length) {
          const list = steps.map((s, i) => `${i + 1}. ${typeof s === 'string' ? s : JSON.stringify(s)}`).join('\n');
          parts.push(list);
        }
        if (origin) parts.push(`via: ${origin}`);
        out = parts.length ? parts.join('\n') : (typeof picked === 'string' ? picked : JSON.stringify(j));
      } catch {}
      return res.json(toOpenAIChat(out));
    }

    // ---- Custom genérico (ARKAIOS u otros no-OpenAI) ----
    const k = b.keyInternal;
    const { ok, status, text, url } = await callCustom({
      base: b.base, path: b.path, key: k, reqField: b.reqField, payload: last
    });
    if (!ok) {
      // Degradacion controlada: si arkaios esta rate-limited, intentar AIDA gateway.
      if (b.name === 'arkaios' && status === 429) {
        const fb = await fallbackArkaiosToAida(last);
        if (fb.ok) {
          return res.json(toOpenAIChat(fb.text));
        }
        const fl = await fallbackArkaiosToLab(last);
        if (fl.ok) {
          return res.json(toOpenAIChat(fl.text));
        }
        // Si ambos proveedores estan rate-limited, responder degradado en 200 para no romper flujo.
        if (Number(fb.status) === 429 && Number(fl.status || 429) === 429) {
          const degraded = [
            'Servicio temporalmente saturado (rate-limit en proveedores).',
            'Tu solicitud fue recibida y el sistema esta en modo degradado.',
            `Prompt: ${last || '(vacio)'}`,
            'Sugerencia: reintentar en 30-90 segundos.',
          ].join('\n');
          return res.json(toOpenAIChat(degraded));
        }
        return res.status(502).json({
          error: `Backend ${b.name} ${status} @ ${url}`,
          body: text.slice(0, 600),
          fallback_error: fb,
          fallback_lab_error: fl,
        });
      }
      return res.status(502).json({ error: `Backend ${b.name} ${status} @ ${url}`, body: text.slice(0, 600) });
    }

    let out = text;
    try {
      const j = JSON.parse(text);
      const picked = pickPath(j, b.respPath);
      out = typeof picked === 'string' ? picked :
            (j.text || j.reply || j.response || j.content || JSON.stringify(j));
    } catch {}
    return res.json(toOpenAIChat(out));
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

/* ---------- /v1/completions ---------- */
app.post('/v1/completions', async (req, res) => {
  try {
    const { model = 'arkaios', prompt = '', stream = false } = req.body || {};
    const b = pick(model);
    if (!b.base) return res.status(500).json({ error: `Missing base URL for ${b.name}` });

    if (b.openai) {
      const r = await callOpenAI({ base: b.base, key: b.keyInternal, modelName: b.name, prompt, stream });
      const dataText = await r.text();
      return r.ok ? res.type('application/json').send(dataText) : res.status(r.status).send(dataText);
    }

    if (b.name === 'aida' && b.mode === 'gateway') {
      const url = `${b.base}${b.path.startsWith('/') ? b.path : `/${b.path}`}`;
      const authKey = b.authMode === 'public' ? b.keyPublic : b.keyInternal;
      const body = { agent_id: b.agentId, action: b.action, params: { [b.objectiveField]: prompt } };

      const r = await fetchWithRetry(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(authKey ? { authorization: `Bearer ${authKey}` } : {}) },
        body: JSON.stringify(body),
      }, 'aida-gateway');
      const txt = await r.text();
      if (!r.ok) return res.status(502).json({ error: `Backend aida ${r.status} @ ${url}`, body: txt.slice(0, 600) });

      let out = txt;
      try {
        const j = JSON.parse(txt);
        const objective = dotGet(j, `result.params.${b.objectiveField}`) || dotGet(j, `params.${b.objectiveField}`);
        const picked = pickPath(j, AIDA_RESP_PATH) || j?.content;
        const steps = dotGet(j, 'result.steps') || dotGet(j, 'steps') || dotGet(j, 'result.plan') || dotGet(j, 'plan');
        const note = dotGet(j, 'result.note') || j?.note || dotGet(j, 'data.text') || j?.text;
        let parts = [];
        if (objective) parts.push(`Objetivo: ${objective}`);
        if (typeof picked === 'string' && picked) parts.push(picked);
        else if (note) parts.push(`${note}`);
        if (Array.isArray(steps) && steps.length) {
          const list = steps.map((s, i) => `${i + 1}. ${typeof s === 'string' ? s : JSON.stringify(s)}`).join('\n');
          parts.push(list);
        }
        out = parts.length ? parts.join('\n') : (typeof picked === 'string' ? picked : JSON.stringify(j));
      } catch {}
      return res.json({ id: 'proxy-txt', object: 'text_completion', choices: [{ index: 0, text: out, finish_reason: 'stop' }] });
    }

    if (b.name === 'lab' && b.mode === 'mcp') {
      const { ok, status, text, url } = await callMCP({ base: b.base, path: b.path, payload: prompt });
      if (!ok) {
        // Si LAB esta protegido/saturado, devolver degradado en 200 y no romper flujo.
        if (Number(status) === 429 || Number(status) === 403) {
          return res.json({
            id: 'proxy-txt',
            object: 'text_completion',
            choices: [{ index: 0, text: buildDegradedText(prompt), finish_reason: 'stop' }],
          });
        }
        return res.status(502).json({ error: `Backend lab ${status} @ ${url}`, body: text.slice(0, 600) });
      }
      let out = text;
      try {
        const j = JSON.parse(text);
        const payload = dotGet(j, 'result.reply') || j.reply || j.result || j;
        const picked = pickPath(payload, `${b.respPath}|message|result.message|reply.message`);
        const via = dotGet(j, 'result.via') || j.via;
        if (via === 'degraded') {
          out = typeof picked === 'string' && picked.trim() ? picked : buildDegradedText(prompt);
        } else {
          out = typeof picked === 'string' ? picked : (j.text || j.reply || j.response || j.content || JSON.stringify(j));
        }
      } catch {}
      return res.json({ id: 'proxy-txt', object: 'text_completion', choices: [{ index: 0, text: out, finish_reason: 'stop' }] });
    }

    const { ok, status, text, url } = await callCustom({
      base: b.base, path: b.path, key: b.keyInternal, reqField: b.reqField, payload: prompt
    });
    if (!ok) {
      if (b.name === 'arkaios' && status === 429) {
        const fb = await fallbackArkaiosToAida(prompt);
        if (fb.ok) {
          return res.json({ id: 'proxy-txt', object: 'text_completion', choices: [{ index: 0, text: fb.text, finish_reason: 'stop' }] });
        }
        const fl = await fallbackArkaiosToLab(prompt);
        if (fl.ok) {
          return res.json({ id: 'proxy-txt', object: 'text_completion', choices: [{ index: 0, text: fl.text, finish_reason: 'stop' }] });
        }
        if (Number(fb.status) === 429 && Number(fl.status || 429) === 429) {
          const degraded = [
            'Servicio temporalmente saturado (rate-limit en proveedores).',
            'Tu solicitud fue recibida y el sistema esta en modo degradado.',
            `Prompt: ${prompt || '(vacio)'}`,
            'Sugerencia: reintentar en 30-90 segundos.',
          ].join('\n');
          return res.json({ id: 'proxy-txt', object: 'text_completion', choices: [{ index: 0, text: degraded, finish_reason: 'stop' }] });
        }
        return res.status(502).json({
          error: `Backend ${b.name} ${status} @ ${url}`,
          body: text.slice(0, 600),
          fallback_error: fb,
          fallback_lab_error: fl,
        });
      }
      return res.status(502).json({ error: `Backend ${b.name} ${status} @ ${url}`, body: text.slice(0, 600) });
    }

    let out = text;
    try {
      const j = JSON.parse(text);
      const picked = pickPath(j, b.respPath);
      out = typeof picked === 'string' ? picked :
            (j.text || j.reply || j.response || j.content || JSON.stringify(j));
    } catch {}
    return res.json({ id: 'proxy-txt', object: 'text_completion', choices: [{ index: 0, text: out, finish_reason: 'stop' }] });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

/* ---------- Debug ---------- */
app.get('/debug/ping', async (_req, res) => {
  async function probe(name, base) {
    if (!base) return { name, ok: false, error: 'no base url' };
    const baseTrim = trimBase(base);
    const urlHealth = `${baseTrim}/healthz`;
    try {
      let r = await fetch(urlHealth);
      let text = await r.text();
      if (r.status === 404) {
        // Fallback a raíz si /healthz no existe
        const urlRoot = `${baseTrim}/`;
        try {
          r = await fetch(urlRoot);
          text = await r.text();
          return { name, ok: r.ok, status: r.status, url: urlRoot, body: text.slice(0, 400) };
        } catch (e2) {
          return { name, ok: false, status: r.status, url: urlHealth, body: text.slice(0, 400), error: String(e2) };
        }
      }
      return { name, ok: r.ok, status: r.status, url: urlHealth, body: text.slice(0, 400) };
    } catch (e) {
      return { name, ok: false, error: String(e) };
    }
  }
  res.json({
    arkaios: await probe('arkaios', ARKAIOS_BASE_URL),
    aida: await probe('aida', AIDA_BASE_URL),
    lab: await (async () => {
      const l = pick('lab');
      if (!l.base || l.mode !== 'mcp') return { name: 'lab', ok: false, error: 'not_configured' };
      const { ok, status, text, url } = await callMCP({ base: l.base, path: l.path, payload: 'ping' });
      return { name: 'lab', ok, status, url, body: String(text || '').slice(0, 400) };
    })(),
  });
});

/* ---------- Rutas libres ---------- */
app.get('/', (_req, res) => res.send('ARKAIOS Service Proxy (OpenAI compatible). Ready.'));
app.get('/v1/healthz', (_req, res) => res.json({ ok: true, scope: 'auth' }));
app.get('/healthz', (_req, res) => res.json({ ok: true }));

/* ---------- Backup & Restore ---------- */
// Almacenar el snapshot en el propio proxy (JSON). Útil cuando no hay servicio externo.
// Este endpoint acepta un payload JSON (puede venir con {snapshot: {...}} o el snapshot directo) y lo guarda en memoria.
app.post('/v1/backup/store', async (req, res) => {
  try {
    const body = req.body || {};
    // Permitir tanto { snapshot: {...} } como el objeto directo de snapshot
    latestSnapshot = body.snapshot || body;
    const approxSize = Buffer.byteLength(JSON.stringify(latestSnapshot || {}), 'utf8');
    return res.json({ ok: true, stored: true, ts: Date.now(), approx_size_bytes: approxSize });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

// Recuperar el último snapshot guardado
app.get('/v1/backup/latest', (_req, res) => {
  if (!latestSnapshot) return res.status(404).json({ ok: false, error: 'no_snapshot' });
  return res.json(latestSnapshot);
});

app.post('/v1/backup/export', async (req, res) => {
  if (!BACKUP_BASE_URL) return res.status(500).json({ error: 'Missing BACKUP_BASE_URL' });
  try {
    const { response, buffer, url } = await forwardPost({
      base: BACKUP_BASE_URL,
      path: BACKUP_PATH,
      key: BACKUP_INTERNAL_KEY,
      body: req.body,
      query: req.query,
      timeoutMs: asTimeout(BACKUP_TIMEOUT_MS),
      contentType: req.headers['content-type'],
    });

    if (!response.ok) {
      return res
        .status(response.status)
        .json({ error: `Backup service ${response.status} @ ${url}`, body: buffer.toString('utf8', 0, 600) });
    }

    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const disposition = response.headers.get('content-disposition');
    if (contentType) res.setHeader('content-type', contentType);
    if (disposition) res.setHeader('content-disposition', disposition);

    if (contentType.includes('application/json')) {
      return res.send(buffer.toString('utf8'));
    }
    return res.send(buffer);
  } catch (error) {
    const message = error?.name === 'AbortError' ? 'Backup service timeout reached' : String(error?.message || error);
    res.status(500).json({ error: message });
  }
});

// Restore en crudo (binarios grandes), reenvía el buffer tal cual
app.post('/v1/backup/restore/raw', express.raw({ type: '*/*', limit: '200mb' }), async (req, res) => {
  const base = RESTORE_BASE_URL || BACKUP_BASE_URL;
  if (!base) return res.status(500).json({ error: 'Missing RESTORE_BASE_URL or BACKUP_BASE_URL' });
  try {
    const { response, buffer, url } = await forwardPost({
      base,
      path: RESTORE_PATH || BACKUP_PATH,
      key: RESTORE_INTERNAL_KEY || BACKUP_INTERNAL_KEY,
      body: req.body, // Buffer
      query: req.query,
      timeoutMs: asTimeout(BACKUP_TIMEOUT_MS),
      contentType: req.headers['content-type'] || 'application/octet-stream',
    });

    const text = buffer.toString('utf8');
    if (!response.ok) {
      return res
        .status(response.status)
        .json({ error: `Restore service ${response.status} @ ${url}`, body: text.slice(0, 600) });
    }

    const contentType = response.headers.get('content-type') || 'application/json';
    res.setHeader('content-type', contentType);
    if (contentType.includes('application/json')) {
      return res.send(text);
    }
    return res.send(buffer);
  } catch (error) {
    const message = error?.name === 'AbortError' ? 'Restore service timeout reached' : String(error?.message || error);
    res.status(500).json({ error: message });
  }
});

app.post('/v1/backup/restore', async (req, res) => {
  const base = RESTORE_BASE_URL || BACKUP_BASE_URL;
  if (!base) return res.status(500).json({ error: 'Missing RESTORE_BASE_URL or BACKUP_BASE_URL' });
  try {
    const { response, buffer, url } = await forwardPost({
      base,
      path: RESTORE_PATH || BACKUP_PATH,
      key: RESTORE_INTERNAL_KEY || BACKUP_INTERNAL_KEY,
      body: req.body,
      query: req.query,
      timeoutMs: asTimeout(BACKUP_TIMEOUT_MS),
      contentType: req.headers['content-type'],
    });

    const text = buffer.toString('utf8');
    if (!response.ok) {
      return res
        .status(response.status)
        .json({ error: `Restore service ${response.status} @ ${url}`, body: text.slice(0, 600) });
    }

    const contentType = response.headers.get('content-type') || 'application/json';
    res.setHeader('content-type', contentType);
    if (contentType.includes('application/json')) {
      return res.send(text);
    }
    return res.send(buffer);
  } catch (error) {
    const message = error?.name === 'AbortError' ? 'Restore service timeout reached' : String(error?.message || error);
    res.status(500).json({ error: message });
  }
});

      /* ---------- REMOTE DESKTOP / SCREEN CAPTURE ---------- */
// In-memory storage para sesiones remotas y frames
const remoteSessions = new Map(); // sessionId -> { startTime, lastFrame, status }
const remoteFrames = new Map(); // sessionId -> { frameData, width, height, timestamp }

// Iniciar una sesión de captura remota
app.post('/v1/remote/session/start', (req, res) => {
  try {
    const { sessionId, clientType } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });
    
    remoteSessions.set(sessionId, {
      startTime: Date.now(),
      clientType,
      status: 'active',
      frameCount: 0
    });
    
    console.log(`[Remote] Sesión iniciada: ${sessionId} (${clientType})`);
    res.json({ ok: true, sessionId, startTime: Date.now() });
  } catch (error) {
    res.status(500).json({ error: String(error?.message || error) });
  }
});

// Recibir frame de pantalla desde la extensión
app.post('/v1/remote/frame', (req, res) => {
  try {
    const { sessionId, frameData, width, height, timestamp } = req.body || {};
    if (!sessionId || !frameData) return res.status(400).json({ error: 'Missing sessionId or frameData' });
    
    const session = remoteSessions.get(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    
    // Guardar frame (solo el último para no saturar memoria)
    remoteFrames.set(sessionId, {
      frameData,
      width,
      height,
      timestamp,
      receivedAt: Date.now()
    });
    
    // Actualizar conteo en sesión
    session.frameCount = (session.frameCount || 0) + 1;
    session.lastFrame = Date.now();
    
    res.json({ ok: true, frameId: sessionId, size: frameData.length });
  } catch (error) {
    res.status(500).json({ error: String(error?.message || error) });
  }
});

// Obtener último frame capturado (para que el agente lo vea)
app.get('/v1/remote/last-frame', (req, res) => {
  try {
    const { sessionId } = req.query;
    if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });
    
    const frame = remoteFrames.get(sessionId);
    if (!frame) return res.status(404).json({ error: 'No frames available for this session' });
    
    const session = remoteSessions.get(sessionId);
    const uptime = session ? (Date.now() - session.startTime) / 1000 : 0;
    
    res.json({
      ok: true,
      frame: {
        data: frame.frameData,
        width: frame.width,
        height: frame.height,
        capturedAt: frame.timestamp,
        receivedAt: frame.receivedAt
      },
      session: {
        sessionId,
        status: session?.status || 'unknown',
        uptimeSeconds: uptime,
        frameCount: session?.frameCount || 0
      }
    });
  } catch (error) {
    res.status(500).json({ error: String(error?.message || error) });
  }
});

// Enviar acción (click, teclas, etc.) de vuelta a la extensión
app.post('/v1/remote/action', (req, res) => {
  try {
    const { sessionId, action, selector, value, x, y } = req.body || {};
    if (!sessionId || !action) return res.status(400).json({ error: 'Missing sessionId or action' });
    
    const session = remoteSessions.get(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    
    // En un escenario real, aquí guardaríamos la acción en una queue
    // que la extensión polléa periodicamente
    // Por ahora, solo registramos y respondemos
    
    console.log(`[Remote] Acción: ${action} en sesión ${sessionId}`);
    
    res.json({
      ok: true,
      action,
      sessionId,
      executedAt: Date.now()
    });
  } catch (error) {
    res.status(500).json({ error: String(error?.message || error) });
  }
});

// Estado de sesión remota
app.get('/v1/remote/status/:sessionId', (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = remoteSessions.get(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    
    const frame = remoteFrames.get(sessionId);
    const uptime = (Date.now() - session.startTime) / 1000;
    
    res.json({
      ok: true,
      sessionId,
      status: session.status,
      clientType: session.clientType,
      uptimeSeconds: uptime,
      frameCount: session.frameCount,
      lastFrameAt: session.lastFrame,
      hasFrame: !!frame,
      frameDimensions: frame ? { width: frame.width, height: frame.height } : null
    });
  } catch (error) {
    res.status(500).json({ error: String(error?.message || error) });
  }
});

// Limpiar sesión
app.post('/v1/remote/session/stop/:sessionId', (req, res) => {
  try {
    const { sessionId } = req.params;
    
    if (remoteSessions.has(sessionId)) {
      remoteSessions.delete(sessionId);
    }
    if (remoteFrames.has(sessionId)) {
      remoteFrames.delete(sessionId);
    }
    
    console.log(`[Remote] Sesión detenida: ${sessionId}`);
    res.json({ ok: true, message: 'Session terminated' });
  } catch (error) {
    res.status(500).json({ error: String(error?.message || error) });
  }
});

/* ---------- END REMOTE DESKTOP ---------- */

app.listen(PORT, () => console.log(`Proxy on :${PORT}`));
