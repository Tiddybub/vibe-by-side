// Vibe by Side file storage (Cloudflare Worker "vibebyside-files", R2 binding BUCKET -> vibebyside-games).
// Holds no secrets. Callers prove who they are with their Vibe by Side login (browser) or a short-lived
// file pass made by the site's server (table file_tickets). Rules live in the database:
// is_member / can_edit / use_ticket / storage_full. Paste this file into the Worker's editor to update it.
// Worker variables: SUPABASE_URL and SUPABASE_ANON_KEY (the public key, the same one the website ships).
//   GET    /list/<world id>               -> [{ path, bytes, updated }]
//   GET    /file/<world id>/<file path>   -> the file      PUT -> save it      DELETE -> remove it
//   PUT    /file/...?mp=start | ?mp=part&id=&n= | ?mp=done&id=   -> big files in 50 MB pieces (one request tops out at 100 MB)
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, PUT, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Ticket', 'Access-Control-Max-Age': '86400' };
const say = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

async function rpc(env, fn, args, jwt) {
  const ANON = env.SUPABASE_ANON_KEY;
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${jwt || ANON}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
  return r.ok ? r.json() : null;
}
const isId = (s) => /^[0-9a-f-]{36}$/.test(s || '');

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const u = new URL(req.url), parts = u.pathname.split('/');

    const [, kind, game, ...rest] = parts;
    const path = rest.map(decodeURIComponent).join('/');
    if (!isId(game) || (kind === 'file' && (!path || path.split('/').includes('..')))) return say({ error: 'bad address' }, 400);
    const write = req.method === 'PUT' || req.method === 'DELETE';
    const ticket = req.headers.get('X-Ticket') || u.searchParams.get('ticket');
    const jwt = req.headers.get('Authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1];
    const ok = ticket ? await rpc(env, 'use_ticket', { t: ticket, g: game, w: write }) : jwt ? await rpc(env, write ? 'can_edit' : 'is_member', { g: game }, jwt) : false;
    if (ok !== true) return say({ error: write ? "You can't change this world right now (the owner may be offline)." : 'Not your world, or log in again.' }, 403);

    if (kind === 'list') {
      const out = []; let cursor;
      do {
        const page = await env.BUCKET.list({ prefix: `${game}/`, cursor, limit: 1000 });
        for (const o of page.objects) out.push({ path: o.key.slice(game.length + 1), bytes: o.size, updated: o.uploaded.toISOString() });
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      return say(out);
    }
    if (kind !== 'file') return say({ error: 'use /list or /file' }, 404);
    const key = `${game}/${path}`;
    if (req.method === 'GET' || req.method === 'HEAD') {
      const o = req.method === 'GET' ? await env.BUCKET.get(key) : await env.BUCKET.head(key);
      if (!o) return say({ error: 'not found' }, 404);
      return new Response(req.method === 'GET' ? o.body : null, { headers: { ...CORS, 'Content-Type': 'application/octet-stream', 'Content-Length': String(o.size), 'Last-Modified': o.uploaded.toUTCString(), 'Cache-Control': 'no-store' } }); // browsers must not keep old copies of re-uploaded files
    }
    if (req.method === 'PUT') {
      const mp = u.searchParams.get('mp'), id = u.searchParams.get('id');
      if ((!mp || mp === 'start') && await rpc(env, 'storage_full', {})) return say({ error: 'Vibe by Side storage is full (9 GB free limit). Delete a world or big files first.' }, 507);
      if (mp === 'start') return say({ id: (await env.BUCKET.createMultipartUpload(key)).uploadId });
      if (mp === 'part') return say(await env.BUCKET.resumeMultipartUpload(key, id).uploadPart(+u.searchParams.get('n'), req.body));
      if (mp === 'done') { const o = await env.BUCKET.resumeMultipartUpload(key, id).complete(await req.json()); return say({ path, bytes: o.size, updated: o.uploaded.toISOString() }); }
      const o = await env.BUCKET.put(key, req.body);
      return say({ path, bytes: o.size, updated: o.uploaded.toISOString() });
    }
    if (req.method === 'DELETE') { await env.BUCKET.delete(key); return say({ deleted: path }); }
    return say({ error: 'method' }, 405);
  },
};
