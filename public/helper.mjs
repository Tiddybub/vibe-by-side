#!/usr/bin/env node
// Vibe by Side helper: waits for jobs a pilot sends from a world's page ("Send to my assistant"),
// runs your own command on each one, and reports the result back to the world's page.
//   node helper.mjs --key <your Vibe by Side key> --cmd "<command>" [--folder <your game folder>] [--server <MCP url>]
// The command runs in the game folder through the shell. The job text arrives on its stdin and in the
// VIBE_PROMPT environment variable, e.g. --cmd 'my-cli run "$VIBE_PROMPT"' (Windows cmd: %VIBE_PROMPT%).
// Needs Node 18+.
import { spawn } from 'node:child_process';

const arg = (name, fallback) => { const i = process.argv.indexOf('--' + name); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback; };
const KEY = arg('key', process.env.VIBE_KEY), CMD = arg('cmd', process.env.VIBE_CMD), FOLDER = arg('folder', process.cwd());
const MCP = arg('server', 'https://vibebyside.com/mcp');
if (!KEY || !CMD) { console.error('Usage: node helper.mjs --key <your Vibe by Side key> --cmd "<command>" [--folder <game folder>] [--server <MCP url>]'); process.exit(1); }

const say = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

async function tool(name, args = {}) { // one Vibe by Side MCP tool call
  const r = await fetch(MCP, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  if (r.status === 401) throw new Error('Vibe by Side does not know this key. Copy a fresh one from the lobby.');
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result?.content?.map((c) => c.text).join('\n') || '';
}

function run(prompt) { // the user's command, on this job, working in the game folder
  return new Promise((done) => {
    const p = spawn(CMD, { cwd: FOLDER, shell: true, stdio: ['pipe', 'inherit', 'inherit'], env: { ...process.env, VIBE_PROMPT: prompt } });
    p.stdin.on('error', () => {}); // the command may exit without reading stdin
    p.stdin.end(prompt);
    p.on('exit', (code) => done(code));
    p.on('error', (e) => { say(`Could not start the command: ${e.message}`); done(1); });
  });
}

say(`Vibe by Side helper: jobs run "${CMD}" in ${FOLDER}. Leave this window open (or run it at login).`);
for (;;) {
  let text = '';
  try { text = await tool('wait_for_task'); } catch (e) { say(e.message); await new Promise((r) => setTimeout(r, 15000)); continue; }
  const m = text.match(/^Task (\d+) in world "(.*?)"/);
  if (!m) continue; // "No task yet" - ask again straight away (the server waits ~7 s per call)
  say(`Job ${m[1]} in ${m[2]}: starting…`);
  const code = await run(`${text}\n\nYou are working in the game folder ${FOLDER} (the pilot's synced copy of the world "${m[2]}"). Use the vibe-by-side tools. When done, you MUST call finish_task with id ${m[1]}.`);
  if (code !== 0) { try { await tool('finish_task', { id: +m[1], reply: `The job command stopped with code ${code} before finishing.`, ok: false }); } catch {} }
  say(`Job ${m[1]} finished.`);
}
