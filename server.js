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
  ARKAIOS_OPENAI = 'false',         // true = usa /v1/chat/completions
  ARKAIOS_PATH = '/api/chat',       // ruta flexible
  ARKAIOS_REQ_FIELD = 'input',      // nombre del campo del prompt: input|prompt|message|text
  ARKAIOS_RESP_PATH = 'data.text',  // dot-path para extraer texto

  // AIDA
  AIDA_BASE_URL,
  AIDA_INTERNAL_KEY,
  AIDA_OPENAI = 'false',
  AIDA_PATH = '/api/chat',
  AIDA_REQ_FIELD = 'input',
  AIDA_RESP_PATH = 'data.text',
} = process.env;

const asBool = (v) => String(v || '').toLowerCase() === 'true';

/* ------------ Auth SOLO /v1/* ------------ */
const authMiddleware = (req, res, next) => {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!PROXY_API_KEY || token === PROXY_API_KEY) return next();
  res.status(401).json({ error: 'Invalid API key' });
};
app.use('/v1', authMiddleware);

/* ------------ Helpers ------------ */
const dotGet = (obj, path) => {
  if (!path) return undefined;
  return path.split('.').reduce((acc, k) => (acc && acc[k] !== undefined ? acc[k] : undefined), obj);
};

function pick(modelId) {
  const m = (modelId || '').toLowerCase();
  if (m === 'aida') {
    return {
      name: 'aida',
      base: (AIDA_BASE_URL || '').replace(/\/+$/,''),
      key: AIDA_INTERNAL_KEY,
      openai: asBool(AIDA_OPENAI),
      path: AIDA_PATH,
      reqField: AIDA_REQ_FIELD,
      respPath: AIDA_RESP_PATH,
    };
  }
  return {
    name: 'arkaios',
      base: (ARKAIOS_BASE_URL || '').replace(/\/+$/,''),
      key: ARKAIOS_INTERNAL_KEY,
      openai: asBool(ARKAIOS_OPENAI),
      path: ARKAIOS_PATH,
      reqField: ARKAIOS_REQ_FIELD,
      respPath: ARKAIOS_RESP_PATH,
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

async function callCustom({ base, key, path, reqField, payload }) {
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

/* ------------ /v1/models ------------ */
app.get('/v1/models', (_req, res) => {
  res.json({
    object: 'list',
    data: [
      { id: 'arkaios', object: 'model', owned_by: 'arkaios' },
      { id: 'aida', object: 'model', owned_by: 'aida' },
    ],
  });
});

/* ------------ /v1/chat/completions ------------ */
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model = 'arkaios', messages = [], stream = false } = req.body || {};
    const b = pick(model);
    if (!b.base) return res.status(500).json({ error: `Missing base URL for ${b.name}` });

    if (b.openai) {
      const r = await callOpenAI({ base: b.base, key: b.key, modelName: b.name, messages, stream });
      if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        r.body.pipe(res);
        return;
      }
      const dataText = await r.text();
      return r.ok ? res.type('application/json').send(dataText) : res.status(r.status).send(dataText);
    }

    // flexible
    const last = messages?.length ? messages[messages.length - 1].content : '';
    const { ok, status, text, url } = await callCustom({ base: b.base, key: b.key, path: b.path, reqField: b.reqField, payload: last });

    if (!ok) return res.status(502).json({ error: `Backend ${b.name} ${status} @ ${url}`, body: text.slice(0,500) });

    let out = text;
    try {
      const json = JSON.parse(text);
      const picked = dotGet(json, b.respPath);
      if (typeof picked === 'string') out = picked;
      else if (typeof json.reply === 'string') out = json.reply;
      else if (typeof json.response === 'string') out = json.response;
      else if (typeof json.message === 'string') out = json.message;
      else if (typeof json.text === 'string') out = json.text;
      else if (typeof json.content === 'string') out = json.content;
      else out = JSON.stringify(json);
    } catch { /* se queda text */ }

    return res.json(toOpenAIChat(out));
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

/* ------------ /v1/completions ------------ */
app.post('/v1/completions', async (req, res) => {
  try {
    const { model = 'arkaios', prompt = '', stream = false } = req.body || {};
    const b = pick(model);
    if (!b.base) return res.status(500).json({ error: `Missing base URL for ${b.name}` });

    if (b.openai) {
      const r = await callOpenAI({ base: b.base, key: b.key, modelName: b.name, prompt, stream });
      const dataText = await r.text();
      return r.ok ? res.type('application/json').send(dataText) : res.status(r.status).send(dataText);
    }

    const { ok, status, text, url } = await callCustom({ base: b.base, key: b.key, path: b.path, reqField: b.reqField, payload: prompt });
    if (!ok) return res.status(502).json({ error: `Backend ${b.name} ${status} @ ${url}`, body: text.slice(0,500) });

    // similar mapping
    let out = text;
    try {
      const json = JSON.parse(text);
      const picked = dotGet(json, b.respPath);
      out = typeof picked === 'string' ? picked : (json.text || json.response || json.reply || json.content || JSON.stringify(json));
    } catch {}
    return res.json({ id: 'proxy-txt', object: 'text_completion', choices: [{ index: 0, text: out, finish_reason: 'stop' }] });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

/* ------------ Debug ------------ */
app.get('/debug/ping', async (_req, res) => {
  async function probe(name, base) {
    if (!base) return { name, ok: false, error: 'no base url' };
    const url = `${base.replace(/\/+$/,'')}/healthz`;
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

/* ------------ Rutas libres ------------ */
app.get('/', (_req, res) => res.send('ARKAIOS Service Proxy (OpenAI compatible). Ready.'));
app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Proxy on :${PORT}`));
