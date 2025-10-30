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
        method:
