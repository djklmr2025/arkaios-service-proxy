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
  AIDA_BASE_URL,
  AIDA_INTERNAL_KEY
} = process.env;

/* --- Auth SOLO para /v1/* --- */
const authMiddleware = (req, res, next) => {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!PROXY_API_KEY || token === PROXY_API_KEY) return next();
  res.status(401).json({ error: 'Invalid API key' });
};
app.use('/v1', authMiddleware);

/* --- OpenAI-compatible --- */
app.get('/v1/models', (_req, res) => {
  res.json({
    object: 'list',
    data: [
      { id: 'arkaios', object: 'model', owned_by: 'arkaios' },
      { id: 'aida', object: 'model', owned_by: 'aida' }
    ]
  });
});

function pickBackend(modelId) {
  if ((modelId || '').toLowerCase() === 'aida') {
    return { base: AIDA_BASE_URL, key: AIDA_INTERNAL_KEY, name: 'aida' };
  }
  return { base: ARKAIOS_BASE_URL, key: ARKAIOS_INTERNAL_KEY, name: 'arkaios' };
}

async function callBackend({ model, messages, prompt, stream }) {
  const { base, key, name } = pickBackend(model);
  const url = `${base}/v1/chat/completions`;
  const body = messages ? { model: name, messages, stream: !!stream }
                        : { model: name, prompt, stream: !!stream };

  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key ? { authorization: `Bearer ${key}` } : {})
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`Backend ${name} ${r.status}: ${t}`);
  }
  return r;
}

app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model = 'arkaios', messages = [], stream = false } = req.body || {};
    const r = await callBackend({ model, messages, stream });
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      r.body.pipe(res);
      return;
    }
    res.json(await r.json());
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post('/v1/completions', async (req, res) => {
  try {
    const { model = 'arkaios', prompt = '', stream = false } = req.body || {};
    const r = await callBackend({ model, prompt, stream });
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      r.body.pipe(res);
      return;
    }
    res.json(await r.json());
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

/* --- Rutas libres (sin auth) --- */
app.get('/', (_req, res) => {
  res.send('ARKAIOS Service Proxy (OpenAI compatible). Ready.');
});
app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Proxy on :${PORT}`));
