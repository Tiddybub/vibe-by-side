# Vibe by Side

A website where friends build the same Godot game together in real time. Each person links their local
game folder to a shared, private "world"; changes sync both ways while the page is open, and everyone in
the world sees presence, cursors, chat and file changes live. Outside tools can join through an MCP server
and read or edit a world's files under the signed-in user's account.

Live at [vibebyside.com](https://vibebyside.com).

## Features

- **Accounts**: sign up with email verification, log in with username or email, password reset, profiles
  with avatar, bio and name color.
- **Private worlds**: a world is one Godot project. The owner invites friends; invited friends can edit
  only while the owner is online (enforced in the database with row level security).
- **Live rooms**: presence, live cursors, a shared activity feed (chat and file changes) and direct messages
  between friends, all over Supabase Realtime.
- **Folder sync**: the browser's File System Access API keeps a local game folder in step with the world.
  Saves go up within seconds; other people's changes come down automatically. Large files upload in
  50 MB parts.
- **Task queue**: a pilot types or dictates a change request on a world's page. A connected MCP client picks
  it up, makes the change and attaches a short preview clip that plays for everyone in the world. The world
  owner approves or rejects each change before it lands in their own folder.
- **MCP server** at `/mcp` (streamable HTTP) with tools for listing worlds, reading recent activity, chatting,
  searching, reading, writing, uploading and deleting files, and working the task queue.
- **Two ways to authenticate MCP clients**: per-user API keys (only SHA-256 hashes are stored) or
  OAuth 2.1 with PKCE and dynamic client registration, using stateless HMAC-signed tokens.
- **Storage limit guard**: uploads stop at 9 GB so the R2 bucket stays inside the free tier.

## Stack

- **Front end**: a single-page app in vanilla JavaScript, HTML and CSS (`public/`), no build step.
- **Back end**: Netlify Functions (Node, ES modules) for login, OAuth and the MCP server.
- **Database and auth**: Supabase Auth, Postgres with row level security, and Realtime.
- **File storage**: Cloudflare R2 behind a small Cloudflare Worker (`worker/files-worker.js`) that checks
  access through Postgres functions (`is_member`, `can_edit`, `use_ticket`, `storage_full`).
- **MCP**: `@modelcontextprotocol/sdk` with `zod` schemas.

## Project structure

```
public/
  index.html          the app: login, lobby, friends, worlds, room, folder sync, task queue
  connect.html        OAuth consent page ("Log in with Vibe by Side")
  config.example.js   public client settings (copy to config.js)
  helper.mjs          optional command-line worker for the task queue
  art/, sfx/          images and sounds
netlify/
  functions/login.mjs username-or-email login (resolves usernames server side)
  functions/oauth.mjs OAuth 2.1 metadata, client registration, consent and token endpoints
  functions/mcp.mjs   MCP server
  lib/sign.mjs        HMAC-signed stateless tokens
  lib/store.mjs       R2 file access through the Worker with short-lived file tickets
worker/files-worker.js  Cloudflare Worker in front of the R2 bucket
supabase/schema.sql     tables, policies, functions and realtime publication
scripts/
  move-to-r2.mjs        one-time migration from Supabase Storage to R2
  vibe_web_publish.py   uploads a Godot web build into a world with file tickets
```

## Setup

1. **Supabase**: create a project, open the SQL editor and run `supabase/schema.sql`. Under
   Authentication > URL configuration, add your site URL to the redirect URLs.
2. **Cloudflare**: create an R2 bucket and a Worker from `worker/files-worker.js`. Bind the bucket as
   `BUCKET` and set the Worker variables `SUPABASE_URL` and `SUPABASE_ANON_KEY`.
3. **Client config**: copy `public/config.example.js` to `public/config.js` and fill in the Supabase URL,
   the publishable (anon) key and the Worker address. `config.js` is not committed.
4. **Netlify**: set these environment variables on the site:

   | Name | Purpose |
   | --- | --- |
   | `SUPABASE_URL` | Supabase project URL |
   | `SUPABASE_ANON_KEY` | publishable key, used for password login |
   | `SUPABASE_SERVICE_KEY` | service role key (secret); also the root of the OAuth token signing key |
   | `FILES_URL` | address of the files Worker |

5. Install and run locally:

   ```
   npm install
   netlify dev
   ```

   Deploy with `netlify deploy --prod`.

## Usage

- Sign up, pick a username, then create a world from a Godot project folder (Chrome or Edge, since folder
  access uses the File System Access API).
- Add friends by username and invite them into a world from inside it.
- **Connect an assistant** (lobby): copy a standard `mcpServers` entry with your key, the bare server
  address for clients that sign in with OAuth, or the key on its own.
- In a room, type a change request and press **Send to my assistant**. Your connected client picks it up with
  the `wait_for_task` tool. To process jobs with any command-line tool instead, run the helper:

  ```
  node public/helper.mjs --key <your key> --cmd "<command>" --folder <game folder>
  ```

  Each job's text is passed to the command on stdin and in the `VIBE_PROMPT` environment variable.

## Notes

- Netlify Functions have a short time limit, so `wait_for_task` long-polls for about seven seconds and the
  caller loops.
- File tickets (`file_tickets` table) are short-lived passes that let the server and scripts reach R2
  without holding Cloudflare credentials.
