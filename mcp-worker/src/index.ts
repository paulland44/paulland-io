/**
 * Cloudflare Worker — paulland.io Remote MCP Server
 *
 * Implements OAuth 2.0 Authorization Code + PKCE for Claude web/mobile/desktop.
 * The MCP_AUTH_TOKEN secret is the actual access token issued after OAuth flow.
 *
 * Endpoints:
 *   GET  /.well-known/oauth-authorization-server  — OAuth metadata discovery
 *   GET  /authorize                                — OAuth authorization (redirect-based)
 *   POST /token                                   — OAuth token exchange
 *   GET|POST|DELETE /mcp                          — MCP Streamable HTTP (Bearer auth)
 *   GET  /health                                  — Health check (public)
 */

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { initSupabase } from '../../mcp-server/src/supabase.js';
import { initEmbeddings } from '../../mcp-server/src/embeddings.js';
import { createServer } from '../../mcp-server/src/index.js';

interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
  MCP_AUTH_TOKEN: string; // The access token issued after OAuth
}

// ─── CORS ────────────────────────────────────────────────────

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Authorization, mcp-session-id, mcp-protocol-version',
  'Access-Control-Expose-Headers': 'mcp-session-id',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

// ─── OAuth helpers ───────────────────────────────────────────

const BASE_URL = 'https://paulland-mcp.paul-land.workers.dev';

/** HMAC-SHA256 of message using the MCP_AUTH_TOKEN as key */
async function hmacSign(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function hmacVerify(message: string, sig: string, secret: string): Promise<boolean> {
  const expected = await hmacSign(message, secret);
  if (expected.length !== sig.length) return false;
  // Constant-time comparison
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  }
  return diff === 0;
}

function base64url(str: string): string {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function fromBase64url(str: string): string {
  return atob(str.replace(/-/g, '+').replace(/_/g, '/'));
}

async function sha256Base64url(str: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/** Create a signed, self-contained authorization code (no storage needed) */
async function createAuthCode(
  redirectUri: string,
  state: string,
  codeChallenge: string,
  secret: string
): Promise<string> {
  const payload = base64url(JSON.stringify({
    redirect_uri: redirectUri,
    state,
    code_challenge: codeChallenge,
    ts: Date.now(),
  }));
  const sig = await hmacSign(payload, secret);
  return `${payload}.${sig}`;
}

interface AuthCodePayload {
  redirect_uri: string;
  state: string;
  code_challenge: string;
  ts: number;
}

/** Verify and decode an authorization code */
async function verifyAuthCode(
  code: string,
  secret: string
): Promise<AuthCodePayload | null> {
  const parts = code.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const valid = await hmacVerify(payload, sig, secret);
  if (!valid) return null;
  try {
    const data = JSON.parse(fromBase64url(payload)) as AuthCodePayload;
    // Code expires after 10 minutes
    if (Date.now() - data.ts > 10 * 60 * 1000) return null;
    return data;
  } catch {
    return null;
  }
}

// ─── OAuth Handlers ──────────────────────────────────────────

/** GET /.well-known/oauth-authorization-server */
function handleOAuthMetadata(): Response {
  return json({
    issuer: BASE_URL,
    authorization_endpoint: `${BASE_URL}/authorize`,
    token_endpoint: `${BASE_URL}/token`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  });
}

/** GET /authorize?redirect_uri=...&state=...&code_challenge=...&code_challenge_method=S256 */
async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const redirectUri = url.searchParams.get('redirect_uri');
  const state = url.searchParams.get('state') || '';
  const codeChallenge = url.searchParams.get('code_challenge') || '';
  const codeChallengeMethod = url.searchParams.get('code_challenge_method') || 'S256';

  if (!redirectUri) {
    return json({ error: 'invalid_request', error_description: 'redirect_uri is required' }, 400);
  }
  if (codeChallengeMethod !== 'S256') {
    return json({ error: 'invalid_request', error_description: 'Only S256 code_challenge_method is supported' }, 400);
  }

  // Generate signed auth code and redirect immediately
  // Security: the code is HMAC-signed with MCP_AUTH_TOKEN, so it cannot be forged.
  // Only our token endpoint (which knows the secret) can exchange it for a token.
  const code = await createAuthCode(redirectUri, state, codeChallenge, env.MCP_AUTH_TOKEN);
  const redirectUrl = new URL(redirectUri);
  redirectUrl.searchParams.set('code', code);
  if (state) redirectUrl.searchParams.set('state', state);

  return Response.redirect(redirectUrl.toString(), 302);
}

/** POST /token */
async function handleToken(request: Request, env: Env): Promise<Response> {
  let params: URLSearchParams;
  const contentType = request.headers.get('content-type') || '';

  if (contentType.includes('application/x-www-form-urlencoded')) {
    params = new URLSearchParams(await request.text());
  } else {
    // Some clients send JSON
    try {
      const body = await request.json() as Record<string, string>;
      params = new URLSearchParams(Object.entries(body));
    } catch {
      return json({ error: 'invalid_request', error_description: 'Unreadable body' }, 400);
    }
  }

  const grantType = params.get('grant_type');
  if (grantType !== 'authorization_code') {
    return json({ error: 'unsupported_grant_type' }, 400);
  }

  const code = params.get('code');
  const codeVerifier = params.get('code_verifier');
  const redirectUri = params.get('redirect_uri');

  if (!code) return json({ error: 'invalid_request', error_description: 'code is required' }, 400);

  const payload = await verifyAuthCode(code, env.MCP_AUTH_TOKEN);
  if (!payload) return json({ error: 'invalid_grant', error_description: 'Invalid or expired code' }, 400);

  if (redirectUri && payload.redirect_uri !== redirectUri) {
    return json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' }, 400);
  }

  // Verify PKCE
  if (payload.code_challenge && codeVerifier) {
    const challenge = await sha256Base64url(codeVerifier);
    if (challenge !== payload.code_challenge) {
      return json({ error: 'invalid_grant', error_description: 'code_verifier mismatch' }, 400);
    }
  }

  return json({
    access_token: env.MCP_AUTH_TOKEN,
    token_type: 'bearer',
    expires_in: 7776000, // 90 days — long-lived, client should refresh via OAuth when expired
  });
}

// ─── Worker Fetch Handler ────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // OAuth metadata discovery
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return handleOAuthMetadata();
    }

    // OAuth authorization endpoint
    if (url.pathname === '/authorize') {
      return handleAuthorize(request, env);
    }

    // OAuth token endpoint
    if (url.pathname === '/token') {
      return handleToken(request, env);
    }

    // Health check
    if (url.pathname === '/health') {
      return json({ status: 'ok', service: 'paulland-mcp' });
    }

    // MCP endpoint — accept both /mcp and /
    if (url.pathname !== '/mcp' && url.pathname !== '/') {
      return json({ error: 'Not Found', path: url.pathname }, 404);
    }

    // Validate Bearer token
    const authHeader = request.headers.get('authorization');
    const token = authHeader?.replace(/^Bearer\s+/i, '');
    if (!token || token !== env.MCP_AUTH_TOKEN) {
      return json({ error: 'Unauthorized' }, 401);
    }

    // Init Supabase + embeddings with Worker env
    initSupabase(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
    initEmbeddings(env.CF_ACCOUNT_ID, env.CF_API_TOKEN);

    // Fresh server + transport per request (required by SDK for stateless mode)
    const server = createServer();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    try {
      await server.connect(transport);
      const response = await transport.handleRequest(request);
      const headers = new Headers(response.headers);
      for (const [k, v] of Object.entries(CORS)) headers.set(k, v);

      // For SSE streams, we must NOT close transport/server until the
      // response body is fully consumed. Wrap the body to clean up on close.
      const originalBody = response.body;
      if (originalBody) {
        const { readable, writable } = new TransformStream();
        const cleanup = originalBody.pipeTo(writable).then(() => {
          transport.close().catch(() => {});
          server.close().catch(() => {});
        });
        // Suppress unhandled rejection if stream aborts
        cleanup.catch(() => {});
        return new Response(readable, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }

      return new Response(null, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch (err: any) {
      transport.close().catch(() => {});
      server.close().catch(() => {});
      return json({ error: err.message }, 500);
    }
  },
};
