// Vibe by Side MCP server (streamable HTTP at /mcp): how outside MCP clients join a world.
// Each person's client calls this with that person's own key or OAuth token, so everything it
// says, changes or writes shows up under their name in the room.
// The game's files live in R2 behind the files Worker (see lib/store.mjs); the file tools edit them in place.
import { createClient } from '@supabase/supabase-js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { verify } from '../lib/sign.mjs';
import * as store from '../lib/store.mjs';

async function pilot(req, db) {
  const raw = req.headers.get('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1] || new URL(req.url).searchParams.get('key');
  if (!raw) return null;
  const signed = verify(raw, 'access'); // "Log in with Vibe by Side" token (oauth.mjs)
  if (signed) return (await db.from('profiles').select('*').eq('id', signed.u).maybeSingle()).data;
  const { data: tok } = await db.from('api_tokens').select('user_id').eq('token_hash', createHash('sha256').update(raw).digest('hex')).maybeSingle();
  if (!tok) return null;
  return (await db.from('profiles').select('*').eq('id', tok.user_id).maybeSingle()).data;
}
async function worlds(db, me) { // the worlds this pilot owns or was invited into
  const { data: mem } = await db.from('members').select('game_id').eq('user_id', me.id);
  const ids = (mem || []).map((m) => m.game_id);
  const q = db.from('games').select('*').order('created_at');
  const { data } = await (ids.length ? q.or(`owner.eq.${me.id},id.in.(${ids.join(',')})`) : q.eq('owner', me.id));
  return data || [];
}
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
function dist(a, b) { // edit distance, so a misheard (dictated) world name still finds the right world
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] !== b[j - 1]));
    row = next;
  }
  return row[b.length];
}
async function findGame(db, me, name) {
  const all = await worlds(db, me), n = norm(name);
  const g = all.find((x) => norm(x.name) === n) || all.find((x) => norm(x.name).includes(n) || n.includes(norm(x.name)))
    || all.map((x) => [x, dist(norm(x.name), n)]).filter(([, d]) => d <= 3).sort((a, b) => a[1] - b[1])[0]?.[0];
  if (!g) throw new Error(`No world called "${name}" that ${me.name} can see. Worlds: ${all.map((x) => x.name).join(', ') || 'none'}.`);
  return g;
}
async function mayEdit(db, me, g) { // the owner always; an invited friend only while the owner is online in Vibe by Side
  if (g.owner === me.id) return;
  const { data } = await db.from('profiles').select('last_seen').eq('id', g.owner).maybeSingle();
  if (!data?.last_seen || Date.now() - new Date(data.last_seen) > 90000) throw new Error(`The owner of "${g.name}" is offline in Vibe by Side. Invited friends can change a world only while its owner is online. Tell your pilot and wait.`);
}
const listAll = (db, prefix) => store.list(prefix); // the world's files in R2: [{ path, bytes, updated }]

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version',
  'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id',
};
const db = () => createClient(Netlify.env.get('SUPABASE_URL'), Netlify.env.get('SUPABASE_SERVICE_KEY'), { auth: { persistSession: false } });
// pilots read game terms, not computer terms: drop anything that looks like a file, path, folder or code from assistant wording
const plain = (t) => t.replace(/\([^()]*(?:[\/]|\.(gd|tscn|tres|godot|import|cfg|json|md|txt|py|js|mjs|ts|html|css|toml|yaml|yml|xml|gdshader|png|jpe?g|gif|webp|mp4|webm|ogg|wav|mp3|avi|zip))[^()]*\)/gi, '') // a bracket holding a path or file goes whole .replace(/\S*[\/]\S*/g, '').replace(/[\w.-]+\.(gd|tscn|tres|godot|import|cfg|json|md|txt|py|js|mjs|ts|html|css|toml|yaml|yml|xml|gdshader|png|jpe?g|gif|webp|mp4|webm|ogg|wav|mp3|avi|zip)\b/gi, '') .replace(/\s{2,}/g, ' ').replace(/\s+([,.;:])/g, '$1').replace(/,\s*(and|but)\s+/g, ', $1 ').trim();
const text = (t) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }] });
const TEXTY = /\.(gd|tscn|tres|godot|import|cfg|json|md|txt|py|js|mjs|ts|html|css|toml|yaml|yml|xml|svg|gdshader|csv|ini|sh|bat|ps1)$/i;

function buildServer(sb, me) {
  const s = new McpServer({ name: 'vibe-by-side', version: '0.3.0' }, { instructions:
    'Vibe by Side holds your pilot\'s worlds (Godot games) and syncs them live to the pilots\' desktops. ' +
    'Keep token use low: list_files with a folder, read_file with from/lines on big files, recent with a small limit. ' +
    'Writes land in the world at once; an invited friend\'s assistant can write only while the world\'s owner is online. ' +
    'Your pilot often talks by voice: world names may be misheard; tools match loosely. ' +
    'When asked to change a game, do it without asking for files: search or list_files to find the spot, read_file only the lines you need, write_file, then tell the pilot in one sentence what changed. ' +
    'The pilot watches each change appear live on the world\'s page at vibebyside.com, and it syncs to their game folder. ' +
    'Jobs the pilot sends from a world\'s page are picked up with wait_for_task: call it again and again, do each task, then finish_task with one sentence. ' +
    'After EVERY change you make to a game, record a clip that shows ONLY the change (see PREVIEW RULE), slowed if it is fast, 1-3 seconds per thing shown (the effect, the move, the room) and attach it to the task: the pilots watch that clip in the world page, nobody rebuilds or reloads the game. ' +
    "PREVIEW RULE: the clip shows ONLY the change itself, nothing else - no other players' turns, no menus, no banners, no walking to the spot, no bots playing. One change = one short moment, repeated for each thing changed (e.g. a hero's 8 new cards = that hero playing each card, one after another, nothing between). Record it from the REAL game on the world's current files (the real board, room, character, HUD) by driving the game with a capture script that jumps straight to the change and records only it, slowed down if needed so it can be seen. NEVER stand-alone renders, mock tables, sandboxes or old preview tools. Keep it under 20 MB. " +
    'Upload it with upload_url to vibe-previews/task-<id>.mp4 (or .webm/.gif), then finish_task with preview set to that path. If you truly cannot make a clip, say why in finish_task. ' +
    'If a pilot asks how another pilot\'s assistant made something, call ask_other_assistant; the other assistant answers in the world\'s task list in short steps. ' +
    'HOW TO TALK: the pilots are gamers, not programmers. Every reply, say and finish_task is ONE plain sentence in video-game terms about what changed in the game (which character, move, effect, room, sound), the way a game update note reads. NEVER mention file names, paths, folders, extensions, sheet/manifest/script counts, code or tools. The server strips those anyway.' });
  const event = (g, kind, file, note) => sb.from('events').insert({ game_id: g.id, user_id: me.id, by_name: `${me.name}'s assistant`, kind, file, text: note });

  s.tool('whoami', 'Which Vibe by Side pilot you are acting as, and the worlds they can see.', {},
    async () => text({ name: me.name, assistants: me.assistants, worlds: (await worlds(sb, me)).map((g) => g.name) }));

  s.tool('list_games', 'List the worlds (games) this pilot owns or was invited into.', {}, async () => {
    return text((await worlds(sb, me)).map((g) => `${g.name}: ${g.files || 0} files, ${((g.bytes || 0) / 1048576).toFixed(0)} MB${g.owner === me.id ? ', yours' : ''}`).join('\n') || '(no worlds yet)');
  });

  s.tool('recent', 'Recent chat and file changes in a world. Read this before acting so you know what the other pilots and assistants just did.',
    { game: z.string().describe('world name'), limit: z.number().int().min(1).max(100).default(20) },
    async ({ game, limit }) => {
      const g = await findGame(sb, me, game);
      const { data } = await sb.from('events').select('created_at, by_name, kind, text, file').eq('game_id', g.id).order('id', { ascending: false }).limit(limit);
      return text(data.reverse().map((e) => `${e.created_at.slice(11, 16)} ${e.by_name} ${e.kind === 'change' ? `changed ${e.file}${e.text ? ` (${e.text})` : ''}` : e.text}`).join('\n') || '(quiet)');
    });

  s.tool('say', 'Post a chat message in a world as your pilot. Everyone in the room sees it instantly.',
    { game: z.string(), text: z.string().max(500) },
    async ({ game, text: t }) => { await event(await findGame(sb, me, game), 'chat', '', plain(t)); return text('said'); });

  // The "Tell my assistant" box on a world's page leaves jobs in assist_tasks for the pilot's own assistant.
  s.tool('wait_for_task', "Listen for jobs your pilot types into the 'Tell my assistant' box at vibebyside.com. Waits a few seconds; returns the next job (world + instructions) or says to call again.", {},
    async () => {
      for (let i = 0; i < 7; i++) { // Netlify gives a call ~10 s; check once a second
        const { data: t } = await sb.from('assist_tasks').select('id, game_id, text').eq('user_id', me.id).eq('status', 'waiting').order('id').limit(1).maybeSingle();
        if (t) {
          const { data: claimed } = await sb.from('assist_tasks').update({ status: 'working', updated_at: new Date().toISOString() }).eq('id', t.id).eq('status', 'waiting').select('id').maybeSingle();
          if (!claimed) continue; // another listener of the same pilot took it
          const { data: g } = await sb.from('games').select('name').eq('id', t.game_id).maybeSingle();
          if (/^[^:]{1,40} asks: /.test(t.text)) return text(`Task ${t.id} in world "${g?.name}": ${t.text}\n\nAnother pilot's assistant is asking you this, in the open. Answer in finish_task with up to 8 quick steps, one per line, each 10 words or fewer, in game terms (no file names). No clip needed.`);
          if (t.source_task) return text(`Task ${t.id} in world "${g?.name}": ${t.text}\n\nThis is a change another pilot's assistant already made in the world and your pilot (the world's owner) just APPROVED. Call task_changes with id ${t.source_task} to see exactly which game files it changed, read each from the world (read_file / download_url) and write those exact files into your pilot's game folder on this computer (same paths inside the game folder). Then finish_task ${t.id} with one plain sentence; no clip needed.`);
          return text(`Task ${t.id} in world "${g?.name}":\n${t.text}\n\nDo it with the vibe-by-side tools (world "${g?.name}"), then record a clip of ONLY the change (PREVIEW RULE in the server instructions) and upload it to vibe-previews/task-${t.id}.mp4 (upload_url), then call finish_task with id ${t.id} and preview "vibe-previews/task-${t.id}.mp4".`);
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      return text('No task yet. Call wait_for_task again to keep listening.');
    });

  // "How is your assistant making this?" - a pilot's assistant asks another pilot's assistant, in the open, in short steps
  s.tool('ask_other_assistant', "Ask another pilot's assistant in this world how it made something (or anything else). The question and its answer show in the world's task list for everyone; the answer comes in up to 8 steps of 10 words or fewer.",
    { game: z.string(), pilot: z.string().describe('the other pilot\'s username'), question: z.string().max(500) },
    async ({ game, pilot, question }) => {
      const g = await findGame(sb, me, game);
      const { data: mem } = await sb.from('members').select('user_id').eq('game_id', g.id);
      const ids = [g.owner, ...(mem || []).map((m) => m.user_id)].filter((i) => i && i !== me.id);
      const { data: who } = await sb.from('profiles').select('id,name').in('id', ids).ilike('name', `%${pilot.replace(/[%_]/g, '')}%`).limit(1).maybeSingle();
      if (!who) throw new Error(`No pilot like "${pilot}" in "${g.name}".`);
      const { error } = await sb.from('assist_tasks').insert({ game_id: g.id, user_id: who.id, text: `${me.name} asks: ${question}` });
      if (error) throw new Error(error.message);
      return text(`Asked ${who.name}'s assistant. Its answer shows in the world's task list when it is done (it must be listening).`);
    });

  s.tool('task_changes', "Exactly which game files a finished 'Tell my assistant' job changed in the world (paths + notes), so an approved change can be brought into a pilot's own game folder.",
    { id: z.number().int() },
    async ({ id }) => {
      const { data: t } = await sb.from('assist_tasks').select('game_id,user_id,text,created_at,updated_at').eq('id', id).maybeSingle();
      if (!t) throw new Error(`No task ${id}.`);
      const { data: ev } = await sb.from('events').select('file,text,created_at').eq('game_id', t.game_id).eq('user_id', t.user_id).eq('kind', 'change').gte('created_at', t.created_at).lte('created_at', t.updated_at).order('id');
      const files = [...new Map((ev || []).filter((e) => e.file && !e.file.startsWith('vibe-previews/')).map((e) => [e.file, e.text])).entries()];
      return text(files.length ? `Task ${id} ("${t.text}") changed:\n` + files.map(([f, n]) => `${f}${n && n !== 'edited' ? ` — ${n}` : ''}`).join('\n') : `Task ${id} recorded no file changes in the world.`);
    });

  s.tool('finish_task', "Report a 'Tell my assistant' job as done (or failed) with a one-sentence reply, and the preview clip you uploaded (world path, e.g. vibe-previews/task-12.mp4). The clip plays on the world's page for everyone.",
    { id: z.number().int(), reply: z.string().max(1000), ok: z.boolean().default(true), preview: z.string().max(300).default('').describe('world path of the clip you uploaded: vibe-previews/task-<id>.mp4, .webm or .gif') },
    async ({ id, reply, ok, preview }) => {
      reply = plain(reply);
      const { data: asked } = await sb.from('assist_tasks').select('text').eq('id', id).maybeSingle();
      if (asked && /^[^:]{1,40} asks: /.test(asked.text)) reply = reply.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 8).map((l) => l.split(/\s+/).slice(0, 10).join(' ')).join('\n'); // short steps, so the chat never overflows
      if (preview && !/^vibe-previews\/[^/]+\.(mp4|webm|gif)$/i.test(preview)) throw new Error('preview must be vibe-previews/<name>.mp4, .webm or .gif');
      const row = { status: ok ? 'done' : 'failed', reply, updated_at: new Date().toISOString() };
      let { data, error } = await sb.from('assist_tasks').update({ ...row, preview: preview || null }).eq('id', id).eq('user_id', me.id).select('id').maybeSingle();
      if (error?.message?.includes('preview')) ({ data, error } = await sb.from('assist_tasks').update({ ...row, reply: preview ? `${reply} (clip: ${preview})` : reply }).eq('id', id).eq('user_id', me.id).select('id').maybeSingle()); // shortcut: until the preview column exists, note the clip in the reply
      if (error || !data) throw new Error(error?.message || `No task ${id} of yours.`);
      return text('reported');
    });

  s.tool('list_files', "List a world's files (path + size). Give a folder to keep the list short.",
    { game: z.string(), folder: z.string().default('') },
    async ({ game, folder }) => {
      const g = await findGame(sb, me, game);
      const all = await listAll(sb, g.id);
      return text(all.filter((f) => f.path.startsWith(folder)).map((f) => `${f.path} (${f.bytes} B)`).join('\n') || '(no files)');
    });

  s.tool('search', "Find text in a world's code and text files: returns path:line: text. Cheaper than reading files to find the spot to change.",
    { game: z.string(), text: z.string().min(2).describe('words to find, not case sensitive'), folder: z.string().default('') },
    async ({ game, text: q, folder }) => {
      const g = await findGame(sb, me, game), want = q.toLowerCase();
      // shortcut: downloads up to 400 text files per call; add a server-side index if worlds get bigger than that
      const files = (await listAll(sb, g.id)).filter((f) => f.path.startsWith(folder) && TEXTY.test(f.path) && f.bytes < 1048576).slice(0, 400);
      const hits = [];
      for (let i = 0; i < files.length && hits.length < 60; i += 20) {
        await Promise.all(files.slice(i, i + 20).map(async (f) => {
          const data = await store.get(`${g.id}/${f.path}`).catch(() => null);
          if (!data) return;
          data.toString('utf8').split('\n').forEach((l, n) => { if (hits.length < 60 && l.toLowerCase().includes(want)) hits.push(`${f.path}:${n + 1}: ${l.trim().slice(0, 160)}`); });
        }));
      }
      return text(hits.join('\n') || `"${q}" not found in ${files.length} files.`);
    });

  s.tool('read_file', "Read one of a world's files. Text files come back as text (use from/lines to read only a part); others as base64.",
    { game: z.string(), path: z.string(), from: z.number().int().min(1).default(1).describe('first line, text files only'), lines: z.number().int().min(0).default(0).describe('how many lines; 0 = to the end') },
    async ({ game, path, from, lines }) => {
      const g = await findGame(sb, me, game);
      const buf = await store.get(`${g.id}/${path}`).catch((e) => { throw new Error(`${path}: ${e.message}`); });
      if (!TEXTY.test(path) && buf.length > 3 * 1048576) return text(`${path} is ${(buf.length / 1048576).toFixed(1)} MB, too big to send here. Use download_url.`);
      if (!TEXTY.test(path)) return text(`base64:${buf.toString('base64')}`);
      const all = buf.toString('utf8').split('\n');
      if (from === 1 && !lines) return text(all.join('\n'));
      const end = lines ? from - 1 + lines : all.length;
      return text(all.slice(from - 1, end).join('\n') + (end < all.length ? `\n… (${all.length} lines in all)` : ''));
    });

  s.tool('write_file', "Create or overwrite one of a world's files (up to ~3 MB; bigger: upload_url). This IS editing the game: it syncs to every pilot's desktop. Say what you changed in note.",
    { game: z.string(), path: z.string(), content: z.string(), encoding: z.enum(['utf8', 'base64']).default('utf8'), note: z.string().max(300).default('') },
    async ({ game, path, content, encoding, note }) => {
      const g = await findGame(sb, me, game);
      await mayEdit(sb, me, g);
      const body = Buffer.from(content, encoding);
      if (await store.full(sb)) throw new Error(store.FULL_MSG);
      await store.put(`${g.id}/${path}`, body);
      await event(g, 'change', path, note || 'edited');
      return text(`wrote ${path} (${body.length} B)`);
    });

  // write_file / read_file carry the file inside the tool call, and a call tops out around 4 MB.
  // Bigger files (art, audio) go straight to storage through a short-lived link instead.
  s.tool('upload_url', "For files over ~3 MB (art, audio, preview clips): get a one-hour link, upload the file bytes to it with HTTP PUT (e.g. curl -X PUT --data-binary @file \"<url>\"; over 90 MB send 50 MB pieces: PUT <url>&mp=start -> {id}, PUT each piece to <url>&mp=part&id=<id>&n=1,2,.. -> part, PUT the JSON list of parts to <url>&mp=done&id=<id>; send a real User-Agent, Cloudflare blocks blank ones), then call uploaded.",
    { game: z.string(), path: z.string() },
    async ({ game, path }) => {
      const g = await findGame(sb, me, game);
      await mayEdit(sb, me, g);
      if (await store.full(sb)) throw new Error(store.FULL_MSG);
      return text(`PUT the file to: ${await store.sign(`${g.id}/${path}`, 'PUT')}\nThen call uploaded with game "${g.name}" and path "${path}".`);
    });

  s.tool('uploaded', 'Tell everyone a file you sent through upload_url has landed, so it shows on the board and syncs to desktops.',
    { game: z.string(), path: z.string(), note: z.string().max(300).default('') },
    async ({ game, path, note }) => {
      const g = await findGame(sb, me, game);
      await event(g, 'change', path, note || 'uploaded');
      return text(`announced ${path}`);
    });

  s.tool('download_url', 'For big files: a one-hour link to download a file directly (e.g. curl -o file "<url>") instead of read_file.',
    { game: z.string(), path: z.string() },
    async ({ game, path }) => {
      const g = await findGame(sb, me, game);
      return text(await store.sign(`${g.id}/${path}`));
    });

  s.tool('delete_file', "Delete one of a world's files. Irreversible: confirm with the pilot first.",
    { game: z.string(), path: z.string() },
    async ({ game, path }) => {
      const g = await findGame(sb, me, game);
      await mayEdit(sb, me, g);
      await store.del([`${g.id}/${path}`]);
      await event(g, 'change', path, 'deleted');
      return text(`deleted ${path}`);
    });

  return s;
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return new Response('Vibe by Side MCP: POST only', { status: 405, headers: CORS });
  const sb = db();
  const me = await pilot(req, sb);
  if (!me) return new Response('Unauthorized: log in with Vibe by Side, or send a key as Authorization: Bearer', { status: 401, headers: { ...CORS,
    'WWW-Authenticate': `Bearer resource_metadata="${new URL(req.url).origin}/.well-known/oauth-protected-resource"` } });

  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true }); // stateless: a fresh transport per request
  await buildServer(sb, me).connect(transport);
  const res = await transport.handleRequest(req);
  for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v);
  return res;
};

export const config = { path: '/mcp', rateLimit: { windowSize: 60, windowLimit: 300, aggregateBy: ['ip'] } };
