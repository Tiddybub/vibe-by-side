// Signed, stateless tokens for the "Log in with Vibe by Side" flow (OAuth for MCP clients).
// Nothing is stored: each token carries its own data plus an HMAC made from the server's secret key.
import { createHmac, timingSafeEqual } from 'node:crypto';

const secret = () => createHmac('sha256', 'vibe-by-side-oauth').update(Netlify.env.get('SUPABASE_SERVICE_KEY')).digest();
const mac = (body) => createHmac('sha256', secret()).update(body).digest('base64url');

export function sign(kind, data, seconds) {
  const body = Buffer.from(JSON.stringify({ k: kind, ...data, ...(seconds ? { e: Math.floor(Date.now() / 1000) + seconds } : {}) })).toString('base64url');
  return `vbs.${body}.${mac(body)}`;
}

export function verify(token, kind) { // the payload, or null if forged, expired or the wrong kind
  const [p, body, sig] = String(token || '').split('.');
  if (p !== 'vbs' || !body || !sig) return null;
  const want = Buffer.from(mac(body)), got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  const d = JSON.parse(Buffer.from(body, 'base64url').toString());
  return d.k === kind && (!d.e || d.e > Date.now() / 1000) ? d : null;
}
