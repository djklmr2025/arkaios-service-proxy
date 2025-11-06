import 'dotenv/config';
import fetch from 'node-fetch';

/**
 * Smoke test E2E: backup -> latest -> restore
 * - Usa Authorization: Bearer en proxy (/v1/*)
 * - Usa Authorization: Bearer en daemon (/admin/*)
 */

const PROXY_BASE = process.env.PROXY_BASE_URL || 'https://arkaios-service-proxy.onrender.com/v1';
const PROXY_KEY = process.env.ARKAIOS_PROXY_KEY || process.env.PROXY_API_KEY || 'sk_arkaios_proxy_8y28hsy72hs82js9';
const DAEMON_BASE = process.env.DAEMON_BASE_URL || 'https://arkaios-core-api.onrender.com';
const DAEMON_KEY = process.env.ARKAIOS_API_KEY || 'ARKAIOS_MASTER_KEY_777';

function bearer(key?: string) {
  return key ? { Authorization: `Bearer ${key}` } : {};
}

async function jsonOrText(res: any) {
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return res.text();
}

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchWithRetry(url: string, init: any = {}, retries = 3, delayMs = 1000) {
  let lastErr: any;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, init);
      return res;
    } catch (err) {
      lastErr = err;
      if (i < retries - 1) await sleep(delayMs);
    }
  }
  throw lastErr;
}

async function main() {
  const out: any = { startedAt: new Date().toISOString() };

  // 0) Health checks
  {
    const rProxy = await fetchWithRetry(`${PROXY_BASE}/healthz`, { headers: bearer(PROXY_KEY) }, 3, 1000);
    out.proxyHealth = { status: rProxy.status, ok: rProxy.ok, body: await jsonOrText(rProxy) };
    const rDaemon = await fetchWithRetry(`${DAEMON_BASE}/health`, {}, 3, 1000);
    out.daemonHealth = { status: rDaemon.status, ok: rDaemon.ok, body: await jsonOrText(rDaemon) };
  }

  // 1) Trigger backup via daemon
  {
    const r = await fetchWithRetry(`${DAEMON_BASE}/admin/backup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bearer(DAEMON_KEY) },
    }, 2, 1500);
    const body = await jsonOrText(r);
    out.backup = { status: r.status, ok: r.ok, body };
    // Validar semántica del cuerpo cuando el daemon responde 200 pero con backup.ok=false
    const backupOk = (typeof body === 'object' && body !== null)
      ? (body.backup?.ok ?? body.ok ?? r.ok)
      : r.ok;
    if (!backupOk) throw new Error(`Backup failed: ${r.status} ${typeof body === 'object' ? JSON.stringify(body) : String(body)}`);
  }

  // 2) Fetch latest snapshot from proxy
  let latest: any;
  {
    const r = await fetchWithRetry(`${PROXY_BASE}/backup/latest`, { headers: bearer(PROXY_KEY) }, 3, 1000);
    latest = await jsonOrText(r);
    out.latest = { status: r.status, ok: r.ok, body: latest };
    if (!r.ok) throw new Error(`Latest snapshot not available: ${r.status}`);
  }

  // 3) Push restore from proxy to daemon
  {
    const r = await fetchWithRetry(`${PROXY_BASE}/backup/restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bearer(PROXY_KEY) },
      body: JSON.stringify({ snapshot: latest })
    }, 2, 1500);
    out.restore = { status: r.status, ok: r.ok, body: await jsonOrText(r) };
    if (!r.ok) throw new Error(`Restore failed: ${r.status}`);
  }

  out.finishedAt = new Date().toISOString();
  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error('[SMOKE] error:', err);
  process.exit(1);
});
