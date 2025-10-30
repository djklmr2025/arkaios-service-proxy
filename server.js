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

  ARKAIOS_BASE_URL,
  ARKAIOS_INTERNAL_KEY,
  ARKAIOS_OPENAI = 'false',   // <-- controla modo

  AIDA_BASE_URL,
  AIDA_INTERNAL_KEY,
  AIDA_OPENAI = 'false'       // <-- controla modo
} = process.env;

/* ---------- Auth SOLO para /v1/* ---------- */
const authMiddleware = (req, res, next) => {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!PROXY_API_KEY || token === PROXY_API_KEY) return next();
  res.status(401).json({ error: 'Invalid API key' });
};
app.use('/v1', authMiddleware);

/* ---------- Utils ---------- */
const asBool = (v) => String(v || '').toLowerCase() === 'true';

function pickBackend(modelId) {
  const m = (modelId || '').toLowerCase();
  if (m === 'aida') {
    return {
      name: 'aida',
      base: AIDA_BASE_URL,
      key: AIDA_INTERNAL_KEY,
      openai: asBool(AIDA_OPENAI)
    };
  }
  return {
    name: 'arkaios',
    base: ARKAIOS_BASE_URL,
    key: ARKAIOS_INTERNAL_KEY,
    openai: asBool(ARKAIOS_OPENAI)
  };
}

/* ---------- Normalizadores de respuesta ---------- */
async function toTextFromAny(resp) {
  // Intenta JSON; si truena, devuelve texto bruto
  let text = await resp.text();
  try {
    const data = JSON.parse(text);

    // OpenAI chat
    if (data?.choices?.[0]?.message?.content) {
      return data.choices[0].message.content;
    }
    // OpenAI completions (text)
    if (data?.choices?.[0]?.text) {
      return data.choices[0].text;
    }
    // Campos comunes
    if (typeof data.reply === 'string') return data.reply;
    if (typeof data.response === 'string') return data.response;
    if (typeof data.message === 'string') return data.message;
    if (typeof data.text === 'string') return data.text;
    if (typeof data.content === 'string') return data.content;

    // Algunos backends devuelven {data:{text:...}}
    if (typeof data?.data?.text === 'string') return data.data.text;
    if (typeof data?.data?.content === 'string') return data.data.content;

    // Como último recurso, re-serializa bonito
    return JSON.stringify(data);
  } catch {
    return text;
  }
}

/* ---------- Caller OpenAI-like ---------- */
async function callOpenAIStyle({ base, key, modelName, messages, prompt, stream }) {
  const url = `${base.replace(/\/+$/,'')}/v1/chat/completions`;
  const body = messages ? { model: modelName, messages, stream: !!stream }
                        : { model: modelName, prompt, stream: !!stream };

  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key ? { authorization: `Bearer ${key}` } : {})
    },
    body: JSON.stringify(body)
  });
  return r;
}

/* ---------- Caller Flexible (no OpenAI) ---------- */
async function callFlexible({ base, key, modelName, messages, prompt }) {
  const last = messages?.length ? messages[messages.length - 1].content : (prompt || '');
  const normalizedBase = base?.replace(/\/+$/,'') || '';

  // Variantes de payload comunes
  const bodies = [
    { input: last, model: modelName },
    { query: last, model: modelName },
    { prompt: last, model: modelName },
    { message: last, model: modelName },
    { text: last, model: modelName }
  ];
  // Rutas candidatas
  const paths = [
    '/chat',
    '/api/chat',
    '/message',
    '/api/message',
    '/gateway/chat',
    '/v1/chat' // algunos usan esta sin "completions"
  ];

  for (const p of paths) {
    const url = `${normalizedBase}${p}`;
    for (const b of bodies) {
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(key ? { authorization: `Bearer ${key}` } : {})
        },
        body: JSON.stringify(b)
      }).catch(() => null);
      if (r && r.ok) {
        const text = await toTextFromAny(r);
        return { ok: true, text, tried: { url, body: b } };
      }
    }
  }
  return { ok: false, error: `No flexible path matched for base=${base}` };
}

/* ---------- /v1/models ---------- */
app.get('/v1/models', (_req, res) => {
  res.json({
    object: 'list',
    data: [
      { id: 'arkaios', object: 'model', owned_by: 'arkaios' },
      { id: 'aida', object: 'model', owned_by: 'aida' }
    ]
  });
});

/* ---------- /v1/chat/completions ---------- */
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model = 'arkaios', messages = [], stream = false } = req.body || {};
    const backend = pickBackend(model);

    if (!backend.base) {
      return res.status(500).json({ error: `Backend base URL missing for ${backend.name}` });
    }

    if (backend.openai) {
      // Modo OpenAI directo
      const r = await callOpenAIStyle({
        base: backend.base,
        key: backend.key,
        modelName: backend.name,
        messages,
        stream
      });

      if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        r.body.pipe(res);
        return;
      }
      const dataText = await r.text();
      if (!r.ok) return res.status(r.status).send(dataText);
      return res.type('application/json').send(dataText);
    }

    // Modo flexible: mapea respuesta a OpenAI
    const out = await callFlexible({
      base: backend.base,
      key: backend.key,
      modelName: backend.name,
      messages
    });
    if (!out.ok) return res.status(502).json({ error: out.error });

    return res.json({
      id: `${backend.name}-chat`,
      object: 'chat.completion',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: out.text },
        finish_reason: 'stop'
      }]
    });

  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

/* ---------- /v1/completions ---------- */
app.post('/v1/completions', async (req, res) => {
  try {
    const { model = 'arkaios', prompt = '', stream = false } = req.body || {};
    const backend = pickBackend(model);

    if (!backend.base) {
      return res.status(500).json({ error: `Backend base URL missing for ${backend.name}` });
    }

    if (backend.openai) {
      const r = await callOpenAIStyle({
        base: backend.base,
        key: backend.key,
        modelName: backend.name,
        prompt,
        stream
      });
      if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        r.body.pipe(res);
        return;
      }
      const dataText = await r.text();
      if (!r.ok) return res.status(r.status).send(dataText);
      return res.type('application/json').send(dataText);
    }

    // Flexible
    const out = await callFlexible({
      base: backend.base,
      key: backend.key,
      modelName: backend.name,
      prompt
    });
    if (!out.ok) return res.status(502).json({ error: out.error });

    return res.json({
      id: `${backend.name}-completion`,
      object: 'text_completion',
      choices: [{ index: 0, text: out.text, finish_reason: 'stop' }]
    });

  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

/* ---------- Debug ---------- */
app.get('/debug/ping', async (_req, res) => {
  async function probe(name, base, key) {
    if (!base) return { name, ok: false, error: 'no base url' };
    const url = `${base.replace(/\/+$/,'')}/healthz`;
    try {
      const r = await fetch(url, {
        headers: { ...(key ? { authorization: `Bearer ${key}` } : {}) }
      });
      const text = await r.text();
      return { name, ok: r.ok, status: r.status, url, body: text.slice(0, 500) };
    } catch (e) {
      return { name, ok: false, error: String(e) };
    }
  }
  const report = {
    arkaios: await probe('arkaios', ARKAIOS_BASE_URL, ARKAIOS_INTERNAL_KEY),
    aida: await probe('aida', AIDA_BASE_URL, AIDA_INTERNAL_KEY)
  };
  res.json(report);
});

/* ---------- Rutas libres ---------- */
app.get('/', (_req, res) => {
  res.send('ARKAIOS Service Proxy (OpenAI compatible). Ready.');
});
app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Proxy on :${PORT}`));
