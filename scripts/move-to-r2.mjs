// One-time move of every world's files from Supabase Storage (1 GB free, full) to Cloudflare R2 (10 GB free),
// through the vibebyside-files Worker with a file pass per world. Re-runnable: files already in R2 are skipped.
// Run from the project folder:  netlify dev:exec node scripts/move-to-r2.mjs  (needs SUPABASE_URL, SUPABASE_SERVICE_KEY, FILES_URL)   (add the word delete to empty the old copies after a clean run)
import { createClient } from '@supabase/supabase-js';

const FILES = process.env.FILES_URL, del = process.argv.includes('delete'); // word, not a flag: netlify dev:exec eats --flags
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const url = (g, p) => `${FILES}/file/${g}/${p.split('/').map(encodeURIComponent).join('/')}`;

async function walk(dir, out = []) { // Supabase lists one folder at a time
  for (let off = 0; ; off += 1000) {
    const { data, error } = await sb.storage.from('games').list(dir, { limit: 1000, offset: off });
    if (error) throw error;
    for (const e of data) e.id ? out.push({ key: `${dir}/${e.name}`, size: e.metadata?.size ?? 0 }) : await walk(`${dir}/${e.name}`, out);
    if (data.length < 1000) return out;
  }
}
async function pass(game) {
  const { data, error } = await sb.from('file_tickets').insert({ game_id: game, can_write: true, expires: new Date(Date.now() + 6 * 3600e3).toISOString() }).select('id').single();
  if (error) throw error;
  return data.id;
}

const { data: games } = await sb.from('games').select('id, name');
for (const g of games) {
  const all = await walk(g.id), t = await pass(g.id), q = all.slice();
  const have = new Map((await (await fetch(`${FILES}/list/${g.id}`, { headers: { 'X-Ticket': t } })).json()).map((f) => [f.path, f.bytes]));
  let moved = 0; const bad = [];
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (q.length) {
      const f = q.shift(), path = f.key.slice(g.id.length + 1);
      if (have.get(path) !== f.size) {
        const { data, error } = await sb.storage.from('games').download(f.key);
        const r = !error && await fetch(url(g.id, path), { method: 'PUT', headers: { 'X-Ticket': t }, body: Buffer.from(await data.arrayBuffer()) }).catch(() => null);
        if (!r?.ok) { bad.push(`${path} (${r ? r.status : error?.message || 'network'})`); continue; }
      }
      if (++moved % 250 === 0) console.log(`${g.name}: ${moved} / ${all.length}`);
    }
  }));
  const now = await (await fetch(`${FILES}/list/${g.id}`, { headers: { 'X-Ticket': t } })).json();
  const bytes = now.reduce((a, f) => a + f.bytes, 0);
  await sb.from('games').update({ files: now.length, bytes }).eq('id', g.id);
  console.log(`${g.name}: ${moved} / ${all.length} moved, R2 now holds ${now.length} files, ${(bytes / 1048576).toFixed(0)} MB${bad.length ? `. FAILED ${bad.length}: ${bad.slice(0, 3).join(', ')}` : ''}`);
  if (del && !bad.length && now.length >= all.length) {
    for (let i = 0; i < all.length; i += 500) await sb.storage.from('games').remove(all.slice(i, i + 500).map((f) => f.key));
    console.log(`${g.name}: old Supabase copies deleted`);
  }
}
await sb.from('file_tickets').delete().lt('expires', new Date().toISOString()); // only spent passes
