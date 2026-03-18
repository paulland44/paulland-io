/**
 * Cloudflare Pages Function — API proxy for admin dashboard writes.
 *
 * Validates the Cloudflare Access JWT, then forwards the request to
 * Supabase using the service role key. This keeps the service key
 * server-side while allowing authenticated writes from the admin UI.
 *
 * Routes:
 *   POST /api/content/tags   — Update tags on a content item
 *   POST /api/daily-notes    — Create or update a daily note (upsert by date)
 */

export async function onRequest(context) {
  const { request, env } = context;

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: corsHeaders(),
    });
  }

  // Only allow POST
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  // Validate Cloudflare Access JWT
  const authResult = await validateAccessJWT(request, env);
  if (!authResult.valid) {
    return json({ error: 'Unauthorized', detail: authResult.reason }, 401);
  }

  // Route to handler
  const url = new URL(request.url);
  const path = url.pathname.replace('/api/', '');

  switch (path) {
    case 'content/tags':
      return handleUpdateTags(request, env);
    case 'daily-notes':
      return handleUpsertDailyNote(request, env);
    default:
      return json({ error: 'Not found' }, 404);
  }
}

// ─── Handlers ────────────────────────────────────────────────

async function handleUpdateTags(request, env) {
  const { id, tags } = await request.json();

  if (!id || !Array.isArray(tags)) {
    return json({ error: 'Missing id or tags array' }, 400);
  }

  // Sanitise tags
  const cleanTags = tags
    .map(t => String(t).trim().toLowerCase())
    .filter(t => t.length > 0);

  const supabaseUrl = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !serviceKey) {
    return json({ error: 'Server misconfigured' }, 500);
  }

  // Update via Supabase REST API
  const res = await fetch(
    `${supabaseUrl}/rest/v1/content?id=eq.${id}`,
    {
      method: 'PATCH',
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({ tags: cleanTags }),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    return json({ error: 'Supabase error', detail: text }, res.status);
  }

  return json({ ok: true, tags: cleanTags });
}

async function handleUpsertDailyNote(request, env) {
  const { note_date, tasks, notes, meetings, metadata } = await request.json();

  if (!note_date || !/^\d{4}-\d{2}-\d{2}$/.test(note_date)) {
    return json({ error: 'Invalid or missing note_date (YYYY-MM-DD)' }, 400);
  }

  const supabaseUrl = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !serviceKey) {
    return json({ error: 'Server misconfigured' }, 500);
  }

  const body = {
    note_date,
    tasks: tasks ?? '',
    notes: notes ?? '',
    meetings: meetings ?? '',
  };

  // Merge metadata if provided (preserves existing keys)
  if (metadata && typeof metadata === 'object') {
    body.metadata = metadata;
  }

  // Upsert via PostgREST — merge-duplicates resolves on the unique note_date constraint
  const res = await fetch(
    `${supabaseUrl}/rest/v1/daily_notes?on_conflict=note_date`,
    {
      method: 'POST',
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=representation',
      },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    return json({ error: 'Supabase error', detail: text }, res.status);
  }

  const data = await res.json();
  return json({ ok: true, daily_note: data[0] });
}

// ─── JWT validation ──────────────────────────────────────────

async function validateAccessJWT(request, env) {
  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN;
  const aud = env.CF_ACCESS_AUD;

  if (!teamDomain || !aud) {
    return { valid: false, reason: 'Access not configured' };
  }

  // Get the JWT from cookie or header
  const cookie = request.headers.get('Cookie') || '';
  const cfAuth = cookie.split(';').map(c => c.trim()).find(c => c.startsWith('CF_Authorization='));
  const token = cfAuth ? cfAuth.split('=')[1] : request.headers.get('Cf-Access-Jwt-Assertion');

  if (!token) {
    return { valid: false, reason: 'No token found' };
  }

  try {
    // Fetch the public keys from Cloudflare Access
    const certsUrl = `https://${teamDomain}/cdn-cgi/access/certs`;
    const certsRes = await fetch(certsUrl);
    if (!certsRes.ok) {
      return { valid: false, reason: 'Failed to fetch certs' };
    }
    const { keys } = await certsRes.json();

    // Decode the JWT header to find the right key
    const parts = token.split('.');
    if (parts.length !== 3) {
      return { valid: false, reason: 'Malformed token' };
    }

    const header = JSON.parse(atob(parts[0].replace(/-/g, '+').replace(/_/g, '/')));
    const kid = header.kid;

    const key = keys.find(k => k.kid === kid);
    if (!key) {
      return { valid: false, reason: 'Key not found' };
    }

    // Import the public key
    const cryptoKey = await crypto.subtle.importKey(
      'jwk',
      key,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    );

    // Verify the signature
    const signatureBytes = Uint8Array.from(atob(parts[2].replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const dataBytes = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);

    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      cryptoKey,
      signatureBytes,
      dataBytes
    );

    if (!valid) {
      return { valid: false, reason: 'Invalid signature' };
    }

    // Check claims
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    const now = Math.floor(Date.now() / 1000);

    if (payload.exp && payload.exp < now) {
      return { valid: false, reason: 'Token expired' };
    }

    if (payload.aud && !payload.aud.includes(aud)) {
      return { valid: false, reason: 'Audience mismatch' };
    }

    return { valid: true, email: payload.email };
  } catch (err) {
    return { valid: false, reason: `Validation error: ${err.message}` };
  }
}

// ─── Helpers ─────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(),
      'Content-Type': 'application/json',
    },
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
