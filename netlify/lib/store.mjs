// Game files live in Cloudflare R2 behind the "vibebyside-files" Worker (worker/files-worker.js), which holds no secrets.
// The MCP server gets in with short-lived file passes it writes to the database (table file_tickets).
import { createClient } from '@supabase/supabase-js';

const FILES = () => Netlify.env.get('FILES_URL'); // the files Worker's address, e.g. https://<worker>.<account>.workers.dev
export const FULL_MSG = 'Vibe by Side storage is full (9 GB free limit). Delete a world or big files first.';
let admin;
const db = () => admin ||= createClient(Netlify.env.get('SUPABASE_URL'), Netlify.env.get('SUPABASE_SERVICE_KEY'), { auth: { persistSession: false } });
const split = (key) => { const i = key.indexOf('/'); return [key.slice(0, i), key.slice(i + 1)]; };
const fileUrl = (game, path) => `${FILES()}/file/${game}/${path.split('/').map(encodeURIComponent).join('/')}`;

async function ticket(game, write) { // a pass for one world, good for 15 minutes
  await db().from('file_tickets').delete().lt('expires', new Date().toISOString());
  const { data, error } = await db().from('file_tickets').insert({ game_id: game, can_write: write }).select('id').single();
  if (error) throw new Error(error.message);
  return data.id;
}
async function call(game, write, url, init = {}) {
  const r = await fetch(url, { ...init, headers: { ...init.headers, 'X-Ticket': await ticket(game, write) } });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `files ${r.status}`);
  return r;
}

export const list = async (game) => (await call(game, false, `${FILES()}/list/${game}`)).json(); // [{ path, bytes, updated }]
export async function get(key) { const [g, p] = split(key); return Buffer.from(await (await call(g, false, fileUrl(g, p))).arrayBuffer()); }
export async function put(key, body) { const [g, p] = split(key); await call(g, true, fileUrl(g, p), { method: 'PUT', body }); }
export async function del(keys) { for (const k of keys) { const [g, p] = split(k); await call(g, true, fileUrl(g, p), { method: 'DELETE' }); } }
export async function sign(key, method = 'GET') { const [g, p] = split(key); return `${fileUrl(g, p)}?ticket=${await ticket(g, method !== 'GET')}`; } // a link a client can curl
export async function full() { const { data } = await db().rpc('storage_full'); return data === true; } // stays inside the R2 free tier: stop at 9 GB
