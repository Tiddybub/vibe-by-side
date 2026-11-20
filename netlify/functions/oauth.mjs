// "Log in with Vibe by Side": OAuth 2.1 (PKCE + dynamic client registration) so MCP clients
// connect to /mcp by having the pilot log in, instead of pasting a key. The login page is public/connect.html.
import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { sign, verify } from '../lib/sign.mjs';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Protocol-Version' };
const J = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS } });
const bad = (error, error_description, status = 400) => J({ error, error_description }, status);
const AT = 7 * 86400, RT = 365 * 86400; // access token a week, refresh token a year

async function form(req) { // token requests come form-encoded; accept JSON too
  const t = await req.text();
  try { return JSON.parse(t); } catch { return Object.fromEntries(new URLSearchParams(t)); }
}
const okRedirect = (u) => { try { const x = new URL(u); return x.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(x.hostname); } catch { return false; } };
const clientOf = (id, redirect) => { const c = verify(id, 'client'); return c && c.r.includes(redirect) ? c : null; };

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url), o = url.origin, path = url.pathname;

  if (path.startsWith('/.well-known/oauth-protected-resource'))
    return J({ resource: `${o}/mcp`, authorization_servers: [o], bearer_methods_supported: ['header'], resource_name: 'Vibe by Side' });

  if (path === '/.well-known/oauth-authorization-server' || path === '/.well-known/openid-configuration')
    return J({
      issuer: o, authorization_endpoint: `${o}/connect.html`, token_endpoint: `${o}/oauth/token`, registration_endpoint: `${o}/oauth/register`,
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], scopes_supported: ['worlds'],
    });

  if (req.method !== 'POST') return bad('invalid_request', 'POST only', 405);

  if (path === '/oauth/register') { // the client id carries its own redirect addresses, signed
    const b = await form(req), r = b.redirect_uris;
    if (!Array.isArray(r) || !r.length || !r.every(okRedirect)) return bad('invalid_redirect_uri', 'redirect_uris must be https addresses');
    return J({ client_id: sign('client', { r }), client_name: b.client_name || 'MCP client', redirect_uris: r, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }, 201);
  }

  if (path === '/oauth/approve') { // connect.html, after the pilot logs in and presses Allow
    const b = await form(req);
    if (!clientOf(b.client_id, b.redirect_uri)) return bad('invalid_client', 'This app is not registered for that address.');
    if (!b.code_challenge || (b.code_challenge_method || 'S256') !== 'S256') return bad('invalid_request', 'PKCE S256 required');
    const admin = createClient(Netlify.env.get('SUPABASE_URL'), Netlify.env.get('SUPABASE_SERVICE_KEY'), { auth: { persistSession: false } });
    const { data } = await admin.auth.getUser(b.access_token || '');
    if (!data?.user) return bad('access_denied', 'Log in again.', 401);
    const to = new URL(b.redirect_uri);
    to.searchParams.set('code', sign('code', { u: data.user.id, c: b.code_challenge, r: b.redirect_uri, i: b.client_id }, 300));
    if (b.state) to.searchParams.set('state', b.state);
    return J({ redirect: to.href });
  }

  if (path === '/oauth/token') {
    const b = await form(req);
    let uid;
    if (b.grant_type === 'authorization_code') {
      // shortcut: a code is not marked used, so it works again for its 5 minutes; PKCE means only the client that asked can spend it
      const c = verify(b.code, 'code');
      if (!c || c.r !== b.redirect_uri || (b.client_id && c.i !== b.client_id)) return bad('invalid_grant', 'Code expired or not for this app.');
      if (createHash('sha256').update(b.code_verifier || '').digest('base64url') !== c.c) return bad('invalid_grant', 'PKCE check failed.');
      uid = c.u;
    } else if (b.grant_type === 'refresh_token') {
      uid = verify(b.refresh_token, 'refresh')?.u;
      if (!uid) return bad('invalid_grant', 'Log in again.');
    } else return bad('unsupported_grant_type', 'authorization_code or refresh_token');
    return J({ access_token: sign('access', { u: uid }, AT), token_type: 'Bearer', expires_in: AT, refresh_token: sign('refresh', { u: uid }, RT), scope: 'worlds' });
  }
  return bad('not_found', path, 404);
};

export const config = {
  path: ['/oauth/*', '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/*', '/.well-known/oauth-authorization-server', '/.well-known/openid-configuration'],
  rateLimit: { windowSize: 60, windowLimit: 60, aggregateBy: ['ip'] },
};
