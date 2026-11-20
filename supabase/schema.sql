-- Vibe by Side database. Paste into the Supabase SQL editor and run once.

create table if not exists profiles (
  id uuid primary key references auth.users on delete cascade,
  name text not null,
  assistants text default '',
  color text default '#7ec8ff'
);
create table if not exists games (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner uuid references auth.users on delete set null,
  created_at timestamptz default now()
);
create table if not exists events (
  id bigserial primary key,
  game_id uuid not null references games on delete cascade,
  user_id uuid references auth.users on delete set null,
  by_name text not null,
  kind text not null check (kind in ('chat','change','system')),
  text text default '',
  file text default '',
  created_at timestamptz default now()
);
create index if not exists events_game on events (game_id, id);
create table if not exists api_tokens (
  token_hash text primary key,
  user_id uuid not null references auth.users on delete cascade,
  created_at timestamptz default now()
);

alter table profiles enable row level security;
alter table games enable row level security;
alter table events enable row level security;
alter table api_tokens enable row level security;

create policy "read profiles" on profiles for select to authenticated using (true);
create policy "own profile" on profiles for insert to authenticated with check (id = auth.uid());
create policy "edit own profile" on profiles for update to authenticated using (id = auth.uid());

create policy "read games" on games for select to authenticated using (true);
create policy "add game" on games for insert to authenticated with check (owner = auth.uid());

create policy "read events" on events for select to authenticated using (true);
create policy "post as self" on events for insert to authenticated with check (user_id = auth.uid());

create policy "own tokens" on api_tokens for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

alter publication supabase_realtime add table events;
alter publication supabase_realtime add table games;

-- Game files live in Vibe by Side (Storage bucket "games", path <game id>/<file path>).
alter table games add column if not exists files int default 0, add column if not exists bytes bigint default 0;
create policy "owner edits game" on games for update to authenticated using (owner = auth.uid());
insert into storage.buckets (id, name, public, file_size_limit) values ('games', 'games', false, 52428800) on conflict (id) do nothing;
create policy "pilots read files" on storage.objects for select to authenticated using (bucket_id = 'games');
create policy "pilots add files" on storage.objects for insert to authenticated with check (bucket_id = 'games');
create policy "pilots change files" on storage.objects for update to authenticated using (bucket_id = 'games');
create policy "pilots remove files" on storage.objects for delete to authenticated using (bucket_id = 'games');

create policy "owner removes game" on games for delete to authenticated using (owner = auth.uid());

-- 2026-11-06: worlds, friends, invited collaborators. Run this block once (everything above already ran).
-- A world is seen by its owner and the friends invited into it. Invited friends may change it
-- only while the owner is online in Vibe by Side (browser heartbeat within the last 90 s).
alter table profiles add column if not exists last_seen timestamptz default now();
create unique index if not exists profiles_name_key on profiles (lower(name));
create table if not exists friends (
  user_id uuid not null references auth.users on delete cascade,
  friend_id uuid not null references auth.users on delete cascade,
  created_at timestamptz default now(),
  primary key (user_id, friend_id),
  check (user_id <> friend_id)
);
create table if not exists members (
  game_id uuid not null references games on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  created_at timestamptz default now(),
  primary key (game_id, user_id)
);
alter table friends enable row level security;
alter table members enable row level security;
create or replace function is_member(g uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from games where id = g and owner = auth.uid())
      or exists (select 1 from members where game_id = g and user_id = auth.uid());
$$;
create or replace function owner_online(g uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from games join profiles on profiles.id = games.owner
                 where games.id = g and profiles.last_seen > now() - interval '90 seconds');
$$;
create or replace function can_edit(g uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from games where id = g and owner = auth.uid())
      or (exists (select 1 from members where game_id = g and user_id = auth.uid()) and owner_online(g));
$$;
drop policy if exists "read games" on games;
create policy "read games" on games for select to authenticated using (is_member(id));
drop policy if exists "read events" on events;
create policy "read events" on events for select to authenticated using (is_member(game_id));
drop policy if exists "post as self" on events;
create policy "post as self" on events for insert to authenticated with check (user_id = auth.uid() and is_member(game_id));
drop policy if exists "pilots read files" on storage.objects;
drop policy if exists "pilots add files" on storage.objects;
drop policy if exists "pilots change files" on storage.objects;
drop policy if exists "pilots remove files" on storage.objects;
create policy "members read files" on storage.objects for select to authenticated using (bucket_id = 'games' and is_member(split_part(name, '/', 1)::uuid));
create policy "editors add files" on storage.objects for insert to authenticated with check (bucket_id = 'games' and can_edit(split_part(name, '/', 1)::uuid));
create policy "editors change files" on storage.objects for update to authenticated using (bucket_id = 'games' and can_edit(split_part(name, '/', 1)::uuid));
create policy "editors remove files" on storage.objects for delete to authenticated using (bucket_id = 'games' and can_edit(split_part(name, '/', 1)::uuid));
create policy "see friends" on friends for select to authenticated using (user_id = auth.uid() or friend_id = auth.uid());
create policy "add friend" on friends for insert to authenticated with check (user_id = auth.uid());
create policy "drop friend" on friends for delete to authenticated using (user_id = auth.uid() or friend_id = auth.uid());
create policy "see members" on members for select to authenticated using (is_member(game_id));
create policy "owner invites" on members for insert to authenticated with check (exists (select 1 from games where id = game_id and owner = auth.uid()));
create policy "owner removes or leave" on members for delete to authenticated using (user_id = auth.uid() or exists (select 1 from games where id = game_id and owner = auth.uid()));
alter publication supabase_realtime add table friends, members;

-- 2026-11-06: profile picture (small webp data URL made in the browser) and an "about me" line. Already run.
alter table profiles add column if not exists avatar text check (length(avatar) < 200000), add column if not exists bio text default '' check (length(bio) <= 300);

-- 2026-11-06: direct messages between friends. Already run.
create table if not exists messages (
  id bigserial primary key,
  from_id uuid not null default auth.uid() references auth.users on delete cascade,
  to_id uuid not null references auth.users on delete cascade,
  text text not null check (length(text) between 1 and 2000),
  created_at timestamptz default now(),
  read_at timestamptz
);
create index if not exists messages_pair on messages (from_id, to_id, id);
create index if not exists messages_unread on messages (to_id) where read_at is null;
alter table messages enable row level security;
create policy "read own messages" on messages for select to authenticated using (from_id = auth.uid() or to_id = auth.uid());
create policy "message friends" on messages for insert to authenticated with check (from_id = auth.uid() and exists (
  select 1 from friends a join friends b on b.user_id = a.friend_id and b.friend_id = a.user_id where a.user_id = auth.uid() and a.friend_id = to_id));
create or replace function mark_read(other uuid) returns void language sql security definer set search_path = public as $$
  update messages set read_at = now() where to_id = auth.uid() and from_id = other and read_at is null;
$$;
alter publication supabase_realtime add table messages;

-- 2026-11-06 fix (already run): a new world must be readable by its owner inside its own insert ... returning,
-- where is_member() cannot see the row yet ("new row violates row-level security policy for table games").
drop policy if exists "read games" on games;
create policy "read games" on games for select to authenticated using (owner = auth.uid() or is_member(id));

-- 2026-11-06 (already run): game files moved to Cloudflare R2 behind the keyless "vibebyside-files" Worker (worker/files-worker.js).
-- The old "games" bucket and its storage policies are gone. Browser = login (is_member / can_edit); MCP server = file passes.
create table if not exists file_tickets (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references games on delete cascade,
  can_write boolean not null default false,
  expires timestamptz not null default now() + interval '15 minutes'
);
alter table file_tickets enable row level security; -- no policies: only the server (service key) makes passes
create or replace function use_ticket(t uuid, g uuid, w boolean) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from file_tickets where id = t and game_id = g and expires > now() and (can_write or not w));
$$;
create or replace function storage_full() returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(sum(bytes), 0) >= 9::bigint * 1073741824 from games; -- R2 is free to 10 GB; stay under it
$$;
grant execute on function use_ticket(uuid, uuid, boolean), storage_full() to anon, authenticated;
create or replace function play_ticket(g uuid) returns uuid language plpgsql volatile security definer set search_path = public as $$
declare t uuid;
begin
  if not is_member(g) then raise exception 'not your world'; end if;
  delete from file_tickets where expires < now();
  insert into file_tickets (game_id, can_write, expires) values (g, false, now() + interval '12 hours') returning id into t;
  return t;
end $$;
revoke execute on function play_ticket(uuid) from public, anon;
grant execute on function play_ticket(uuid) to authenticated;
-- "Tell my assistant": jobs for a pilot's own assistant, seen by everyone in the world
create table if not exists assist_tasks (
  id bigserial primary key,
  game_id uuid not null references games on delete cascade,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  text text not null check (length(text) between 1 and 4000),
  status text not null default 'waiting' check (status in ('waiting','working','done','failed')),
  reply text default '',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists assist_tasks_queue on assist_tasks (user_id, status, id);
alter table assist_tasks enable row level security;
create policy "see world tasks" on assist_tasks for select to authenticated using (is_member(game_id));
create policy "give my assistant a task" on assist_tasks for insert to authenticated with check (user_id = auth.uid() and is_member(game_id));
create policy "cancel my task" on assist_tasks for delete to authenticated using (user_id = auth.uid());
alter publication supabase_realtime add table assist_tasks;

-- 2026-11-07: the preview is a 5-10 s clip per finished change (assist_tasks.preview = vibe-previews/task-<id>.mp4), never the whole game.
drop function if exists play_ticket(uuid);
alter table assist_tasks add column if not exists preview text check (preview is null or preview ~ '^vibe-previews/[^/]+\.(mp4|webm|gif)$');

-- 2026-11-07 (already run): the host approves each finished change (clip) before it goes into their game folder.
alter table assist_tasks add column if not exists approved_at timestamptz;
create policy "owner approves" on assist_tasks for update to authenticated using (exists (select 1 from games where id = game_id and owner = auth.uid()));

-- 2026-11-07 (already run): Approve / Don't approve. Approving makes a job for the host's own assistant (source_task = the change it brings in).
alter table assist_tasks drop column if exists approved_at;
alter table assist_tasks add column if not exists decision text check (decision in ('approved','rejected')), add column if not exists source_task bigint references assist_tasks on delete set null;

-- 2026-11-07 (already run): live "job changed" updates need the whole row in the change stream.
alter table assist_tasks replica identity full;

-- Approvals are posted to the feed as events of kind 'approve' (the room plays a clap for them).
alter table events drop constraint if exists events_kind_check;
alter table events add constraint events_kind_check check (kind in ('chat','change','system','approve'));
