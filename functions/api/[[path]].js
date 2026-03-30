/**
 * Cloudflare Pages Function — API proxy for admin dashboard.
 *
 * Validates the Cloudflare Access JWT, then handles requests.
 * Writes go to Supabase via the service role key.
 * Calendar reads fetch from Outlook ICS feed.
 *
 * Routes:
 *   POST /api/content/tags     — Update tags on a content item
 *   POST /api/daily-notes      — Create or update a daily note (upsert by date)
 *   POST /api/daily-review     — AI end-of-day review (extract & distribute content)
 *   GET  /api/calendar-events  — Fetch calendar events for a date from ICS feed
 *   POST /api/entity-update    — Update any entity (people, products, projects)
 *   POST /api/entity-log       — Add a log entry (people_log, project_updates)
 *   POST /api/generate-summary — AI weekly/monthly summary generation
 *   POST /api/assets/upload    — Upload file to R2 + create metadata in Supabase
 *   GET  /api/assets/file/:key — Serve file from R2
 *   DELETE /api/assets/:id     — Delete asset from R2 + Supabase
 *   POST /api/embed            — Embed a single item (source_table, source_id)
 *   POST /api/embed-batch      — Batch embed unembedded content
 *   POST /api/search           — Vector similarity search
 *   POST /api/ask              — RAG: vector search + Claude answer
 */

export async function onRequest(ctx) {
  const { request, env } = ctx;

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: corsHeaders(),
    });
  }

  // Allow trusted internal server-to-server calls (e.g. MCP Worker) via pre-shared key
  const internalKey = request.headers.get('X-Internal-API-Key');
  const isInternalRequest = internalKey && env.PAULLAND_INTERNAL_API_KEY && internalKey === env.PAULLAND_INTERNAL_API_KEY;

  if (!isInternalRequest) {
    // Validate Cloudflare Access JWT for all other requests
    const authResult = await validateAccessJWT(request, env);
    if (!authResult.valid) {
      return json({ error: 'Unauthorized', detail: authResult.reason }, 401);
    }
  }

  // Route to handler
  const url = new URL(request.url);
  const path = url.pathname.replace('/api/', '');

  // ─── MIS Proxy Routes ───────────────────────────────────────
  if (path.startsWith('mis/')) {
    return handleMisRoute(path, request, env);
  }

  // List R2 bucket objects — GET /api/assets/r2-list
  if (request.method === 'GET' && path === 'assets/r2-list') {
    return handleR2List(env);
  }

  // Asset file serving — GET /api/assets/file/...
  if (request.method === 'GET' && path.startsWith('assets/file/')) {
    const r2Key = path.replace('assets/file/', '');
    return handleAssetServe(r2Key, env);
  }

  // Link deletion — DELETE /api/product-link?table=...&id=...
  if (request.method === 'DELETE' && (path === 'product-link' || path === 'entity-link')) {
    return handleProductUnlink(request, env);
  }

  // Asset deletion — DELETE /api/assets/:id
  if (request.method === 'DELETE' && path.startsWith('assets/')) {
    const assetId = path.replace('assets/', '');
    return handleAssetDelete(assetId, env);
  }

  if (request.method === 'GET') {
    switch (path) {
      case 'calendar-events':
        return handleCalendarEvents(request, env);
      default:
        return json({ error: 'Not found' }, 404);
    }
  }

  if (request.method === 'POST') {
    switch (path) {
      case 'content/tags':
        return handleUpdateTags(request, env, ctx);
      case 'daily-notes':
        return handleUpsertDailyNote(request, env, ctx);
      case 'daily-review':
        return handleDailyReview(request, env, ctx);
      case 'entity-update':
        return handleEntityUpdate(request, env, ctx);
      case 'entity-log':
        return handleEntityLog(request, env, ctx);
      case 'generate-summary':
        return handleGenerateSummary(request, env, ctx);
      case 'assets/upload':
        return handleAssetUpload(request, env);
      case 'embed':
        return handleEmbed(request, env);
      case 'embed-batch':
        return handleEmbedBatch(request, env);
      case 'search':
        return handleSearch(request, env);
      case 'ask':
        return handleAsk(request, env);
      case 'feed-items/capture':
        return handleFeedItemCapture(request, env);
      case 'competitor-research':
        return handleCompetitorResearch(request, env);
      case 'extract-signals':
        return handleExtractSignals(request, env);
      case 'signal-synthesis':
        return handleSignalSynthesis(request, env);
      default:
        return json({ error: 'Not found' }, 404);
    }
  }

  return json({ error: 'Method not allowed' }, 405);
}

// ─── MIS Token Encryption (AES-GCM) ──────────────────────────

async function getEncryptionKey(env) {
  const secret = env.MIS_ENCRYPTION_KEY || 'default-dev-key-change-in-production';
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret.padEnd(32, '0').slice(0, 32)),
    'AES-GCM',
    false,
    ['encrypt', 'decrypt']
  );
  return keyMaterial;
}

async function encryptToken(plaintext, env) {
  const key = await getEncryptionKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  return {
    encrypted_token: btoa(String.fromCharCode(...new Uint8Array(ciphertext))),
    token_iv: btoa(String.fromCharCode(...iv)),
  };
}

async function decryptToken(encrypted_token, token_iv, env) {
  const key = await getEncryptionKey(env);
  const ciphertext = Uint8Array.from(atob(encrypted_token), c => c.charCodeAt(0));
  const iv = Uint8Array.from(atob(token_iv), c => c.charCodeAt(0));
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return new TextDecoder().decode(decrypted);
}

// ─── MIS Connection Management ───────────────────────────────

async function handleMisConnections(path, request, env) {
  const supabaseUrl = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_KEY;
  const subPath = path.replace('mis/connections', '').replace(/^\//, '');

  // GET /api/mis/connections — list all (tokens excluded)
  if (request.method === 'GET' && !subPath) {
    const rows = await supabaseGet(supabaseUrl, serviceKey,
      'mis_connections?select=id,name,type,is_active,cluster,ecan,repo_id,server_url,created_at,updated_at&order=created_at.desc'
    );
    return json(rows);
  }

  // GET /api/mis/connections/:id — get single (token excluded)
  if (request.method === 'GET' && subPath) {
    const id = subPath;
    const rows = await supabaseGet(supabaseUrl, serviceKey,
      `mis_connections?id=eq.${id}&select=id,name,type,is_active,cluster,ecan,repo_id,server_url,created_at,updated_at`
    );
    return json(rows[0] || null);
  }

  // POST /api/mis/connections — create new
  if (request.method === 'POST' && !subPath) {
    const body = await request.json();
    const { name, type, cluster, ecan, repo_id, server_url, token, is_active } = body;

    if (!name || !type) return json({ error: 'name and type are required' }, 400);
    if (type === 'wcp' && (!cluster || !ecan || !repo_id)) {
      return json({ error: 'WCP connections require cluster, ecan, and repo_id' }, 400);
    }
    if (type === 'ae' && !server_url) {
      return json({ error: 'AE connections require server_url' }, 400);
    }
    if (!token) return json({ error: 'token is required' }, 400);

    // Encrypt the token
    const { encrypted_token, token_iv } = await encryptToken(token, env);

    // If setting as active, deactivate all others first
    if (is_active) {
      await supabasePatch(supabaseUrl, serviceKey,
        'mis_connections?is_active=eq.true',
        { is_active: false }
      );
    }

    const row = {
      name, type, is_active: !!is_active,
      cluster: type === 'wcp' ? cluster : null,
      ecan: type === 'wcp' ? ecan : null,
      repo_id: type === 'wcp' ? repo_id : null,
      server_url: type === 'ae' ? server_url : null,
      encrypted_token, token_iv,
    };

    const res = await fetch(`${supabaseUrl}/rest/v1/mis_connections`, {
      method: 'POST',
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: JSON.stringify(row),
    });
    const created = await res.json();
    // Return without encrypted fields
    if (Array.isArray(created) && created[0]) {
      const { encrypted_token: _e, token_iv: _iv, ...safe } = created[0];
      return json(safe, 201);
    }
    return json(created, res.status);
  }

  // PATCH /api/mis/connections/:id — update
  if (request.method === 'PATCH' && subPath) {
    const id = subPath;
    const body = await request.json();
    const updates = {};

    // Copy non-token fields
    for (const field of ['name', 'type', 'cluster', 'ecan', 'repo_id', 'server_url', 'is_active']) {
      if (body[field] !== undefined) updates[field] = body[field];
    }

    // If updating token, encrypt it
    if (body.token) {
      const { encrypted_token, token_iv } = await encryptToken(body.token, env);
      updates.encrypted_token = encrypted_token;
      updates.token_iv = token_iv;
    }

    // If setting as active, deactivate all others first
    if (updates.is_active) {
      await supabasePatch(supabaseUrl, serviceKey,
        `mis_connections?is_active=eq.true&id=neq.${id}`,
        { is_active: false }
      );
    }

    await supabasePatch(supabaseUrl, serviceKey,
      `mis_connections?id=eq.${id}`,
      updates
    );

    return json({ success: true });
  }

  // DELETE /api/mis/connections/:id
  if (request.method === 'DELETE' && subPath) {
    const id = subPath;
    await fetch(`${supabaseUrl}/rest/v1/mis_connections?id=eq.${id}`, {
      method: 'DELETE',
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
      },
    });
    return json({ success: true });
  }

  return json({ error: 'Not found' }, 404);
}

// ─── MIS Jobs Management ──────────────────────────────────────

async function handleMisJobs(path, request, env) {
  const supabaseUrl = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_KEY;
  const subPath = path.replace('mis/jobs', '').replace(/^\//, '');

  // GET /api/mis/jobs — list all jobs
  if (request.method === 'GET' && !subPath) {
    const rows = await supabaseGet(supabaseUrl, serviceKey,
      'mis_jobs?order=created_at.desc&limit=200'
    );
    return json(rows);
  }

  // GET /api/mis/jobs/:id — get single job
  if (request.method === 'GET' && subPath) {
    const id = subPath;
    const rows = await supabaseGet(supabaseUrl, serviceKey,
      `mis_jobs?id=eq.${id}`
    );
    return json(rows[0] || null);
  }

  // POST /api/mis/jobs — create new job record
  if (request.method === 'POST' && !subPath) {
    const body = await request.json();
    const row = {
      job_id: body.job_id || '',
      job_name: body.job_name || '',
      customer_code: body.customer_code || '',
      customer_name: body.customer_name || '',
      status: body.status || 'Created',
      phase: body.phase || 'Draft',
      due_date: body.due_date || null,
      description: body.description || '',
      connection_id: body.connection_id || null,
      connection_name: body.connection_name || '',
      solution: body.solution || 'wcp',
      cluster: body.cluster || '',
      payload: body.payload || null,
      wcp_response: body.wcp_response || null,
    };

    const res = await fetch(`${supabaseUrl}/rest/v1/mis_jobs`, {
      method: 'POST',
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: JSON.stringify(row),
    });
    const created = await res.json();
    return json(Array.isArray(created) ? created[0] : created, res.status === 201 ? 201 : res.status);
  }

  // PATCH /api/mis/jobs/:id — update job
  if (request.method === 'PATCH' && subPath) {
    const id = subPath;
    const body = await request.json();
    const updates = { updated_at: new Date().toISOString() };

    // Only copy allowed fields
    for (const field of ['job_name', 'customer_code', 'customer_name', 'status', 'phase',
                         'due_date', 'description', 'payload', 'wcp_response']) {
      if (body[field] !== undefined) updates[field] = body[field];
    }

    await supabasePatch(supabaseUrl, serviceKey,
      `mis_jobs?id=eq.${id}`,
      updates
    );
    return json({ success: true });
  }

  // DELETE /api/mis/jobs/:id — delete job
  if (request.method === 'DELETE' && subPath) {
    const id = subPath;
    await fetch(`${supabaseUrl}/rest/v1/mis_jobs?id=eq.${id}`, {
      method: 'DELETE',
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
      },
    });
    return json({ success: true });
  }

  return json({ error: 'Not found' }, 404);
}

// Helper: Get decrypted token for a connection by ID
async function getConnectionToken(connectionId, env) {
  const supabaseUrl = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_KEY;
  const rows = await supabaseGet(supabaseUrl, serviceKey,
    `mis_connections?id=eq.${connectionId}&select=encrypted_token,token_iv,type,cluster,ecan,repo_id,server_url`
  );
  if (!rows || !rows[0]) return null;
  const conn = rows[0];
  if (!conn.encrypted_token || !conn.token_iv) return null;
  try {
    conn.token = await decryptToken(conn.encrypted_token, conn.token_iv, env);
  } catch {
    return null;
  }
  return conn;
}

// Helper: Get active connection with decrypted token
async function getActiveConnection(env) {
  const supabaseUrl = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_KEY;
  const rows = await supabaseGet(supabaseUrl, serviceKey,
    `mis_connections?is_active=eq.true&select=id,name,type,encrypted_token,token_iv,cluster,ecan,repo_id,server_url`
  );
  if (!rows || !rows[0]) return null;
  const conn = rows[0];
  if (!conn.encrypted_token || !conn.token_iv) return null;
  try {
    conn.token = await decryptToken(conn.encrypted_token, conn.token_iv, env);
  } catch {
    return null;
  }
  return conn;
}

// ─── MIS Proxy Routes ────────────────────────────────────────

async function handleMisRoute(path, request, env) {
  // Route connection management requests
  if (path.startsWith('mis/connections')) {
    return handleMisConnections(path, request, env);
  }

  // Route job management requests (Supabase-backed)
  if (path.startsWith('mis/jobs')) {
    return handleMisJobs(path, request, env);
  }

  // Resolve connection credentials:
  // 1. Connection ID header (Supabase-backed, token server-side) — preferred
  // 2. Legacy: browser headers (X-WCP-Token etc.) — fallback
  const connectionId = request.headers.get('X-MIS-Connection-Id');
  let cluster, WCP_ECAN, WCP_REPOID, token;

  if (connectionId) {
    const conn = await getConnectionToken(connectionId, env);
    if (!conn) return json({ error: 'Connection not found or token decryption failed' }, 403);
    cluster = conn.cluster || 'eu';
    WCP_ECAN = conn.ecan || '';
    WCP_REPOID = conn.repo_id || '';
    token = conn.token || '';
  } else {
    // Legacy: read from browser headers / env vars
    cluster = request.headers.get('X-WCP-Cluster')
      || request.headers.get('X-WCP-Region')
      || env.WCP_REGION || 'eu';
    WCP_ECAN = request.headers.get('X-WCP-Ecan') || env.WCP_ECAN || '';
    WCP_REPOID = request.headers.get('X-WCP-RepoId') || env.WCP_REPOID || '';
    token = request.headers.get('X-WCP-Token') || env.WCP_EQUIPMENT_TOKEN || '';
  }

  // Check if WCP is configured
  if (!token || !WCP_ECAN || !WCP_REPOID) {
    return json({ error: 'WebCenter Pack not configured. Set up a connection in MIS Settings.' }, 503);
  }

  // Build base URLs — production clusters (eu/us) use esko.cloud, dev/test use cloudi.city
  function buildBaseUrls(c) {
    const isProduction = /^(eu|us)$/i.test(c);
    if (isProduction) {
      return { w2p: `https://w2p.${c}.esko.cloud`, iam: `https://iam.${c}.esko.cloud` };
    }
    // Dev/test clusters: cluster value IS the hostname (e.g. "future.dev.cloudi.city")
    return { w2p: `https://w2p.${c}`, iam: `https://iam.${c}` };
  }
  const { w2p: w2pBase, iam: iamBase } = buildBaseUrls(cluster);

  // Handle token stored as JSON object (e.g. {"token":"abc...","name":"..."}) or plain string
  try {
    const parsed = JSON.parse(token);
    if (parsed.token) token = parsed.token;
  } catch {}
  const wcpHeaders = {
    'EskoCloud-Token': token,
    'Accept': 'application/json',
    'User-Agent': 'PaulLand-MIS/1.0',
  };

  const subPath = path.replace('mis/', '');

  // GET routes
  if (request.method === 'GET') {
    if (subPath === 'customers') {
      // Get partners — try without filter first to get all, then with Customers filter
      // Some accounts categorize partners differently (Customers, Suppliers, Other Partners)
      const filterValue = new URL(request.url).searchParams.get('filter') || '';
      const filterParam = filterValue ? `&filterType=partnerType&filterValue=${filterValue}` : '';
      let resp = await fetch(
        `${iamBase}/iam/organizations/${WCP_ECAN}/partners?start=0&length=100&sortType=partnerName${filterParam}`,
        { headers: wcpHeaders }
      );
      if (!resp.ok) {
        resp = await fetch(
          `${iamBase}/rest/iam/organizations/${WCP_ECAN}/partners?start=0&length=100&sortType=partnerName${filterParam}`,
          { headers: wcpHeaders }
        );
      }
      const body = await resp.text();
      return new Response(body, { status: resp.status, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
    }

    if (subPath === 'task-templates') {
      const resp = await fetch(
        `${w2pBase}/api/v1/${WCP_REPOID}/Home/tasktemplates`,
        { headers: wcpHeaders }
      );
      return new Response(resp.body, { status: resp.status, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
    }

    if (subPath === 'product-templates') {
      const resp = await fetch(
        `${w2pBase}/PACKPRODUCTEMPLATE/v0/${WCP_REPOID}/Home/getallproducttemplates`,
        { headers: wcpHeaders }
      );
      return new Response(resp.body, { status: resp.status, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
    }

    if (subPath === 'preflight-profiles') {
      const resp = await fetch(
        `${w2pBase}/api/v0/${WCP_ECAN}/preflightprofiles`,
        { headers: wcpHeaders }
      );
      return new Response(resp.body, { status: resp.status, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
    }

    if (subPath.startsWith('job-details/')) {
      const jobId = subPath.replace('job-details/', '');
      const resp = await fetch(
        `${w2pBase}/api/v0/${WCP_ECAN}/getJobDetails/${encodeURIComponent(jobId)}`,
        { headers: wcpHeaders }
      );
      return new Response(resp.body, { status: resp.status, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
    }

    if (subPath === 'config') {
      // Return non-sensitive config info for the frontend
      return json({ region, ecan: WCP_ECAN ? WCP_ECAN.slice(0, 6) + '...' : null, repoId: WCP_REPOID ? WCP_REPOID.slice(0, 6) + '...' : null, configured: !!WCP_EQUIPMENT_TOKEN });
    }

    if (subPath === 'debug') {
      // Debug endpoint: test WCP connectivity with multiple token formats and endpoints
      const rawToken = WCP_EQUIPMENT_TOKEN || '';
      const rawPreview = rawToken ? rawToken.slice(0, 12) + '...' + rawToken.slice(-6) : 'NOT SET';

      // Build list of token candidates to try
      const candidates = [];
      // 1. Raw value as-is
      candidates.push({ label: 'raw', value: rawToken });
      // 2. If JSON, extract known keys
      try {
        const parsed = JSON.parse(rawToken);
        for (const key of ['token', 'jwt', 'accessToken', 'access_token', 'equipment_token']) {
          if (parsed[key]) candidates.push({ label: `json.${key}`, value: parsed[key] });
        }
        // Also try the full JSON string as the token value
        candidates.push({ label: 'json_string', value: rawToken });
      } catch {}

      // Dedupe
      const seen = new Set();
      const uniqueCandidates = candidates.filter(c => {
        if (seen.has(c.value)) return false;
        seen.add(c.value);
        return true;
      });

      // Test endpoints
      const testEndpoints = [
        { label: 'task-templates (w2p)', url: `${w2pBase}/api/v1/${WCP_REPOID}/Home/tasktemplates` },
        { label: 'customers (iam /iam/)', url: `${iamBase}/iam/organizations/${WCP_ECAN}/partners?start=0&length=10&sortType=partnerName&filterValue=Customers` },
        { label: 'customers (iam /rest/iam/)', url: `${iamBase}/rest/iam/organizations/${WCP_ECAN}/partners?start=0&length=10&sortType=partnerName&filterValue=Customers` },
        { label: 'preflight (w2p)', url: `${w2pBase}/api/v0/${WCP_ECAN}/preflightprofiles` },
      ];

      // Test each candidate against the first endpoint to find the right token
      const tokenTests = [];
      for (const cand of uniqueCandidates) {
        try {
          const resp = await fetch(testEndpoints[0].url, {
            headers: { 'EskoCloud-Token': cand.value, 'Accept': 'application/json', 'User-Agent': 'PaulLand-MIS/1.0' }
          });
          const body = await resp.text();
          tokenTests.push({
            label: cand.label,
            preview: cand.value.slice(0, 12) + '...' + cand.value.slice(-6),
            length: cand.value.length,
            status: resp.status,
            statusText: resp.statusText,
            bodyPreview: body.slice(0, 200),
          });
        } catch (e) {
          tokenTests.push({ label: cand.label, error: e.message });
        }
      }

      // Find best token (first non-403)
      const bestToken = tokenTests.find(t => t.status && t.status !== 403);

      // If we found a working token, test all endpoints with it
      let endpointTests = [];
      const testTokenValue = bestToken
        ? uniqueCandidates.find(c => c.label === bestToken.label)?.value
        : token;
      for (const ep of testEndpoints) {
        try {
          const resp = await fetch(ep.url, {
            headers: { 'EskoCloud-Token': testTokenValue, 'Accept': 'application/json', 'User-Agent': 'PaulLand-MIS/1.0' }
          });
          const body = await resp.text();
          endpointTests.push({
            label: ep.label,
            url: ep.url,
            status: resp.status,
            bodyPreview: body.slice(0, 300),
          });
        } catch (e) {
          endpointTests.push({ label: ep.label, url: ep.url, error: e.message });
        }
      }

      // Show the exact headers that would be sent
      const exactHeadersSent = {
        'EskoCloud-Token': testTokenValue ? testTokenValue.slice(0, 20) + '...' + testTokenValue.slice(-10) : 'NOT SET',
        'EskoCloud-Token-full-length': testTokenValue?.length,
        'Accept': 'application/json',
      };

      return json({
        config: { region, ecan: WCP_ECAN, repoId: WCP_REPOID, rawTokenPreview: rawPreview, rawTokenLength: rawToken.length },
        exactHeadersSent,
        tokenTests,
        bestToken: bestToken ? bestToken.label : 'none (all 403)',
        endpointTests,
      });
    }
  }

  // PUT routes
  if (request.method === 'PUT') {
    if (subPath === 'create-job') {
      const body = await request.text();
      const targetUrl = `${w2pBase}/api/v0/${WCP_ECAN}/createjob`;
      const resp = await fetch(targetUrl, {
        method: 'PUT',
        headers: { ...wcpHeaders, 'Content-Type': 'application/json' },
        body,
      });
      const respBody = await resp.text();
      // Wrap response with debug info if error
      if (!resp.ok) {
        const debug = {
          error: `Job-Node creation failed: ${respBody}`,
          _debug: {
            targetUrl,
            cluster,
            ecan: WCP_ECAN,
            repoId: WCP_REPOID,
            payloadPreview: body.slice(0, 500),
            responseStatus: resp.status,
          }
        };
        return json(debug, resp.status);
      }
      return new Response(respBody, { status: resp.status, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
    }
  }

  // POST routes
  if (request.method === 'POST') {
    if (subPath === 'edit-job') {
      const { jobId, ...payload } = await request.json();
      if (!jobId) return json({ error: 'jobId is required' }, 400);
      const resp = await fetch(
        `${w2pBase}/api/v0/${WCP_REPOID}/${encodeURIComponent(jobId)}/editjob`,
        { method: 'POST', headers: { ...wcpHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
      );
      return new Response(resp.body, { status: resp.status, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
    }
  }

  return json({ error: 'MIS route not found', subPath, method: request.method }, 404);
}

// ─── Handlers ────────────────────────────────────────────────

async function handleUpdateTags(request, env, ctx) {
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

  // Background embed
  if (id && (env.AI || env.CF_ACCOUNT_ID)) {
    ctx.waitUntil(embedItem(env, 'content', id).catch(() => {}));
  }

  return json({ ok: true, tags: cleanTags });
}

async function handleEntityUpdate(request, env, ctx) {
  const { table, id, updates } = await request.json();

  const allowedTables = ['people', 'products', 'projects', 'summaries', 'assets', 'companies', 'content', 'feed_items'];
  if (!table || !allowedTables.includes(table)) {
    return json({ error: 'Invalid table. Must be one of: ' + allowedTables.join(', ') }, 400);
  }
  if (!id) {
    return json({ error: 'Missing id' }, 400);
  }
  if (!updates || typeof updates !== 'object') {
    return json({ error: 'Missing updates object' }, 400);
  }

  const supabaseUrl = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !serviceKey) {
    return json({ error: 'Server misconfigured' }, 500);
  }

  const res = await fetch(
    `${supabaseUrl}/rest/v1/${table}?id=eq.${id}`,
    {
      method: 'PATCH',
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify(updates),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    return json({ error: 'Supabase error', detail: text }, res.status);
  }

  // Background embed (for embeddable entity tables)
  const embeddableTables = ['people', 'products', 'projects', 'summaries', 'companies'];
  if (embeddableTables.includes(table) && id && (env.AI || env.CF_ACCOUNT_ID)) {
    ctx.waitUntil(embedItem(env, table, id).catch(() => {}));
  }

  return json({ ok: true });
}

async function handleEntityLog(request, env, ctx) {
  const { table, data, returnRow } = await request.json();

  const allowedTables = ['people_log', 'project_updates', 'companies', 'product_content', 'product_assets', 'company_content', 'content'];
  if (!table || !allowedTables.includes(table)) {
    return json({ error: 'Invalid table. Must be one of: ' + allowedTables.join(', ') }, 400);
  }
  if (!data || typeof data !== 'object') {
    return json({ error: 'Missing data object' }, 400);
  }

  const supabaseUrl = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !serviceKey) {
    return json({ error: 'Server misconfigured' }, 500);
  }

  const res = await fetch(
    `${supabaseUrl}/rest/v1/${table}`,
    {
      method: 'POST',
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        'Prefer': returnRow ? 'return=representation' : 'return=minimal',
      },
      body: JSON.stringify(data),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    return json({ error: 'Supabase error', detail: text }, res.status);
  }

  if (returnRow) {
    const rows = await res.json();
    return json({ ok: true, row: rows[0] || null });
  }

  return json({ ok: true });
}

async function handleProductUnlink(request, env) {
  const url = new URL(request.url);
  const table = url.searchParams.get('table');
  const id = url.searchParams.get('id');

  const allowedTables = ['product_content', 'product_assets', 'company_content'];
  if (!table || !allowedTables.includes(table)) {
    return json({ error: 'Invalid table. Must be product_content, product_assets, or company_content' }, 400);
  }
  if (!id) {
    return json({ error: 'Missing id' }, 400);
  }

  const supabaseUrl = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_KEY;

  const res = await fetch(
    `${supabaseUrl}/rest/v1/${table}?id=eq.${id}`,
    {
      method: 'DELETE',
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Prefer': 'return=minimal',
      },
    }
  );

  if (!res.ok) {
    const text = await res.text();
    return json({ error: 'Supabase error', detail: text }, res.status);
  }

  return json({ ok: true });
}

async function handleUpsertDailyNote(request, env, ctx) {
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

  // Background embed
  if (data[0]?.id && (env.AI || env.CF_ACCOUNT_ID)) {
    ctx.waitUntil(embedItem(env, 'daily_notes', data[0].id).catch(() => {}));
  }

  return json({ ok: true, daily_note: data[0] });
}

// ─── AI Summary Generation ───────────────────────────────────

async function handleGenerateSummary(request, env, ctx) {
  const { type, period_start, period_end, context_data } = await request.json();

  if (!type || !['weekly', 'monthly'].includes(type)) {
    return json({ error: 'type must be "weekly" or "monthly"' }, 400);
  }
  if (!period_start || !period_end) {
    return json({ error: 'Missing period_start or period_end' }, 400);
  }
  if (!context_data || typeof context_data !== 'string' || context_data.length < 50) {
    return json({ error: 'context_data must be a substantial text string' }, 400);
  }

  const supabaseUrl = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_KEY;
  const anthropicKey = env.ANTHROPIC_API_KEY;

  if (!supabaseUrl || !serviceKey) {
    return json({ error: 'Server misconfigured (Supabase)' }, 500);
  }
  if (!anthropicKey) {
    return json({ error: 'ANTHROPIC_API_KEY not configured' }, 500);
  }

  const systemPrompt = type === 'weekly'
    ? buildWeeklySummaryPrompt()
    : buildMonthlySummaryPrompt();

  // Call Claude API
  let summaryContent;
  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 8000,
        system: systemPrompt,
        messages: [{ role: 'user', content: context_data }],
      }),
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      return json({ error: 'Claude API error', status: claudeRes.status, detail: errText }, 502);
    }

    const claudeData = await claudeRes.json();
    summaryContent = claudeData.content?.[0]?.text || '';

    if (!summaryContent) {
      return json({ error: 'Empty response from Claude' }, 500);
    }
  } catch (err) {
    return json({ error: 'AI processing failed', detail: err.message }, 500);
  }

  // Upsert to summaries table
  const summaryData = {
    type,
    period_start,
    period_end,
    content: summaryContent,
    metadata: {
      generated_at: new Date().toISOString(),
      model: 'claude-sonnet-4-20250514',
      context_length: context_data.length,
    },
  };

  const upsertRes = await fetch(
    `${supabaseUrl}/rest/v1/summaries?on_conflict=type,period_start`,
    {
      method: 'POST',
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=representation',
      },
      body: JSON.stringify(summaryData),
    }
  );

  if (!upsertRes.ok) {
    const errText = await upsertRes.text();
    return json({ error: 'Failed to save summary', detail: errText }, 500);
  }

  const saved = await upsertRes.json();

  // Create audit record (best-effort, don't fail the request)
  try {
    await supabasePost(supabaseUrl, serviceKey, 'ai_reviews', {
      review_type: type,
      source_date: period_start,
      status: 'completed',
      input_snapshot: { period_start, period_end, context_length: context_data.length },
      output_summary: summaryContent.substring(0, 500),
      completed_at: new Date().toISOString(),
    });
  } catch (e) { /* audit is non-critical */ }

  // Background embed the new summary
  if (saved[0]?.id && (env.AI || env.CF_ACCOUNT_ID)) {
    ctx.waitUntil(embedItem(env, 'summaries', saved[0].id).catch(() => {}));
  }

  return json({ ok: true, summary: saved[0] || summaryData });
}

function buildWeeklySummaryPrompt() {
  return `You are Paul Land's weekly review assistant. Paul is a Domain Lead (Packaging Job Lifecycle) and Product Manager (WebCenter Pack) at Esko.

Your job is to synthesise his week's daily notes, entity data, and AI daily review summaries into a comprehensive weekly summary written in **markdown**.

Write the summary as a coach and peer — direct but fair, acknowledging what worked, challenging assumptions, and asking coaching questions where appropriate.

## Output Sections (use these exact headings)

### Highlights
3-4 key accomplishments or significant events of the week. Bold the most impactful.

### Meetings & Interactions
Organised by day (Monday through Friday). For each day, list key meetings with attendees and outcomes. Include a **Customer Interactions** subsection if relevant.

### Domain Work (Packaging Job Lifecycle)
Strategic and operational progress on the domain. Include health indicators where evident.

### Product Work (WebCenter Pack)
Product delivery, decisions, customer feedback, and roadmap progress.

### Decisions Made
A markdown table with columns: Date | Decision | Context | Impact

### Blockers & Risks
Current blockers and emerging risks. Flag anything unresolved from previous weeks.

### Learnings
Key things learned this week — technical, strategic, or interpersonal.

### Tasks Completed
Summary of completed tasks. Group by theme if many.

### Leadership & Development
- **Reflection Summary**: Themes from daily reflections
- **Team Coaching**: Observations about direct reports and team dynamics
- **Coach's Check-in**: 2-3 coaching questions for Paul to consider

### Carry Forward
Open tasks and commitments that need attention next week.

### Next Week Focus
1-3 priorities for the coming week based on this week's outcomes.

## Guidelines
- Write in third person ("Paul" not "you") for the factual sections
- Use second person ("you") only in the Coach's Check-in
- Be concise but thorough — this replaces reading all the daily notes
- Include specific names, dates, and outcomes where available
- If data is sparse for a section, note it briefly rather than padding
- Output ONLY the markdown content — no preamble or wrapper`;
}

function buildMonthlySummaryPrompt() {
  return `You are Paul Land's monthly review assistant. Paul is a Domain Lead (Packaging Job Lifecycle) and Product Manager (WebCenter Pack) at Esko.

Your job is to synthesise weekly summaries (or daily notes if weeklies aren't available) into a strategic monthly review written in **markdown**.

Write with a coaching lens — direct, fair, and forward-looking.

## Output Sections (use these exact headings)

### Month at a Glance
4-5 bullet narrative of the month's key themes. Bold the most significant. This should read as an executive summary.

### Strategic Progress
Split into **Domain (Packaging Job Lifecycle)** and **Product (WebCenter Pack)** subsections. Include:
- Health status and trends (improving/stable/declining)
- Key milestones reached
- Strategic decisions and their implications

### Key Decisions
A markdown table with columns: Date | Decision | Impact | Stakeholders

### Patterns & Observations
Recurring themes, blockers that persisted across weeks, learning patterns, and behaviour trends.

### Customer & Stakeholder Pulse
Customer interactions, feedback themes, escalations, and relationship health.

### Team & People
Development focus for direct reports, team dynamics, delegation progress, and coaching observations.

### Leadership Development Review
- **Reflection Themes**: Patterns from weekly reflections
- **Experiments**: What was tried differently this month
- **Coaching Perspective**: 3-4 strategic coaching questions for the month ahead

### Next Month Focus
Top priorities and strategic intentions for the coming month.

## Guidelines
- Write in third person ("Paul") for factual sections
- Use second person ("you") only in Coaching Perspective
- Synthesise and elevate — don't just concatenate weekly summaries
- Highlight trends and patterns over individual events
- Be honest about gaps or areas lacking progress
- Output ONLY the markdown content — no preamble or wrapper`;
}

// ─── AI Daily Review ─────────────────────────────────────────

async function handleDailyReview(request, env, ctx) {
  const { note_date } = await request.json();

  if (!note_date || !/^\d{4}-\d{2}-\d{2}$/.test(note_date)) {
    return json({ error: 'Invalid or missing note_date' }, 400);
  }

  const supabaseUrl = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_KEY;
  const anthropicKey = env.ANTHROPIC_API_KEY;

  if (!supabaseUrl || !serviceKey) {
    return json({ error: 'Server misconfigured (Supabase)' }, 500);
  }
  if (!anthropicKey) {
    return json({ error: 'ANTHROPIC_API_KEY not configured' }, 500);
  }

  // 1. Fetch the daily note
  const noteRes = await supabaseGet(supabaseUrl, serviceKey,
    `daily_notes?note_date=eq.${note_date}&limit=1`);
  if (!noteRes.length) {
    return json({ error: 'No daily note found for this date' }, 404);
  }
  const dailyNote = noteRes[0];

  // 2. Fetch context: people, products, projects
  const [peopleRes, productsRes, projectsRes] = await Promise.all([
    supabaseGet(supabaseUrl, serviceKey, 'people?select=id,name,role,organization&order=name'),
    supabaseGet(supabaseUrl, serviceKey, 'products?select=id,name&order=name'),
    supabaseGet(supabaseUrl, serviceKey, 'projects?select=id,name,product_id&order=name'),
  ]);

  const peopleNames = peopleRes.map(p => p.name);
  const productNames = productsRes.map(p => p.name);
  const projectNames = projectsRes.map(p => p.name);

  // 3. Build the prompt
  const systemPrompt = buildReviewSystemPrompt(peopleNames, productNames, projectNames);
  const userPrompt = buildReviewUserPrompt(dailyNote, note_date);

  // 4. Call Claude API
  let aiResult;
  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 8000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      return json({ error: 'Claude API error', status: claudeRes.status, detail: errText }, 502);
    }

    const claudeData = await claudeRes.json();
    const responseText = claudeData.content?.[0]?.text || '';

    // Extract JSON from response (may be wrapped in ```json blocks)
    const jsonMatch = responseText.match(/```json\s*([\s\S]*?)```/) ||
                      responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return json({ error: 'Could not parse AI response', raw: responseText.substring(0, 2000) }, 500);
    }

    aiResult = JSON.parse(jsonMatch[1] || jsonMatch[0]);
  } catch (err) {
    return json({ error: 'AI processing failed', detail: err.message }, 500);
  }

  // 5. Write results to Supabase
  const writeResults = await writeReviewResults(supabaseUrl, serviceKey, note_date, dailyNote, aiResult, peopleRes, productsRes, projectsRes);

  // 6. Create audit record
  await supabasePost(supabaseUrl, serviceKey, 'ai_reviews', {
    review_type: 'daily',
    source_date: note_date,
    status: 'completed',
    input_snapshot: { tasks: dailyNote.tasks, notes: dailyNote.notes, meetings: dailyNote.meetings },
    output_summary: aiResult.review_summary || '',
    files_updated: writeResults,
    completed_at: new Date().toISOString(),
  });

  // 7. Update daily note metadata with review results (store full review for persistence)
  const existingMeta = dailyNote.metadata || {};
  await supabasePatch(supabaseUrl, serviceKey,
    `daily_notes?note_date=eq.${note_date}`, {
      metadata: {
        ...existingMeta,
        last_reviewed: new Date().toISOString(),
        review_summary: aiResult.review_summary || '',
        migrated_tasks: aiResult.migrated_tasks || [],
        context_notes: aiResult.context_notes || [],
        review_data: aiResult,
        review_writes: writeResults,
      },
    });

  // 8. Migrate tasks to next day
  let tasksMigrated = 0;
  const migratedTasks = aiResult.migrated_tasks || [];
  if (migratedTasks.length > 0) {
    // Calculate next day
    const d = new Date(note_date + 'T12:00:00Z');
    d.setDate(d.getDate() + 1);
    const nextDate = d.toISOString().split('T')[0];

    // Fetch existing next-day note (if any)
    const nextNotes = await supabaseGet(supabaseUrl, serviceKey,
      `daily_notes?note_date=eq.${nextDate}&limit=1`);
    const nextNote = nextNotes.length ? nextNotes[0] : null;

    // Build migrated tasks markdown
    const migratedMd = migratedTasks.map(t => `- [ ] ${t}`).join('\n');
    const header = `## Tasks (migrated from ${note_date})\n`;

    let newTasks = '';
    if (nextNote && nextNote.tasks && nextNote.tasks.trim()) {
      // Append migrated tasks to existing tasks (avoid duplicates)
      const existingLower = nextNote.tasks.toLowerCase();
      const uniqueTasks = migratedTasks.filter(t =>
        !existingLower.includes(t.toLowerCase().substring(0, 30))
      );
      if (uniqueTasks.length > 0) {
        const uniqueMd = uniqueTasks.map(t => `- [ ] ${t}`).join('\n');
        newTasks = nextNote.tasks + '\n\n' + header + uniqueMd;
        tasksMigrated = uniqueTasks.length;
      }
    } else {
      // Create new tasks section
      newTasks = header + migratedMd;
      tasksMigrated = migratedTasks.length;
    }

    if (tasksMigrated > 0) {
      // Upsert next day's note with migrated tasks
      const upsertBody = {
        note_date: nextDate,
        tasks: newTasks,
        notes: nextNote?.notes || '',
        meetings: nextNote?.meetings || '',
      };

      await fetch(
        `${supabaseUrl}/rest/v1/daily_notes?on_conflict=note_date`,
        {
          method: 'POST',
          headers: {
            'apikey': serviceKey,
            'Authorization': `Bearer ${serviceKey}`,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates,return=minimal',
          },
          body: JSON.stringify(upsertBody),
        }
      );
    }

    // 9. Mark migrated tasks as [>] on the source day
    let updatedTasks = dailyNote.tasks || '';
    for (const task of migratedTasks) {
      // Find the task line with [ ] and change to [>]
      // Match on the first 40 chars of the task text to handle slight variations
      const searchText = task.substring(0, Math.min(40, task.length)).toLowerCase();
      const lines = updatedTasks.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes('- [ ]') && line.toLowerCase().includes(searchText)) {
          lines[i] = line.replace('- [ ]', '- [>]');
          break;
        }
      }
      updatedTasks = lines.join('\n');
    }

    // Update the source day's tasks
    if (updatedTasks !== dailyNote.tasks) {
      await supabasePatch(supabaseUrl, serviceKey,
        `daily_notes?note_date=eq.${note_date}`, {
          tasks: updatedTasks,
        });
    }
  }

  // Background re-embed the daily note (now has review_summary)
  if (dailyNote.id && (env.AI || env.CF_ACCOUNT_ID)) {
    ctx.waitUntil(embedItem(env, 'daily_notes', dailyNote.id).catch(() => {}));
  }

  return json({
    ok: true,
    review: aiResult,
    writes: { ...writeResults, tasks_migrated: tasksMigrated },
  });
}

function buildReviewSystemPrompt(peopleNames, productNames, projectNames) {
  return `You are Paul Land's end-of-day review assistant. Paul is a Domain Lead (Packaging Job Lifecycle) and Product Manager (WebCenter Pack) at Esko.

Your job is to process his daily note and extract structured information into a JSON response. You must identify:

1. **People entries**: Notes about specific people from meetings and notes sections ONLY. Do NOT extract people entries from tasks — tasks are action items, not observations. Only extract people entries when there is a genuine observation, decision, or insight about that person from a meeting or note.
2. **Product evidence**: Evidence, learnings, or feedback about specific products.
3. **Product decisions**: Decisions made about products (strategic, not tactical).
4. **Project updates**: Updates about specific projects.
5. **Reflections**: Leadership observations, coaching insights, self-awareness moments.
6. **Migrated tasks**: Tasks marked [>] or still open [ ] that should carry forward to tomorrow.
7. **Context notes**: Key context from today that would help prepare for tomorrow's meetings.

## Known People
${peopleNames.join(', ')}

## Known Products
${productNames.join(', ')}

## Known Projects
${projectNames.join(', ')}

## Task Notation
- \`[ ]\` = open (not done)
- \`[x]\` = done
- \`[>]\` = migrated (carry forward)
- \`[-]\` = cancelled

## Reflection Detection
Look for reflective language: "I noticed", "I should have", "lesson learned", "in hindsight", "next time", coaching observations about team members, leadership moments, and self-awareness. Paul writes naturally without tags — you must identify reflective content by reading comprehension.

For each reflection, write a brief coach's perspective: validate what worked, challenge assumptions, and ask 1-2 coaching questions. Be direct but fair — a peer-level coach, not a critic.

## Output Format
Respond with ONLY a JSON object (no markdown wrapping, no explanation) with this structure:

{
  "people_entries": [
    { "person_name": "Exact Name", "entry": "What was discussed/observed about this person" }
  ],
  "product_evidence": [
    { "product_name": "Exact Product", "evidence": "The evidence/learning", "evidence_type": "customer_feedback|metric|decision|observation" }
  ],
  "product_decisions": [
    { "product_name": "Exact Product", "decision": "The decision", "context": "Why/how it was decided" }
  ],
  "project_updates": [
    { "project_name": "Exact Project", "update": "What happened with this project today" }
  ],
  "reflections": [
    { "observation": "The reflection/insight", "coach_perspective": "Brief coaching response", "category": "leadership|coaching|personal" }
  ],
  "migrated_tasks": [
    "Task text to carry forward"
  ],
  "context_notes": [
    { "meeting_title": "Meeting name", "context": "Key context for tomorrow" }
  ],
  "review_summary": "2-3 sentence summary of the day's key outcomes and themes"
}

IMPORTANT:
- Only include entries where there is genuine content to extract. Empty arrays are fine.
- Match person/product/project names EXACTLY to the known lists above. If unsure, use the closest match.
- For people entries, focus on actionable notes: decisions, action items, observations about the person's work.
- Keep entries concise but complete. Each entry should stand on its own without needing the daily note for context.
- The review_summary should capture the day's themes, not list every meeting.
- CRITICAL: Do NOT create people entries from tasks. Tasks like "Follow up with X" or "Speak to Y about Z" are action items, not observations. People entries should ONLY come from actual meeting notes, conversations, or written observations.`;
}

function buildReviewUserPrompt(dailyNote, noteDate) {
  let prompt = `## Daily Note for ${noteDate}\n\n`;

  if (dailyNote.tasks) {
    prompt += `### Tasks\n${dailyNote.tasks}\n\n`;
  }
  if (dailyNote.notes) {
    prompt += `### Notes & Thoughts\n${dailyNote.notes}\n\n`;
  }
  if (dailyNote.meetings) {
    prompt += `### Meetings & Conversations\n${dailyNote.meetings}\n\n`;
  }

  // Include structured meeting data if available
  const structured = dailyNote.metadata?.meetings_structured;
  if (structured && structured.length > 0) {
    prompt += `### Meeting Details (structured)\n`;
    for (const m of structured) {
      prompt += `#### ${m.title || 'Untitled Meeting'}${m.time ? ` (${m.time})` : ''}\n`;
      prompt += `${m.notes || '(no notes)'}\n\n`;
    }
  }

  // Include stoic challenge if present
  const stoic = dailyNote.metadata?.stoic_challenge;
  if (stoic && (stoic.frustration || stoic.reframe || stoic.opportunity)) {
    prompt += `### Stoic Challenge\n`;
    if (stoic.frustration) prompt += `**Frustration:** ${stoic.frustration}\n`;
    if (stoic.reframe) prompt += `**Reframe:** ${stoic.reframe}\n`;
    if (stoic.opportunity) prompt += `**Opportunity:** ${stoic.opportunity}\n`;
    prompt += '\n';
  }

  prompt += `\nPlease process this daily note and extract all relevant information into the JSON format specified in your instructions.`;
  return prompt;
}

async function writeReviewResults(supabaseUrl, serviceKey, noteDate, dailyNote, aiResult, people, products, projects) {
  const results = { people_log: 0, product_evidence: 0, product_decisions: 0, project_updates: 0, reflections: 0 };

  // Build lookup maps
  const peopleMap = {};
  people.forEach(p => { peopleMap[p.name.toLowerCase()] = p.id; });
  const productMap = {};
  products.forEach(p => { productMap[p.name.toLowerCase()] = p.id; });
  const projectMap = {};
  projects.forEach(p => { projectMap[p.name.toLowerCase()] = p.id; });

  const sourceRef = { daily_note_date: noteDate };

  // Write people log entries
  for (const entry of (aiResult.people_entries || [])) {
    const personId = peopleMap[entry.person_name?.toLowerCase()];
    if (!personId || !entry.entry) continue;
    await supabasePost(supabaseUrl, serviceKey, 'people_log', {
      person_id: personId,
      note_date: noteDate,
      entry: entry.entry,
      source: 'daily_review',
      source_ref: sourceRef,
    });
    results.people_log++;
  }

  // Write product evidence
  for (const entry of (aiResult.product_evidence || [])) {
    const productId = productMap[entry.product_name?.toLowerCase()];
    if (!productId || !entry.evidence) continue;
    await supabasePost(supabaseUrl, serviceKey, 'product_evidence', {
      product_id: productId,
      note_date: noteDate,
      evidence: entry.evidence,
      evidence_type: entry.evidence_type || 'observation',
      source_ref: sourceRef,
    });
    results.product_evidence++;
  }

  // Write product decisions
  for (const entry of (aiResult.product_decisions || [])) {
    const productId = productMap[entry.product_name?.toLowerCase()];
    if (!entry.decision) continue;
    await supabasePost(supabaseUrl, serviceKey, 'product_decisions', {
      product_id: productId || null,
      note_date: noteDate,
      decision: entry.decision,
      context: entry.context || '',
      source_ref: sourceRef,
    });
    results.product_decisions++;
  }

  // Write project updates
  for (const entry of (aiResult.project_updates || [])) {
    const projectId = projectMap[entry.project_name?.toLowerCase()];
    if (!projectId || !entry.update) continue;
    await supabasePost(supabaseUrl, serviceKey, 'project_updates', {
      project_id: projectId,
      note_date: noteDate,
      update_text: entry.update,
      source_ref: sourceRef,
    });
    results.project_updates++;
  }

  // Write reflections
  for (const entry of (aiResult.reflections || [])) {
    if (!entry.observation) continue;
    // Try to match a person if the reflection is about someone
    let personId = null;
    if (entry.category === 'coaching') {
      for (const [name, id] of Object.entries(peopleMap)) {
        if (entry.observation.toLowerCase().includes(name)) {
          personId = id;
          break;
        }
      }
    }
    await supabasePost(supabaseUrl, serviceKey, 'reflections_log', {
      note_date: noteDate,
      observation: entry.observation,
      coach_perspective: entry.coach_perspective || '',
      category: entry.category || 'leadership',
      person_id: personId,
      source_ref: sourceRef,
    });
    results.reflections++;
  }

  return results;
}

// ─── Asset Management (R2 + Supabase) ────────────────────────

async function handleR2List(env) {
  const bucket = env.ASSETS_BUCKET;
  if (!bucket) return json({ error: 'R2 bucket not configured' }, 500);

  const listed = await bucket.list({ limit: 500 });
  const objects = (listed.objects || []).map(obj => ({
    key: obj.key,
    size: obj.size,
    uploaded: obj.uploaded,
    httpMetadata: obj.httpMetadata,
    customMetadata: obj.customMetadata,
  }));

  return json({ ok: true, objects, truncated: listed.truncated });
}

async function handleAssetUpload(request, env) {
  const bucket = env.ASSETS_BUCKET;
  if (!bucket) return json({ error: 'R2 bucket not configured' }, 500);

  const supabaseUrl = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_KEY;

  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('multipart/form-data')) {
    return json({ error: 'Expected multipart/form-data' }, 400);
  }

  const formData = await request.formData();
  const file = formData.get('file');
  if (!file || !(file instanceof File)) {
    return json({ error: 'No file provided' }, 400);
  }

  const tags = formData.get('tags') || '';
  const description = formData.get('description') || '';
  const productId = formData.get('product_id') || null;

  // Generate a unique R2 key: YYYY/MM/uuid-filename
  const now = new Date();
  const prefix = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}`;
  const uuid = crypto.randomUUID();
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const r2Key = `${prefix}/${uuid}-${safeName}`;

  // Upload to R2
  const arrayBuffer = await file.arrayBuffer();
  await bucket.put(r2Key, arrayBuffer, {
    httpMetadata: { contentType: file.type },
    customMetadata: { originalName: file.name },
  });

  // Store metadata in Supabase
  const tagArray = tags ? tags.split(',').map(t => t.trim()).filter(Boolean) : [];
  const assetData = {
    filename: file.name,
    r2_key: r2Key,
    mime_type: file.type || 'application/octet-stream',
    file_size: file.size,
    tags: tagArray,
    description: description,
    uploaded_at: now.toISOString(),
    metadata: {},
  };

  const insertRes = await fetch(`${supabaseUrl}/rest/v1/assets`, {
    method: 'POST',
    headers: {
      'apikey': serviceKey,
      'Authorization': `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    },
    body: JSON.stringify(assetData),
  });

  if (!insertRes.ok) {
    const err = await insertRes.text();
    // Clean up R2 on metadata failure
    await bucket.delete(r2Key);
    return json({ error: 'Failed to save asset metadata', detail: err }, 500);
  }

  const saved = await insertRes.json();
  const asset = saved[0];

  // If product_id provided, also link to product
  if (productId && asset?.id) {
    await fetch(`${supabaseUrl}/rest/v1/product_assets`, {
      method: 'POST',
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({ product_id: productId, asset_id: asset.id }),
    });
  }

  return json({ ok: true, asset });
}

async function handleAssetServe(r2Key, env) {
  const bucket = env.ASSETS_BUCKET;
  if (!bucket) return json({ error: 'R2 bucket not configured' }, 500);

  const object = await bucket.get(r2Key);
  if (!object) return json({ error: 'File not found' }, 404);

  const headers = new Headers();
  headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
  headers.set('Content-Length', object.size);
  headers.set('Cache-Control', 'private, max-age=3600');

  // For images and PDFs, display inline; others download
  const ct = object.httpMetadata?.contentType || '';
  if (ct.startsWith('image/') || ct === 'application/pdf') {
    headers.set('Content-Disposition', 'inline');
  } else {
    const name = object.customMetadata?.originalName || r2Key.split('/').pop();
    headers.set('Content-Disposition', `attachment; filename="${name}"`);
  }

  return new Response(object.body, { headers });
}

async function handleAssetDelete(assetId, env) {
  const bucket = env.ASSETS_BUCKET;
  if (!bucket) return json({ error: 'R2 bucket not configured' }, 500);

  const supabaseUrl = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_KEY;

  // Fetch the asset to get the R2 key
  const assets = await supabaseGet(supabaseUrl, serviceKey, `assets?id=eq.${assetId}&select=id,r2_key`);
  if (!assets.length) return json({ error: 'Asset not found' }, 404);

  const r2Key = assets[0].r2_key;

  // Delete from R2
  await bucket.delete(r2Key);

  // Delete from Supabase
  await fetch(`${supabaseUrl}/rest/v1/assets?id=eq.${assetId}`, {
    method: 'DELETE',
    headers: {
      'apikey': serviceKey,
      'Authorization': `Bearer ${serviceKey}`,
    },
  });

  return json({ ok: true });
}

// ─── Vector Embedding & RAG ──────────────────────────────────

/**
 * Build the text representation to embed for a given source table + row.
 */
function buildEmbeddingText(sourceTable, row) {
  switch (sourceTable) {
    case 'content': {
      const prefix = row.type === 'article' ? 'Article' :
                     row.type === 'thought' ? 'Thought' :
                     row.type === 'signal' ? 'Signal' : 'Reflection';
      const parts = [`${prefix}: ${row.title || 'Untitled'}`];
      if (row.body) parts.push(row.body);
      if (row.tags?.length) parts.push(`Tags: ${row.tags.join(', ')}`);
      return parts.join('\n');
    }
    case 'daily_notes': {
      const summary = row.metadata?.review_summary;
      if (summary) {
        return `Daily Note ${row.note_date}:\n${summary}`;
      }
      // Fall back to raw content
      const parts = [`Daily Note ${row.note_date}:`];
      if (row.tasks) parts.push(`Tasks:\n${row.tasks}`);
      if (row.notes) parts.push(`Notes:\n${row.notes}`);
      if (row.meetings) parts.push(`Meetings:\n${row.meetings}`);
      return parts.join('\n').substring(0, 4000);
    }
    case 'summaries':
      return `${row.type} Summary (${row.period_start} to ${row.period_end}):\n${row.content || ''}`;
    case 'people': {
      const parts = [`Person: ${row.name}`];
      if (row.role) parts.push(`Role: ${row.role}`);
      if (row.organization) parts.push(`Organization: ${row.organization}`);
      if (row.tags?.length) parts.push(`Tags: ${row.tags.join(', ')}`);
      return parts.join('\n');
    }
    case 'companies': {
      const parts = [`Company: ${row.name}`];
      if (row.type) parts.push(`Type: ${row.type}`);
      if (row.industry) parts.push(`Industry: ${row.industry}`);
      if (row.notes) parts.push(row.notes);
      if (row.tags?.length) parts.push(`Tags: ${row.tags.join(', ')}`);
      return parts.join('\n');
    }
    case 'products': {
      const parts = [`Product: ${row.name}`];
      if (row.overview) parts.push(row.overview);
      if (row.description) parts.push(row.description);
      if (row.tags?.length) parts.push(`Tags: ${row.tags.join(', ')}`);
      return parts.join('\n');
    }
    case 'projects': {
      const parts = [`Project: ${row.name}`];
      if (row.status) parts.push(`Status: ${row.status}`);
      if (row.description) parts.push(row.description);
      if (row.tags?.length) parts.push(`Tags: ${row.tags.join(', ')}`);
      return parts.join('\n');
    }
    case 'people_log':
      return `People Note (${row.note_date}): ${row.entry || ''}`;
    case 'product_evidence':
      return `Product Evidence (${row.note_date}, ${row.evidence_type || 'observation'}): ${row.evidence || ''}`;
    case 'product_decisions':
      return `Decision (${row.note_date}): ${row.decision || ''}\nContext: ${row.context || ''}`;
    case 'reflections_log':
      return `Reflection (${row.note_date}, ${row.category || 'leadership'}): ${row.observation || ''}\nCoach: ${row.coach_perspective || ''}`;
    default:
      return JSON.stringify(row);
  }
}

/**
 * Build metadata for an embedding row (for filtering & display).
 */
function buildEmbeddingMetadata(sourceTable, row) {
  const meta = { source_table: sourceTable };
  switch (sourceTable) {
    case 'content':
      meta.title = row.title || '';
      meta.type = row.type || '';
      meta.date = row.captured_at || '';
      break;
    case 'daily_notes':
      meta.title = `Daily Note ${row.note_date}`;
      meta.date = row.note_date;
      break;
    case 'summaries':
      meta.title = `${row.type} Summary (${row.period_start} to ${row.period_end})`;
      meta.type = row.type;
      meta.date = row.period_start;
      break;
    case 'people':
      meta.title = row.name || '';
      break;
    case 'companies':
      meta.title = row.name || '';
      meta.type = row.type || '';
      break;
    case 'products':
      meta.title = row.name || '';
      break;
    case 'projects':
      meta.title = row.name || '';
      meta.status = row.status || '';
      break;
    case 'people_log':
      meta.title = `People Note`;
      meta.date = row.note_date;
      break;
    case 'product_evidence':
      meta.title = `Product Evidence (${row.evidence_type || 'observation'})`;
      meta.date = row.note_date;
      break;
    case 'product_decisions':
      meta.title = `Product Decision`;
      meta.date = row.note_date;
      break;
    case 'reflections_log':
      meta.title = `Reflection (${row.category || 'leadership'})`;
      meta.date = row.note_date;
      break;
  }
  return meta;
}

/**
 * Chunk text into pieces of roughly maxChars, splitting on paragraph boundaries.
 * Returns array of { chunkIndex, text } objects.
 */
function chunkText(text, maxChars = 2000) {
  if (text.length <= maxChars) return [{ chunkIndex: 0, text }];

  // Extract first line as title prefix (reattach to each chunk)
  const firstNewline = text.indexOf('\n');
  const titlePrefix = firstNewline > 0 && firstNewline < 200 ? text.substring(0, firstNewline) : '';
  const body = titlePrefix ? text.substring(firstNewline + 1) : text;

  const paragraphs = body.split(/\n\n+/);
  const chunks = [];
  let current = titlePrefix;
  let idx = 0;

  for (const para of paragraphs) {
    if (current.length + para.length + 2 > maxChars && current.length > titlePrefix.length) {
      chunks.push({ chunkIndex: idx++, text: current.trim() });
      current = titlePrefix ? titlePrefix + '\n' + para : para;
    } else {
      current += (current ? '\n\n' : '') + para;
    }
  }
  if (current.trim()) {
    chunks.push({ chunkIndex: idx, text: current.trim() });
  }

  return chunks;
}

/**
 * Generate embeddings for an array of texts.
 * Tries Workers AI binding first, falls back to REST API.
 */
async function generateEmbeddings(env, texts) {
  // Try the AI binding first
  if (env.AI) {
    try {
      const result = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: texts });
      if (result?.data) return result.data;
    } catch (e) {
      // Binding failed, try REST API fallback
    }
  }

  // REST API fallback
  const accountId = env.CF_ACCOUNT_ID;
  const apiToken = env.CF_API_TOKEN;
  if (!accountId || !apiToken) {
    throw new Error('Workers AI not available. Set CF_ACCOUNT_ID and CF_API_TOKEN env vars, or configure [ai] binding.');
  }

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/baai/bge-base-en-v1.5`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: texts }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Workers AI REST API error (${res.status}): ${err}`);
  }

  const data = await res.json();
  if (!data.result?.data) throw new Error('Unexpected Workers AI response format');
  return data.result.data;
}

/**
 * Embed a single item: fetch row, build text, generate embeddings, upsert.
 */
async function embedItem(env, sourceTable, sourceId) {
  const supabaseUrl = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_KEY;

  // Fetch the source row
  const rows = await supabaseGet(supabaseUrl, serviceKey,
    `${sourceTable}?id=eq.${sourceId}&limit=1`);
  if (!rows.length) return { ok: false, error: 'Row not found' };
  const row = rows[0];

  // Build text to embed
  const fullText = buildEmbeddingText(sourceTable, row);
  if (!fullText || fullText.length < 10) return { ok: false, error: 'Insufficient text' };

  // Chunk if necessary
  const chunks = chunkText(fullText);
  const metadata = buildEmbeddingMetadata(sourceTable, row);

  // Generate embeddings via Workers AI
  const texts = chunks.map(c => c.text);
  let embeddings;
  try {
    embeddings = await generateEmbeddings(env, texts);
  } catch (err) {
    return { ok: false, error: `Embedding error: ${err.message}` };
  }

  if (!embeddings || embeddings.length !== chunks.length) {
    return { ok: false, error: 'Embedding count mismatch' };
  }

  // Delete existing embeddings for this source
  await fetch(
    `${supabaseUrl}/rest/v1/embeddings?source_table=eq.${sourceTable}&source_id=eq.${sourceId}`,
    {
      method: 'DELETE',
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
      },
    }
  );

  // Insert new embeddings
  const embeddingRows = chunks.map((chunk, i) => ({
    source_table: sourceTable,
    source_id: sourceId,
    chunk_index: chunk.chunkIndex,
    content_text: chunk.text,
    embedding: JSON.stringify(embeddings[i]),
    metadata,
  }));

  await fetch(`${supabaseUrl}/rest/v1/embeddings`, {
    method: 'POST',
    headers: {
      'apikey': serviceKey,
      'Authorization': `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(embeddingRows),
  });

  // Update embedded_at on the source row
  await supabasePatch(supabaseUrl, serviceKey,
    `${sourceTable}?id=eq.${sourceId}`,
    { embedded_at: new Date().toISOString() }
  );

  return { ok: true, chunks: chunks.length };
}

/**
 * POST /api/embed — Embed a single item.
 */
async function handleEmbed(request, env) {
  const { source_table, source_id } = await request.json();

  if (!source_table || !source_id) {
    return json({ error: 'Missing source_table or source_id' }, 400);
  }

  const result = await embedItem(env, source_table, source_id);
  if (!result.ok) {
    return json({ error: result.error }, 500);
  }
  return json({ ok: true, chunks: result.chunks });
}

/**
 * POST /api/embed-batch — Batch embed unembedded content across all tables.
 */
async function handleEmbedBatch(request, env) {
  try {
  const body = await request.json().catch(() => ({}));
  const requestedTables = body.tables || null;
  const startTime = Date.now();
  const TIMEOUT_MS = 25000; // Return before 30s Worker timeout

  const supabaseUrl = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_KEY;

  // Tables to embed and their ID columns
  const tableConfigs = [
    { table: 'content', idCol: 'id' },
    { table: 'daily_notes', idCol: 'id' },
    { table: 'summaries', idCol: 'id' },
    { table: 'people', idCol: 'id' },
    { table: 'companies', idCol: 'id' },
    { table: 'products', idCol: 'id' },
    { table: 'projects', idCol: 'id' },
    { table: 'people_log', idCol: 'id' },
    { table: 'product_evidence', idCol: 'id' },
    { table: 'product_decisions', idCol: 'id' },
    { table: 'reflections_log', idCol: 'id' },
  ];

  const MAX_ITEMS = 6; // ~5 subrequests each = ~30 + overhead, stays under 50 limit
  const results = {};
  let remaining = false;
  let totalProcessed = 0;

  for (const config of tableConfigs) {
    if (requestedTables && !requestedTables.includes(config.table)) continue;
    if (totalProcessed >= MAX_ITEMS) { remaining = true; break; }

    // Check timeout
    if (Date.now() - startTime > TIMEOUT_MS) {
      remaining = true;
      break;
    }

    // Fetch unembedded rows
    const limit = Math.min(MAX_ITEMS - totalProcessed, 6);
    const rows = await supabaseGet(supabaseUrl, serviceKey,
      `${config.table}?embedded_at=is.null&select=id&limit=${limit}`);

    if (!rows.length) {
      results[config.table] = 0;
      continue;
    }

    let count = 0;
    for (const row of rows) {
      if (totalProcessed >= MAX_ITEMS || Date.now() - startTime > TIMEOUT_MS) {
        remaining = true;
        break;
      }

      try {
        const result = await embedItem(env, config.table, row.id);
        if (result.ok) { count++; totalProcessed++; }
      } catch (e) {
        // Skip failures, continue with next
      }
    }

    results[config.table] = count;
    if (remaining) break;
  }

  // Check if there are more unembedded items across all tables
  if (!remaining) {
    for (const config of tableConfigs) {
      if (requestedTables && !requestedTables.includes(config.table)) continue;
      if (results[config.table] !== undefined) continue; // already checked
      const rows = await supabaseGet(supabaseUrl, serviceKey,
        `${config.table}?embedded_at=is.null&select=id&limit=1`);
      if (rows.length) { remaining = true; break; }
    }
  }

  return json({ ok: true, embedded: results, remaining, totalProcessed });
  } catch (err) {
    return json({ error: 'Embed batch failed: ' + err.message }, 500);
  }
}

/**
 * POST /api/feed-items/capture — Capture a feed item into the content table.
 */
async function handleFeedItemCapture(request, env) {
  try {
    const supabaseUrl = env.SUPABASE_URL;
    const serviceKey = env.SUPABASE_SERVICE_KEY;
    const { feed_item_id } = await request.json();
    if (!feed_item_id) {
      return json({ error: 'Missing feed_item_id' }, 400);
    }

    // Fetch the feed item
    const feedItems = await supabaseGet(supabaseUrl, serviceKey,
      `feed_items?select=*&id=eq.${feed_item_id}`);

    if (!feedItems || feedItems.length === 0) {
      return json({ error: 'Feed item not found' }, 404);
    }
    const feedItem = feedItems[0];

    if (feedItem.captured) {
      return json({ already_captured: true });
    }

    // Check if URL already exists in content (dedup)
    const existing = await supabaseGet(supabaseUrl, serviceKey,
      `content?select=id&url=eq.${encodeURIComponent(feedItem.item_url)}&limit=1`);

    if (existing && existing.length > 0) {
      // Mark captured
      await supabasePatch(supabaseUrl, serviceKey,
        `feed_items?id=eq.${feed_item_id}`, { captured: true });
      return json({ captured: true, deduplicated: true });
    }

    // Fetch the page and extract full article content
    let title = feedItem.item_title || 'Untitled';
    let description = feedItem.item_summary || '';
    let body = '';
    let extractedImage = null;
    let metadata = {
      feed_item_id: feedItem.id,
      source_app: 'reader',
    };

    try {
      const pageResp = await fetch(feedItem.item_url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
      });
      if (pageResp.ok) {
        const html = await pageResp.text();

        // Extract metadata from head
        const ogTitle = html.match(/<meta\s+(?:property|name)="og:title"\s+content="([^"]+)"/i);
        if (ogTitle) title = ogTitle[1];
        else {
          const htmlTitle = html.match(/<title[^>]*>([^<]+)<\/title>/i);
          if (htmlTitle) title = htmlTitle[1].trim();
        }
        const ogDesc = html.match(/<meta\s+(?:property|name)="og:description"\s+content="([^"]+)"/i);
        const metaDesc = html.match(/<meta\s+name="description"\s+content="([^"]+)"/i);
        if (ogDesc) description = ogDesc[1];
        else if (metaDesc) description = metaDesc[1];
        const ogImage = html.match(/<meta\s+(?:property|name)="og:image"\s+content="([^"]+)"/i);
        extractedImage = ogImage ? ogImage[1] : null;

        // Extract article content — try <article>, then role="main", then fallback to <main> or <body>
        let contentHtml = '';
        const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
        const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
        const roleMainMatch = html.match(/<[^>]+role="main"[^>]*>([\s\S]*?)<\/[^>]+>/i);
        const contentDivMatch = html.match(/<div[^>]+class="[^"]*(?:post-content|article-content|entry-content|post-body|article-body|story-body|content-body)[^"]*"[^>]*>([\s\S]*?)<\/div>/i);

        contentHtml = contentDivMatch?.[1] || articleMatch?.[1] || roleMainMatch?.[1] || mainMatch?.[1] || '';

        if (contentHtml) {
          // Convert HTML to markdown
          body = contentHtml
            // Headings
            .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n')
            .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n')
            .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n')
            .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n#### $1\n')
            .replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, '\n##### $1\n')
            .replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, '\n###### $1\n')
            // Paragraphs & breaks
            .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n$1\n')
            .replace(/<br\s*\/?>/gi, '\n')
            // Lists
            .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n')
            .replace(/<\/?[ou]l[^>]*>/gi, '\n')
            // Links & images
            .replace(/<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
            .replace(/<img[^>]+src="([^"]*)"[^>]*alt="([^"]*)"[^>]*\/?>/gi, '![$2]($1)')
            .replace(/<img[^>]+src="([^"]*)"[^>]*\/?>/gi, '![]($1)')
            // Formatting
            .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**')
            .replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**')
            .replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*')
            .replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, '*$1*')
            .replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, '\n> $1\n')
            .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
            .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n')
            // Remove script, style, nav, footer, aside tags entirely
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
            .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
            .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, '')
            // Remove remaining HTML tags
            .replace(/<[^>]+>/g, '')
            // Decode entities
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
            .replace(/&rsquo;/g, "'").replace(/&lsquo;/g, "'")
            .replace(/&rdquo;/g, '"').replace(/&ldquo;/g, '"')
            .replace(/&mdash;/g, '—').replace(/&ndash;/g, '–')
            .replace(/&hellip;/g, '…')
            // Clean up whitespace
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        }
      }
    } catch (e) {
      // Extraction failed — use feed item data as fallback
    }

    metadata.description = description;
    metadata.image_url = extractedImage;

    if (!body) {
      body = description || feedItem.item_summary || `*View original article: ${feedItem.item_url}*`;
    }

    // Save to content table
    const insertRes = await fetch(`${supabaseUrl}/rest/v1/content`, {
      method: 'POST',
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: JSON.stringify({
        type: 'article',
        title: title,
        body: body,
        url: feedItem.item_url,
        source: 'Readwise Reader',
        tags: [],
        status: 'new',
        metadata: metadata,
      }),
    });

    if (!insertRes.ok) {
      const errText = await insertRes.text();
      return json({ error: 'Failed to create content', detail: errText }, 500);
    }

    const contentRows = await insertRes.json();
    const contentId = contentRows?.[0]?.id;

    // Mark feed item as captured
    await supabasePatch(supabaseUrl, serviceKey,
      `feed_items?id=eq.${feed_item_id}`, { captured: true });

    return json({ captured: true, content_id: contentId });
  } catch (err) {
    return json({ error: 'Capture failed: ' + err.message }, 500);
  }
}

/**
 * POST /api/search — Vector similarity search.
 */
async function handleSearch(request, env) {
  const { query, limit = 10, tables, date_from, date_to, tags } = await request.json();
  if (!query || typeof query !== 'string') {
    return json({ error: 'Missing query string' }, 400);
  }

  const supabaseUrl = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_KEY;
  const hasFilters = date_from || date_to || (tags && tags.length);

  // Embed the query
  let queryEmbedding;
  try {
    const embeddings = await generateEmbeddings(env, [query]);
    queryEmbedding = embeddings[0];
  } catch (err) {
    return json({ error: `Embedding failed: ${err.message}` }, 500);
  }

  // Fetch more results if post-filtering, so we still return enough after filtering
  const fetchCount = hasFilters ? Math.min(limit * 3, 60) : Math.min(limit, 20);

  // Call the search_embeddings RPC function
  const rpcBody = {
    query_embedding: JSON.stringify(queryEmbedding),
    match_count: fetchCount,
    similarity_threshold: 0.3,
  };
  if (tables && Array.isArray(tables)) {
    rpcBody.filter_tables = tables;
  }

  const rpcRes = await fetch(`${supabaseUrl}/rest/v1/rpc/search_embeddings`, {
    method: 'POST',
    headers: {
      'apikey': serviceKey,
      'Authorization': `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(rpcBody),
  });

  if (!rpcRes.ok) {
    const err = await rpcRes.text();
    return json({ error: 'Search failed', detail: err }, 500);
  }

  let results = await rpcRes.json();

  // Post-filter by date and tags if provided
  if (hasFilters) {
    results = filterSearchResults(results, { date_from, date_to, tags });
    results = results.slice(0, limit);
  }

  return json({ ok: true, results });
}

/**
 * Post-filter search results by metadata date and tags.
 */
function filterSearchResults(results, { date_from, date_to, tags }) {
  return results.filter(r => {
    const meta = r.metadata || {};
    // Date filter — check metadata.date field
    if (date_from || date_to) {
      const itemDate = meta.date;
      if (itemDate) {
        if (date_from && itemDate < date_from) return false;
        if (date_to && itemDate > date_to) return false;
      }
    }
    // Tag filter — check if content_text or metadata contains any of the filter tags
    if (tags && tags.length) {
      const text = (r.content_text || '').toLowerCase();
      const metaStr = JSON.stringify(meta).toLowerCase();
      const hasTag = tags.some(t => text.includes(t.toLowerCase()) || metaStr.includes(t.toLowerCase()));
      if (!hasTag) return false;
    }
    return true;
  });
}

/**
 * POST /api/ask — RAG: vector search + Claude answer generation.
 */
async function handleAsk(request, env) {
  const anthropicKey = env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    return json({ error: 'ANTHROPIC_API_KEY not configured' }, 500);
  }

  const { question, tables, date_from, date_to, tags } = await request.json();
  if (!question || typeof question !== 'string') {
    return json({ error: 'Missing question string' }, 400);
  }

  const supabaseUrl = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_KEY;
  const hasFilters = date_from || date_to || (tags && tags.length);

  // 1. Embed the question
  let queryEmbedding;
  try {
    const embeddings = await generateEmbeddings(env, [question]);
    queryEmbedding = embeddings[0];
  } catch (err) {
    return json({ error: `Embedding failed: ${err.message}` }, 500);
  }

  // 2. Vector search for relevant context (fetch more if post-filtering)
  const fetchCount = hasFilters ? 24 : 8;
  const rpcBody = {
    query_embedding: JSON.stringify(queryEmbedding),
    match_count: fetchCount,
    similarity_threshold: 0.3,
  };
  if (tables && Array.isArray(tables)) {
    rpcBody.filter_tables = tables;
  }

  const rpcRes = await fetch(`${supabaseUrl}/rest/v1/rpc/search_embeddings`, {
    method: 'POST',
    headers: {
      'apikey': serviceKey,
      'Authorization': `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(rpcBody),
  });

  if (!rpcRes.ok) {
    const err = await rpcRes.text();
    return json({ error: 'Search failed', detail: err }, 500);
  }

  let searchResults = await rpcRes.json();

  // Post-filter by date/tags if provided, then take top 8
  if (hasFilters) {
    searchResults = filterSearchResults(searchResults, { date_from, date_to, tags }).slice(0, 8);
  }

  if (!searchResults.length) {
    return json({
      ok: true,
      answer: "I couldn't find any relevant information in your knowledge base for this question.",
      sources: [],
    });
  }

  // 3. Build context for Claude
  const contextBlocks = searchResults.map((r, i) => {
    const meta = r.metadata || {};
    const source = `[Source ${i + 1}: ${meta.title || r.source_table} ${meta.date ? '(' + meta.date + ')' : ''}]`;
    return `${source}\n${r.content_text}`;
  }).join('\n\n---\n\n');

  const systemPrompt = `You are a personal knowledge assistant for Paul Land, a Domain Lead (Packaging Job Lifecycle) and Product Manager (WebCenter Pack) at Esko.

Answer questions based ONLY on the provided context from his knowledge base. Follow these rules:
- Always cite your sources by referencing the source number, type, and date (e.g. "[Source 1]")
- If the context doesn't contain enough information, say so honestly
- Be concise and direct
- Use markdown formatting for readability
- When summarising across multiple sources, note the date range covered`;

  const userMessage = `## Context from Knowledge Base

${contextBlocks}

---

## Question

${question}`;

  // 4. Call Claude API
  let answer;
  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      return json({ error: 'Claude API error', status: claudeRes.status, detail: errText }, 502);
    }

    const claudeData = await claudeRes.json();
    answer = claudeData.content?.[0]?.text || '';
  } catch (err) {
    return json({ error: 'AI processing failed', detail: err.message }, 500);
  }

  // 5. Return answer with sources
  const sources = searchResults.map(r => ({
    source_table: r.source_table,
    source_id: r.source_id,
    title: r.metadata?.title || r.source_table,
    date: r.metadata?.date || '',
    similarity: Math.round(r.similarity * 100) / 100,
    snippet: r.content_text.substring(0, 200),
  }));

  return json({ ok: true, answer, sources });
}

// ─── Extract Signals from Content ─────────────────────────────

async function handleExtractSignals(request, env) {
  try {
  const anthropicKey = env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    return json({ error: 'ANTHROPIC_API_KEY not configured' }, 500);
  }

  const { content_id } = await request.json();
  if (!content_id) {
    return json({ error: 'Missing content_id' }, 400);
  }

  const supabaseUrl = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_KEY;

  // Fetch the content item
  const items = await supabaseGet(supabaseUrl, serviceKey, `content?id=eq.${content_id}&select=id,title,body,tags,source,url,type`);
  if (!items || !items.length) {
    return json({ error: 'Content not found' }, 404);
  }
  const item = items[0];

  const systemPrompt = `You are a strategic intelligence analyst. Your task is to extract strategic signals from the provided content.

A "signal" is an observation about:
- Market shifts or emerging trends
- Competitive moves or positioning changes
- Technology developments or disruptions
- Customer behaviour changes or new needs
- Industry regulatory or structural changes
- Partnership or acquisition activity
- Talent or organisational shifts

For each signal, provide:
- A concise title (5-12 words)
- An observation paragraph explaining what the signal means and why it matters strategically
- 2-4 suggested tags for categorisation

Return ONLY a JSON array. No markdown, no explanation. Example:
[{"title": "...", "observation": "...", "suggested_tags": ["tag1", "tag2"]}]

Extract 1-5 signals. If no meaningful signals exist, return an empty array [].`;

  const userMessage = `## ${item.title}

${item.source ? `Source: ${item.source}` : ''}
${item.url ? `URL: ${item.url}` : ''}
${item.tags?.length ? `Tags: ${item.tags.join(', ')}` : ''}

${(item.body || '(No body content)').slice(0, 15000)}`;

  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      return json({ error: 'Claude API error', status: claudeRes.status, detail: errText }, 502);
    }

    const claudeData = await claudeRes.json();
    const text = claudeData.content?.[0]?.text || '[]';

    // Parse JSON from response (handle potential markdown wrapping)
    let signals;
    try {
      const jsonStr = text.replace(/^```json?\n?/, '').replace(/\n?```$/, '').trim();
      signals = JSON.parse(jsonStr);
    } catch {
      return json({ error: 'Failed to parse AI response', raw: text }, 500);
    }

    return json({ ok: true, signals });
  } catch (err) {
    return json({ error: 'AI processing failed', detail: err.message }, 500);
  }
  } catch (outerErr) {
    return json({ error: 'Handler crashed', detail: outerErr.message, stack: outerErr.stack }, 500);
  }
}

// ─── Signal Synthesis (streaming) ─────────────────────────────

async function handleSignalSynthesis(request, env) {
  const anthropicKey = env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    return json({ error: 'ANTHROPIC_API_KEY not configured' }, 500);
  }

  const { signal_ids, format = 'narrative', focus = 'strategic-implications', context } = await request.json();
  if (!signal_ids?.length || signal_ids.length < 2) {
    return json({ error: 'At least 2 signal IDs required' }, 400);
  }

  const supabaseUrl = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_KEY;

  // Fetch signals
  const signalsRes = await fetch(`${supabaseUrl}/rest/v1/content?id=in.(${signal_ids.map(id => `"${id}"`).join(',')})&select=id,title,body,tags,captured_at,source`, {
    headers: {
      'apikey': serviceKey,
      'Authorization': `Bearer ${serviceKey}`,
    },
  });
  if (!signalsRes.ok) {
    return json({ error: 'Failed to fetch signals' }, 500);
  }
  const signals = await signalsRes.json();
  if (!signals.length) {
    return json({ error: 'No signals found' }, 404);
  }

  const focusLabels = {
    'strategic-implications': 'Strategic Implications',
    'trend-analysis': 'Trend Analysis',
    'competitive-positioning': 'Competitive Positioning',
    'risk-assessment': 'Risk Assessment',
    'opportunity-identification': 'Opportunity Identification',
  };

  const formatInstructions = format === 'structured'
    ? `Structure your analysis with these sections:
## Key Themes
## Strategic Implications
## Risks
## Opportunities
## Recommended Actions

Use bullet points within each section. Be specific and actionable.`
    : `Write a flowing narrative analysis that connects the signals, identifies patterns, and draws out strategic meaning. Use paragraphs, not bullet lists. Be insightful and forward-looking.`;

  const systemPrompt = `You are a strategic intelligence analyst working with Paul Land, a Domain Lead (Packaging Job Lifecycle) and Product Manager at Esko.

Your task is to synthesise multiple strategic signals into a coherent analysis focused on: ${focusLabels[focus] || focus}.

${formatInstructions}

Ground your analysis in the specific signals provided. Reference them by their titles when relevant. Draw connections between signals that the reader might miss. End with a clear "so what" — what should the reader do or think differently based on this synthesis.`;

  const signalsContext = signals.map((s, i) =>
    `### Signal ${i + 1}: ${s.title}
${s.body || '(No detail)'}
Tags: ${(s.tags || []).join(', ')}
Date: ${s.captured_at || 'Unknown'}`
  ).join('\n\n---\n\n');

  const userMessage = `## Signals to Synthesise

${signalsContext}

${context ? `\n## Additional Context\n\n${context}` : ''}

Please synthesise these ${signals.length} signals with a focus on ${focusLabels[focus] || focus}.`;

  // Stream Claude response via TransformStream (same pattern as competitor research)
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const streamPromise = (async () => {
    try {
      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 4000,
          stream: true,
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
        }),
      });

      if (!claudeRes.ok) {
        const errText = await claudeRes.text();
        await writer.write(encoder.encode(`data: ${JSON.stringify({ type: 'error', error: errText })}\n\n`));
        await writer.close();
        return;
      }

      const reader = claudeRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            await writer.write(encoder.encode(line + '\n\n'));
          }
        }
      }

      await writer.write(encoder.encode('data: [DONE]\n\n'));
    } catch (err) {
      await writer.write(encoder.encode(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`));
    } finally {
      await writer.close();
    }
  })();

  // Don't await — let it stream
  streamPromise.catch(() => {});

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

// ─── Competitor Research (web search) ─────────────────────────

async function handleCompetitorResearch(request, env) {
  const anthropicKey = env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    return json({ error: 'ANTHROPIC_API_KEY not configured' }, 500);
  }

  const { name, website, industry, notes, focus } = await request.json();
  if (!name) {
    return json({ error: 'Missing competitor name' }, 400);
  }

  // Build focus-specific instructions
  const focusSections = {
    jobs: `## Job Postings & Hiring
Search for recent job postings from ${name}. What roles are they hiring for? What does this reveal about their tech stack, growth areas, and organizational priorities?`,
    news: `## Recent News & Press Releases
Find recent news coverage, press releases, or announcements about ${name} from the past 6 months.`,
    products: `## Product Updates & Launches
Search for recent product updates, new feature launches, or product roadmap announcements from ${name}.`,
    partnerships: `## Partnerships & Acquisitions
Find any partnership announcements, M&A activity, or strategic alliances involving ${name}.`,
    personnel: `## Key Personnel Changes
Search for leadership changes, notable hires, or executive departures at ${name}.`,
  };

  const allSections = Object.values(focusSections).join('\n\n');
  const focusedSection = focus && focus !== 'all' && focusSections[focus]
    ? focusSections[focus]
    : allSections;

  const prompt = `You are a competitive intelligence analyst. Research the company "${name}"${website ? ' (website: ' + website + ')' : ''}${industry ? ' in the ' + industry + ' industry' : ''}.

Use web search to find current information. Search thoroughly — try multiple queries to get comprehensive results.

${focusedSection}

${notes ? 'Additional context from our notes about this company:\n' + notes + '\n' : ''}
Format your response as a structured markdown report with clear section headers. Under each section, include:
- A brief summary of findings
- Key bullet points with specific details
- Source URLs where available (as markdown links)
- "No significant findings" if nothing relevant was found

${focus === 'all' || !focus ? 'End with a **## Key Takeaways** section with 3-5 strategic observations.' : ''}`;

  // Architecture: Start an SSE stream to the client immediately (keeps CF connection alive),
  // then make a NON-streaming Anthropic API call (avoids web_search+streaming issues).
  // CF Workers can hold outgoing streams open while waiting on upstream fetches — the timeout
  // applies to CPU time, not wall-clock time waiting on fetch().
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const send = (obj) => writer.write(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

  // Process in background — the SSE response is returned immediately
  (async () => {
    try {
      // Send initial status so client knows we're alive
      await send({ type: 'status', text: 'Connecting to AI...' });

      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'web-search-2025-03-05',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 16000,
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 10 }],
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      if (!claudeRes.ok) {
        const errText = await claudeRes.text();
        // Try to extract a meaningful error message from Anthropic's response
        let errMsg = `Claude API returned ${claudeRes.status}`;
        try {
          const errData = JSON.parse(errText);
          if (errData.error?.message) errMsg = errData.error.message;
          else if (errData.error?.type) errMsg = errData.error.type;
        } catch (_) {
          if (errText.length < 200) errMsg = errText;
        }
        await send({ type: 'error', message: errMsg });
        return;
      }

      await send({ type: 'status', text: 'Analyzing results...' });

      const claudeData = await claudeRes.json();

      // Extract text blocks (web search responses contain tool_use + tool_result + text blocks)
      const report = (claudeData.content || [])
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n\n');

      if (!report) {
        await send({ type: 'error', message: 'No research results generated. Try a different focus area.' });
        return;
      }

      // Stream the report to the client in chunks for progressive rendering
      const chunkSize = 200;
      for (let i = 0; i < report.length; i += chunkSize) {
        await send({ type: 'delta', text: report.slice(i, i + chunkSize) });
      }

      await send({ type: 'done' });
    } catch (err) {
      try {
        await send({ type: 'error', message: err.message || 'Research failed' });
      } catch (_) {}
    } finally {
      try { await writer.close(); } catch (_) {}
    }
  })();

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// ─── Supabase helpers ────────────────────────────────────────

async function supabaseGet(url, key, path) {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
    },
  });
  if (!res.ok) return [];
  return res.json();
}

async function supabasePost(url, key, table, data) {
  return fetch(`${url}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(data),
  });
}

async function supabasePatch(url, key, path, data) {
  return fetch(`${url}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(data),
  });
}

// ─── Calendar events ─────────────────────────────────────────

async function handleCalendarEvents(request, env) {
  const icsUrl = env.OUTLOOK_ICS_URL;
  if (!icsUrl) {
    return json({ error: 'Calendar not configured' }, 500);
  }

  const url = new URL(request.url);
  const dateStr = url.searchParams.get('date');
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return json({ error: 'Missing or invalid date parameter (YYYY-MM-DD)' }, 400);
  }

  try {
    // Fetch the ICS feed — minimal headers to avoid Outlook/Exchange blocks
    const icsRes = await fetch(icsUrl);

    if (!icsRes.ok) {
      const body = await icsRes.text().catch(() => '');
      return json({
        error: 'Failed to fetch calendar',
        status: icsRes.status,
        statusText: icsRes.statusText,
        detail: body.substring(0, 500),
        url_configured: !!icsUrl,
      }, 502);
    }

    const icsText = await icsRes.text();
    const events = parseICSForDate(icsText, dateStr);

    return json({ ok: true, date: dateStr, events });
  } catch (err) {
    return json({ error: 'Calendar fetch failed', detail: err.message }, 500);
  }
}

/**
 * Parse ICS text and return events for a specific date.
 * Handles DTSTART/DTEND in various formats, SUMMARY, LOCATION, ATTENDEE, ORGANIZER.
 */
function parseICSForDate(icsText, dateStr) {
  const events = [];
  const targetDate = dateStr.replace(/-/g, ''); // '20260318'

  // Split into VEVENT blocks
  const eventBlocks = icsText.split('BEGIN:VEVENT');

  for (let i = 1; i < eventBlocks.length; i++) {
    const block = eventBlocks[i].split('END:VEVENT')[0];
    if (!block) continue;

    // Unfold long lines (RFC 5545: lines starting with space/tab are continuations)
    const unfolded = block.replace(/\r?\n[ \t]/g, '');

    const lines = unfolded.split(/\r?\n/);
    const props = {};
    const attendees = [];

    for (const line of lines) {
      // Handle DTSTART and DTEND (may have params like TZID)
      if (line.startsWith('DTSTART')) {
        props.dtstart = extractDateTimeValue(line);
      } else if (line.startsWith('DTEND')) {
        props.dtend = extractDateTimeValue(line);
      } else if (line.startsWith('SUMMARY:')) {
        props.summary = line.substring(8).trim();
      } else if (line.startsWith('LOCATION:')) {
        props.location = line.substring(9).trim();
      } else if (line.startsWith('ORGANIZER')) {
        const cn = extractParam(line, 'CN');
        const email = extractMailto(line);
        props.organizer = cn || email || '';
      } else if (line.startsWith('ATTENDEE')) {
        const cn = extractParam(line, 'CN');
        const email = extractMailto(line);
        if (cn || email) attendees.push(cn || email);
      } else if (line.startsWith('STATUS:')) {
        props.status = line.substring(7).trim();
      } else if (line.startsWith('UID:')) {
        props.uid = line.substring(4).trim();
      } else if (line.startsWith('RECURRENCE-ID')) {
        props.recurrenceId = extractDateTimeValue(line);
      } else if (line.startsWith('RRULE:')) {
        props.rrule = line.substring(6).trim();
      }
    }

    // Skip cancelled events
    if (props.status === 'CANCELLED') continue;

    // Check if event falls on target date
    if (!props.dtstart) continue;

    const startDate = props.dtstart.dateOnly; // YYYYMMDD
    const endDate = props.dtend?.dateOnly || startDate;

    // Handle all-day events (no time component)
    const isAllDay = props.dtstart.allDay;

    // Check date match — event starts on target date, or spans across it
    let matches = false;
    if (startDate === targetDate) {
      matches = true;
    } else if (startDate < targetDate && endDate > targetDate) {
      matches = true; // Multi-day event spanning this date
    }

    // Handle recurring events (basic daily/weekly/monthly)
    if (!matches && props.rrule) {
      matches = checkRecurrence(props.rrule, startDate, targetDate);
    }

    if (!matches) continue;

    events.push({
      uid: props.uid || '',
      title: props.summary || 'Untitled Event',
      startTime: props.dtstart.time || '',
      endTime: props.dtend?.time || '',
      allDay: isAllDay,
      location: props.location || '',
      organizer: props.organizer || '',
      attendees: attendees.slice(0, 20), // Limit to prevent huge payloads
    });
  }

  // Sort by start time
  events.sort((a, b) => (a.startTime || '0000').localeCompare(b.startTime || '0000'));

  return events;
}

function extractDateTimeValue(line) {
  // DTSTART;TZID=Romance Standard Time:20260318T110000
  // DTSTART;TZID=Europe/London:20260318T100000
  // DTSTART:20260318T100000Z
  // DTSTART;VALUE=DATE:20260318
  //
  // The colon separator can appear inside TZID values (e.g. "Standard Time:"),
  // so we find the date value by matching a date pattern after the last colon,
  // or use the last colon as separator.

  // Find the date value — always 8+ digits, possibly followed by T and time
  const dateMatch = line.match(/(\d{8})(T\d{6}Z?)?$/);
  if (!dateMatch) return null;

  const rawValue = dateMatch[0];
  const params = line.substring(0, line.lastIndexOf(rawValue));

  const allDay = params.includes('VALUE=DATE') || rawValue.length === 8;
  const dateOnly = rawValue.substring(0, 8); // YYYYMMDD

  let time = '';
  if (!allDay && rawValue.length >= 15) {
    // Extract HH:MM from THHMMSS
    time = rawValue.substring(9, 11) + ':' + rawValue.substring(11, 13);
  }

  return { dateOnly, time, allDay, raw: rawValue };
}

function extractParam(line, paramName) {
  const regex = new RegExp(paramName + '=([^;:]+)', 'i');
  const match = line.match(regex);
  if (match) {
    let val = match[1].trim();
    // Remove quotes if present
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    return val;
  }
  return null;
}

function extractMailto(line) {
  const match = line.match(/mailto:([^\s;]+)/i);
  return match ? match[1].trim() : null;
}

function checkRecurrence(rrule, startDateStr, targetDateStr) {
  // Basic recurrence check for common patterns
  // startDateStr and targetDateStr are YYYYMMDD strings
  const start = parseDateStr(startDateStr);
  const target = parseDateStr(targetDateStr);
  if (!start || !target || target < start) return false;

  const parts = {};
  rrule.split(';').forEach(p => {
    const [k, v] = p.split('=');
    parts[k] = v;
  });

  const freq = parts.FREQ;
  if (!freq) return false;

  // Check UNTIL if present
  if (parts.UNTIL) {
    const untilDate = parts.UNTIL.substring(0, 8);
    if (targetDateStr > untilDate) return false;
  }

  // Check COUNT — skip for now (would need full expansion)

  const diffDays = Math.round((target - start) / (1000 * 60 * 60 * 24));
  const interval = parseInt(parts.INTERVAL || '1');

  switch (freq) {
    case 'DAILY':
      return diffDays % interval === 0;
    case 'WEEKLY': {
      if (parts.BYDAY) {
        const dayMap = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
        const targetDay = target.getDay();
        const days = parts.BYDAY.split(',').map(d => dayMap[d.trim()]);
        if (!days.includes(targetDay)) return false;
      }
      const diffWeeks = Math.floor(diffDays / 7);
      return diffWeeks % interval === 0 || diffDays % (7 * interval) < 7;
    }
    case 'MONTHLY': {
      const sameDay = start.getDate() === target.getDate();
      const monthDiff = (target.getFullYear() - start.getFullYear()) * 12 + target.getMonth() - start.getMonth();
      return sameDay && monthDiff % interval === 0;
    }
    case 'YEARLY': {
      const sameMonthDay = start.getMonth() === target.getMonth() && start.getDate() === target.getDate();
      const yearDiff = target.getFullYear() - start.getFullYear();
      return sameMonthDay && yearDiff % interval === 0;
    }
    default:
      return false;
  }
}

function parseDateStr(str) {
  // YYYYMMDD -> Date
  if (str.length < 8) return null;
  const y = parseInt(str.substring(0, 4));
  const m = parseInt(str.substring(4, 6)) - 1;
  const d = parseInt(str.substring(6, 8));
  return new Date(y, m, d);
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
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-WCP-Token, X-WCP-Region, X-WCP-Cluster, X-WCP-Ecan, X-WCP-RepoId, X-MIS-Connection-Id',
  };
}
