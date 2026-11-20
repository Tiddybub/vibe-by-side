// Vibe by Side login: username or email + password. A username is turned into its email here,
// with the service key, so the browser never gets to read other pilots' emails.
import { createClient } from '@supabase/supabase-js';

const J = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export default async (req) => {
  if (req.method !== 'POST') return J({ error: 'POST only' }, 405);
  const { login, password, check } = await req.json().catch(() => ({}));
  const url = Netlify.env.get('SUPABASE_URL');
  const admin = createClient(url, Netlify.env.get('SUPABASE_SERVICE_KEY'), { auth: { persistSession: false } });
  if (check) { // sign-up asks whether a username is free
    const { data } = await admin.from('profiles').select('id').ilike('name', check).maybeSingle();
    return J({ taken: !!data });
  }
  if (!login || !password) return J({ error: 'Username or email, and your password.' }, 400);
  let email = login;
  if (!login.includes('@')) {
    const { data: p } = await admin.from('profiles').select('id').ilike('name', login).maybeSingle();
    const { data: u } = p ? await admin.auth.admin.getUserById(p.id) : { data: null };
    email = u?.user?.email;
    if (!email) return J({ error: 'No pilot with that username. Try your email.' }, 400);
  }
  const anon = createClient(url, Netlify.env.get('SUPABASE_ANON_KEY'), { auth: { persistSession: false } });
  const { data, error } = await anon.auth.signInWithPassword({ email, password });
  if (error) return J({ error: error.message === 'Email not confirmed' ? 'Verify your email first: the link is in your inbox.' : error.message }, 401);
  return J({ tokens: { access_token: data.session.access_token, refresh_token: data.session.refresh_token } });
};

export const config = { path: '/login', rateLimit: { windowSize: 60, windowLimit: 20, aggregateBy: ['ip'] } };
