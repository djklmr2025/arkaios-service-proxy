import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import fetch from 'node-fetch';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(morgan('dev'));

const {
  PORT = 4000,
  PROXY_API_KEY,

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
  AIDA_AUTH_MODE = 'public',      // public | internal
  AIDA_OPENAI = 'false',
  AIDA_MODE = 'gateway',          // gateway | custom | openai
  AIDA_PATH = '/aida/gateway',
  AIDA_AGENT_ID = 'puter',
  AIDA_ACTION = 'plan',
  AIDA_OBJECTIVE_FIELD = 'objective',
} = process.env;

const asBool = v => String(v || '').toLowerCase() === 'true';

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
const trimBase = b => (b || '').replace(/\/+$/, '');

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
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
  });
}

async function callCustom({ base, path, key, reqField, payload }) {
  const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;
  const body = { [reqField]: payload, model: 'custom' };
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
  });
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

/* ---------- /v1/models ---------- */
app.get('/v1/models', (_req, res) => {
  res.json({
    object: 'list',
    data: [
      { id: 'arkaios', object: 'model', owned_by: 'arkaios' },
      { id: 'aida', object: 'model', owned_by: 'aida' },
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

      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(authKey ? { authorization: `Bearer ${authKey}` } : {}) },
        body: JSON.stringify(body),
      });

      const txt = await r.text();
      if (!r.ok) return res.status(502).json({ error: `Backend aida ${r.status} @ ${url}`, body: txt.slice(0, 600) });

      // intenta parsear texto útil
      let out = txt;
      try {
        const j = JSON.parse(txt);
        out = j?.data?.text || j?.text || j?.reply || j?.response || j?.content || JSON.stringify(j);
      } catch {}
      return res.json(toOpenAIChat(out));
    }

    // ---- Custom genérico (ARKAIOS u otros no-OpenAI) ----
    const k = b.keyInternal;
    const { ok, status, text, url } = await callCustom({
      base: b.base, path: b.path, key: k, reqField: b.reqField, payload: last
    });
    if (!ok) return res.status(502).json({ error: `Backend ${b.name} ${status} @ ${url}`, body: text.slice(0, 600) });

    let out = text;
    try {
      const j = JSON.parse(text);
      const picked = dotGet(j, b.respPath);
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

      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(authKey ? { authorization: `Bearer ${authKey}` } : {}) },
        body: JSON.stringify(body),
      });
      const txt = await r.text();
      if (!r.ok) return res.status(502).json({ error: `Backend aida ${r.status} @ ${url}`, body: txt.slice(0, 600) });

      let out = txt;
      try {
        const j = JSON.parse(txt);
        out = j?.data?.text || j?.text || j?.reply || j?.response || j?.content || JSON.stringify(j);
      } catch {}
      return res.json({ id: 'proxy-txt', object: 'text_completion', choices: [{ index: 0, text: out, finish_reason: 'stop' }] });
    }

    const { ok, status, text, url } = await callCustom({
      base: b.base, path: b.path, key: b.keyInternal, reqField: b.reqField, payload: prompt
    });
    if (!ok) return res.status(502).json({ error: `Backend ${b.name} ${status} @ ${url}`, body: text.slice(0, 600) });

    let out = text;
    try {
      const j = JSON.parse(text);
      const picked = dotGet(j, b.respPath);
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
    const url = `${trimBase(base)}/healthz`;
    try {
      const r = await fetch(url);
      const text = await r.text();
      return { name, ok: r.ok, status: r.status, url, body: text.slice(0, 400) };
    } catch (e) {
      return { name, ok: false, error: String(e) };
    }
  }
  res.json({
    arkaios: await probe('arkaios', ARKAIOS_BASE_URL),
    aida: await probe('aida', AIDA_BASE_URL)
  });
});

/* ---------- Rutas libres ---------- */
app.get('/', (_req, res) => res.send('ARKAIOS Service Proxy (OpenAI compatible). Ready.'));
app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Proxy on :${PORT}`));
