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

// --- Auth simple para el proxy (la usa TRAE en el campo API Key) ---
app.use((req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!PROXY_API_KEY || token === PROXY_API_KEY) return next();
  res.status(401).json({ error: 'Invalid API key' });
});

// --- Lista de modelos (OpenAI-like) ---
app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: [
      { id: 'arkaios', object: 'model', owned_by: 'arkaios' },
      { id: 'aida', object: 'model', owned_by: 'aida' }
    ]
  });
});

// Utilidad para elegir backend por model id
function pickBackend(modelId) {
  if ((modelId || '').toLowerCase() === 'aida') {
    return { base: AIDA_BASE_URL, key: AIDA_INTERNAL_KEY, name: 'aida' };
  }
  // default -> arkaios
  return { base: ARKAIOS_BASE_URL, key: ARKAIOS_INTERNAL_KEY, name: 'arkaios' };
}

// Adaptador simple: OpenAI chat → tu backend
async function callBackend({ model, messages, prompt, stream }) {
  const { base, key, name } = pickBackend(model);

  // Si tu backend ya acepta OpenAI, reenvía tal cual:
  const url = `${base}/v1/chat/completions`;
  const body = messages
    ? { model: name, messages, stream: !!stream }
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
    const txt = await r.text().catch(() => '');
    throw new Error(`Backend ${name} ${r.status}: ${txt}`);
  }
  // Si tu backend devuelve OpenAI-like, regresamos tal cual:
  return r;
}

// POST /v1/chat/completions
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model = 'arkaios', messages = [], stream = false } = req.body || {};
    const backendResp = await callBackend({ model, messages, stream });

    // streaming passthrough
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      backendResp.body.pipe(res);
      return;
    }

    const data = await backendResp.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// POST /v1/completions (prompt-style)
app.post('/v1/completions', async (req, res) => {
  try {
    const { model = 'arkaios', prompt = '', stream = false } = req.body || {};
    const backendResp = await callBackend({ model, prompt, stream });

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      backendResp.body.pipe(res);
      return;
    }

    const data = await backendResp.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Raíz
app.get('/', (_req, res) => {
  res.send('ARKAIOS Service Proxy (OpenAI compatible). Ready.');
});

app.listen(PORT, () => {
  console.log(`Proxy on :${PORT}`);
});
