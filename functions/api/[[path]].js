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
 *   GET  /api/assets/:id/content — Fetch asset content (text or base64)
 *   DELETE /api/assets/:id     — Delete asset from R2 + Supabase
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

  // Route to handler
  const url = new URL(request.url);
  const path = url.pathname.replace('/api/', '');

  if (!isInternalRequest) {
    // Validate Cloudflare Access JWT for all other requests
    const authResult = await validateAccessJWT(request, env);
    if (!authResult.valid) {
      return json({ error: 'Unauthorized', detail: authResult.reason }, 401);
    }
  }

  // ─── MIS Proxy Routes ───────────────────────────────────────
  if (path.startsWith('mis/')) {
    return handleMisRoute(path, request, env);
  }

  // Asset file serving — GET /api/assets/file/...
  if (request.method === 'GET' && path.startsWith('assets/file/')) {
    const r2Key = path.replace('assets/file/', '');
    return handleAssetServe(r2Key, env);
  }

  // Asset content retrieval — GET /api/assets/:id/content
  if (request.method === 'GET' && path.match(/^assets\/[0-9a-f-]+\/content$/)) {
    const assetId = path.split('/')[1];
    return handleAssetContent(assetId, env);
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

  // Resolve a single usage error — PATCH /api/usage-errors/:id/resolve
  if (request.method === 'POST' && path.match(/^usage-errors\/[0-9a-f-]+\/resolve$/)) {
    const id = path.split('/')[1];
    return handleResolveUsageError(id, env);
  }

  // ─── Tasks routes ───────────────────────────────────────────
  if (path.startsWith('tasks')) {
    // POST /api/tasks/:id/complete
    const completeMatch = path.match(/^tasks\/([0-9a-f-]+)\/complete$/);
    if (request.method === 'POST' && completeMatch) {
      return handleTaskComplete(completeMatch[1], env, ctx);
    }
    // PATCH /api/tasks/:id
    const idMatch = path.match(/^tasks\/([0-9a-f-]+)$/);
    if (request.method === 'PATCH' && idMatch) {
      return handleTaskUpdate(idMatch[1], request, env, ctx);
    }
    // DELETE /api/tasks/:id
    if (request.method === 'DELETE' && idMatch) {
      return handleTaskDelete(idMatch[1], env);
    }
    // POST /api/tasks
    if (request.method === 'POST' && path === 'tasks') {
      return handleTaskCreate(request, env, ctx);
    }
    // GET /api/tasks or /api/tasks/:id
    if (request.method === 'GET' && path === 'tasks') {
      return handleTasksList(request, env);
    }
    if (request.method === 'GET' && idMatch) {
      return handleTaskGet(idMatch[1], env);
    }
  }

  if (request.method === 'GET') {
    switch (path) {
      case 'calendar-events':
        return handleCalendarEvents(request, env);
      case 'usage-errors':
        return handleListUsageErrors(request, env);
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
      case 'assets/batch-update':
        return handleAssetBatchUpdate(request, env);
      case 'entity-log':
        return handleEntityLog(request, env, ctx);
      case 'generate-summary':
        return handleGenerateSummary(request, env, ctx);
      case 'assets/upload':
        return handleAssetUpload(request, env);
      case 'embed-batch':
        return handleEmbedBatch(request, env);
      case 'search':
        return handleSearch(request, env);
      case 'ask':
        return handleAsk(request, env, ctx);
      case 'ask-stream':
        return handleAskStream(request, env, ctx);
      case 'summarize-to-note':
        return handleSummarizeToNote(request, env, ctx);
      case 'competitor-research':
        return handleCompetitorResearch(request, env, ctx);
      case 'extract-signals':
        return handleExtractSignals(request, env, ctx);
      case 'signal-synthesis':
        return handleSignalSynthesis(request, env, ctx);
      case 'reflection-synthesis':
        return handleReflectionSynthesis(request, env, ctx);
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
      'mis_connections?select=id,name,type,is_active,cluster,ecan,repo_id,server_url,api_version,base_url,email_prefix,workflow_rules,created_at,updated_at&order=created_at.desc'
    );
    return json(rows);
  }

  // GET /api/mis/connections/:id — get single (token excluded)
  if (request.method === 'GET' && subPath) {
    const id = subPath;
    const rows = await supabaseGet(supabaseUrl, serviceKey,
      `mis_connections?id=eq.${id}&select=id,name,type,is_active,cluster,ecan,repo_id,server_url,api_version,base_url,email_prefix,workflow_rules,created_at,updated_at`
    );
    return json(rows[0] || null);
  }

  // POST /api/mis/connections — create new
  if (request.method === 'POST' && !subPath) {
    const body = await request.json();
    const { name, type, cluster, ecan, repo_id, server_url, token, is_active, api_version, base_url, email_prefix } = body;

    if (!name || !type) return json({ error: 'name and type are required' }, 400);
    if (type === 'wcp') {
      if (api_version === 's2') {
        if (!base_url || !repo_id) {
          return json({ error: 'S2 WCP connections require base_url and repo_id' }, 400);
        }
      } else {
        if (!cluster || !ecan || !repo_id) {
          return json({ error: 'Legacy WCP connections require cluster, ecan, and repo_id' }, 400);
        }
      }
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
      api_version: api_version || 'legacy',
      base_url: base_url ? base_url.replace(/\/+$/, '') : null,
      email_prefix: email_prefix || null,
      workflow_rules: body.workflow_rules || null,
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
    for (const field of ['name', 'type', 'cluster', 'ecan', 'repo_id', 'server_url', 'is_active', 'api_version', 'base_url', 'email_prefix', 'workflow_rules']) {
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
      project_node_id: body.project_node_id || null,
      workflow_instance_id: body.workflow_instance_id || null,
    };
    // AE → WCP enrichment columns — only carried when the caller explicitly
    // sets them (email worker and admin AE form). Legacy paths don't populate.
    for (const field of ['enrichment_payload', 'enrichment_attempts', 'enrichment_next_at', 'enriched_at', 'pending_attachments']) {
      if (body[field] !== undefined) row[field] = body[field];
    }

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
                         'due_date', 'description', 'payload', 'wcp_response',
                         'project_node_id', 'workflow_instance_id',
                         'solution', 'connection_id', 'connection_name', 'cluster',
                         // AE → WCP enrichment lifecycle
                         'enrichment_payload', 'enrichment_attempts',
                         'enrichment_next_at', 'enriched_at', 'pending_attachments']) {
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
    `mis_connections?id=eq.${connectionId}&select=encrypted_token,token_iv,type,cluster,ecan,repo_id,server_url,api_version,base_url`
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
    `mis_connections?is_active=eq.true&select=id,name,type,encrypted_token,token_iv,cluster,ecan,repo_id,server_url,api_version,base_url`
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

// ─── Automation Engine Routes ────────────────────────────────

async function handleAeRoute(subPath, request, conn, env) {
  const serverUrl = conn.server_url;
  let token = conn.token || '';
  try { const p = JSON.parse(token); if (p.token) token = p.token; } catch {}

  if (!serverUrl || !token) {
    return json({ error: 'AE connection missing server_url or token' }, 503);
  }

  const aeBase = serverUrl.startsWith('https://') ? serverUrl : `https://${serverUrl}`;
  const aeHeaders = {
    'AutomationEngine-Token': token,
    'Accept': 'application/json',
    'User-Agent': 'PaulLand-MIS/1.0',
  };

  // AE has no ref data — return empty for these routes
  if (['customers', 'task-templates', 'product-templates', 'preflight-profiles'].includes(subPath)) {
    return json([]);
  }

  // Create job via AE WebService
  if (subPath === 'create-job') {
    const body = await request.json();
    const params = new URLSearchParams();
    if (body.jobId) params.set('Job ID', body.jobId);
    if (body.jobPartId) params.set('Job Part ID', body.jobPartId);
    if (body.jobName) params.set('Name', body.jobName);
    if (body.description) params.set('Description', body.description);
    if (body.category) params.set('Category', body.category);
    if (body.customField1) params.set('Custom Field 1', body.customField1);
    if (body.customerCode) params.set('Customer ID', body.customerCode);

    const aeUrl = `${aeBase}/ws/JobCreation?${params.toString()}`;
    const resp = await fetch(aeUrl, { method: 'GET', headers: aeHeaders });
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { rawResponse: text.slice(0, 1000) }; }

    // Detect AE remark errors in XML responses (AE returns HTTP 200 even on failure)
    if (data.rawResponse) {
      const remarks = [...data.rawResponse.matchAll(/<remark>(.*?)<\/remark>/gs)].map(m => m[1].trim());
      if (remarks.length > 0) {
        data.ae_errors = remarks;
        data.ae_success = false;
      } else {
        data.ae_success = true;
      }
    }

    return json(data, resp.status);
  }

  return json({ error: `AE route not supported: ${subPath}` }, 404);
}

// ─── S2 MIS API Proxy Routes ─────────────────────────────────

async function handleS2Route(subPath, request, conn, env) {
  const repoId = conn.repo_id || '';
  let token = conn.token || '';
  const baseUrl = conn.base_url || '';

  try { const p = JSON.parse(token); if (p.token) token = p.token; } catch {}

  if (!baseUrl || !token || !repoId) {
    return json({ error: 'S2 connection requires base_url, repo_id, and token' }, 503);
  }

  const s2Base = baseUrl.replace(/\/+$/, '');
  const s2Headers = {
    'EskoCloud-Token': token,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'PaulLand-MIS/2.0',
  };

  // Parse pagination params from request URL
  const reqUrl = new URL(request.url);
  const from = reqUrl.searchParams.get('from') || '0';
  const pageSize = reqUrl.searchParams.get('pageSize') || '50';
  const sortType = reqUrl.searchParams.get('sortType') || 'modificationDate';
  const sortDir = reqUrl.searchParams.get('sortDir') || 'desc';
  const paginationQS = `from=${from}&pageSize=${pageSize}&sortType=${sortType}&sortDir=${sortDir}`;

  // ─── Customers ───
  if (subPath === 'customers' && request.method === 'GET') {
    const resp = await fetch(
      `${s2Base}/MIS/v0/${repoId}/customers?${paginationQS}`,
      { headers: s2Headers }
    );
    return new Response(resp.body, { status: resp.status, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
  }

  if (subPath === 'customers' && request.method === 'POST') {
    const body = await request.text();
    const resp = await fetch(
      `${s2Base}/MIS/v0/${repoId}/customers`,
      { method: 'POST', headers: s2Headers, body }
    );
    return new Response(resp.body, { status: resp.status, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
  }

  if (subPath.match(/^customers\/[^/]+$/) && request.method === 'GET') {
    const nodeId = subPath.replace('customers/', '');
    const resp = await fetch(
      `${s2Base}/MIS/v0/customers/${nodeId}`,
      { headers: s2Headers }
    );
    return new Response(resp.body, { status: resp.status, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
  }

  // ─── Projects ───
  if (subPath === 'projects' && request.method === 'GET') {
    const resp = await fetch(
      `${s2Base}/MIS/v0/${repoId}/projects?${paginationQS}`,
      { headers: s2Headers }
    );
    return new Response(resp.body, { status: resp.status, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
  }

  // Upsert: S2 matches on properties.{MISId, jobId, jobPartId}. If the triplet
  // already exists, the body is treated as a partial update (only the fields
  // present in the body are changed). Otherwise a new project is created.
  // There is no separate PUT/PATCH on /projects/:id — this is the only write route.
  if (subPath === 'projects' && request.method === 'POST') {
    const body = await request.text();
    const resp = await fetch(
      `${s2Base}/MIS/v0/${repoId}/projects`,
      { method: 'POST', headers: s2Headers, body }
    );
    return new Response(resp.body, { status: resp.status, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
  }

  if (subPath.match(/^projects\/[^/]+$/) && request.method === 'GET') {
    const nodeId = subPath.replace('projects/', '');
    const resp = await fetch(
      `${s2Base}/MIS/v0/projects/${nodeId}`,
      { headers: s2Headers }
    );
    return new Response(resp.body, { status: resp.status, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
  }

  if (subPath.match(/^projects\/[^/]+\/status$/) && request.method === 'POST') {
    const nodeId = subPath.replace('projects/', '').replace('/status', '');
    const status = reqUrl.searchParams.get('status') || 'Active';
    const resp = await fetch(
      `${s2Base}/MIS/v0/projects/${nodeId}/status?status=${encodeURIComponent(status)}`,
      { method: 'POST', headers: s2Headers }
    );
    return new Response(resp.body, { status: resp.status, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
  }

  if (subPath.match(/^projects\/[^/]+\/products$/) && request.method === 'POST') {
    const nodeId = subPath.replace('projects/', '').replace('/products', '');
    const body = await request.text();
    const resp = await fetch(
      `${s2Base}/MIS/v0/projects/${nodeId}/products`,
      { method: 'POST', headers: s2Headers, body }
    );
    return new Response(resp.body, { status: resp.status, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
  }

  if (subPath.match(/^projects\/[^/]+\/assets$/) && request.method === 'GET') {
    const nodeId = subPath.replace('projects/', '').replace('/assets', '');
    const resp = await fetch(
      `${s2Base}/MIS/v0/projects/${nodeId}/assets`,
      { headers: s2Headers }
    );
    return new Response(resp.body, { status: resp.status, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
  }

  if (subPath.match(/^projects\/[^/]+\/assets$/) && request.method === 'POST') {
    const nodeId = subPath.replace('projects/', '').replace('/assets', '');
    const body = await request.text();
    const resp = await fetch(
      `${s2Base}/MIS/v0/projects/${nodeId}/assets`,
      { method: 'POST', headers: s2Headers, body }
    );
    return new Response(resp.body, { status: resp.status, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
  }

  // ─── Products ───
  if (subPath === 'products' && request.method === 'GET') {
    const resp = await fetch(
      `${s2Base}/MIS/v0/${repoId}/products?${paginationQS}`,
      { headers: s2Headers }
    );
    return new Response(resp.body, { status: resp.status, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
  }

  // Upsert: S2 matches on `name`. If the name already exists, the body is a
  // partial update; otherwise a new product is created. There is no separate
  // PUT/PATCH on /products/:id — this is the only write route.
  if (subPath === 'products' && request.method === 'POST') {
    const body = await request.text();
    const resp = await fetch(
      `${s2Base}/MIS/v0/${repoId}/products`,
      { method: 'POST', headers: s2Headers, body }
    );
    return new Response(resp.body, { status: resp.status, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
  }

  if (subPath.match(/^products\/[^/]+$/) && request.method === 'GET') {
    const nodeId = subPath.replace('products/', '');
    const resp = await fetch(
      `${s2Base}/MIS/v0/products/${nodeId}`,
      { headers: s2Headers }
    );
    return new Response(resp.body, { status: resp.status, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
  }

  if (subPath.match(/^products\/[^/]+\/status$/) && request.method === 'POST') {
    const nodeId = subPath.replace('products/', '').replace('/status', '');
    // Forward all query params (status, partName, side, authorName, authorComment)
    const statusParams = reqUrl.search;
    const resp = await fetch(
      `${s2Base}/MIS/v0/products/${nodeId}/status${statusParams}`,
      { method: 'POST', headers: s2Headers }
    );
    return new Response(resp.body, { status: resp.status, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
  }

  if (subPath.match(/^products\/[^/]+\/shapeAsset$/) && request.method === 'POST') {
    const nodeId = subPath.replace('products/', '').replace('/shapeAsset', '');
    const body = await request.text();
    const resp = await fetch(
      `${s2Base}/MIS/v0/products/${nodeId}/shapeAsset`,
      { method: 'POST', headers: s2Headers, body }
    );
    return new Response(resp.body, { status: resp.status, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
  }

  if (subPath.match(/^products\/[^/]+\/graphicAssets$/) && request.method === 'POST') {
    const nodeId = subPath.replace('products/', '').replace('/graphicAssets', '');
    const body = await request.text();
    const resp = await fetch(
      `${s2Base}/MIS/v0/products/${nodeId}/graphicAssets`,
      { method: 'POST', headers: s2Headers, body }
    );
    return new Response(resp.body, { status: resp.status, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
  }

  // ─── Workflow Templates ───
  if (subPath === 'workflow-templates' && request.method === 'GET') {
    const resp = await fetch(
      `${s2Base}/MIS/v0/${repoId}/workflowTemplates?${paginationQS}`,
      { headers: s2Headers }
    );
    return new Response(resp.body, { status: resp.status, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
  }

  if (subPath.match(/^workflow-templates\/[^/]+$/) && request.method === 'GET') {
    const templateId = subPath.replace('workflow-templates/', '');
    const resp = await fetch(
      `${s2Base}/MIS/v0/workflowTemplates/${templateId}`,
      { headers: s2Headers }
    );
    return new Response(resp.body, { status: resp.status, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
  }

  if (subPath.match(/^workflow-templates\/[^/]+\/launch$/) && request.method === 'POST') {
    const templateId = subPath.replace('workflow-templates/', '').replace('/launch', '');
    const body = await request.text();
    const resp = await fetch(
      `${s2Base}/MIS/v0/workflowTemplates/${templateId}`,
      { method: 'POST', headers: s2Headers, body }
    );
    return new Response(resp.body, { status: resp.status, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
  }

  // ─── Workflow Instances ───
  if (subPath === 'workflow-instances' && request.method === 'GET') {
    const resp = await fetch(
      `${s2Base}/MIS/v0/${repoId}/workflowInstances?${paginationQS}`,
      { headers: s2Headers }
    );
    return new Response(resp.body, { status: resp.status, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
  }

  if (subPath.match(/^workflow-instances\/[^/]+$/) && request.method === 'GET') {
    const instanceId = subPath.replace('workflow-instances/', '');
    const resp = await fetch(
      `${s2Base}/MIS/v0/workflowInstances/${instanceId}`,
      { headers: s2Headers }
    );
    return new Response(resp.body, { status: resp.status, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
  }

  if (subPath.match(/^workflow-instances\/[^/]+\/cancel$/) && request.method === 'POST') {
    const instanceId = subPath.replace('workflow-instances/', '').replace('/cancel', '');
    const resp = await fetch(
      `${s2Base}/MIS/v0/workflowInstances/${instanceId}?operation=Cancel`,
      { method: 'POST', headers: s2Headers, body: '' }
    );
    return new Response(resp.body, { status: resp.status, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
  }

  // ─── Media ───
  if (subPath === 'media' && request.method === 'GET') {
    const predefined = reqUrl.searchParams.get('predefined') || '';
    const extra = predefined ? `&predefined=${predefined}` : '';
    const resp = await fetch(
      `${s2Base}/MIS/v0/${repoId}/media?${paginationQS}${extra}`,
      { headers: s2Headers }
    );
    return new Response(resp.body, { status: resp.status, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
  }

  if (subPath === 'media' && request.method === 'POST') {
    const body = await request.text();
    const resp = await fetch(
      `${s2Base}/MIS/v0/${repoId}/media`,
      { method: 'POST', headers: s2Headers, body }
    );
    return new Response(resp.body, { status: resp.status, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
  }

  if (subPath.match(/^media\/[^/]+$/) && request.method === 'GET') {
    const nodeId = subPath.replace('media/', '');
    const resp = await fetch(
      `${s2Base}/MIS/v0/media/${nodeId}`,
      { headers: s2Headers }
    );
    return new Response(resp.body, { status: resp.status, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
  }

  // ─── Assets ───
  if (subPath.match(/^assets\/[^/]+$/) && request.method === 'GET') {
    const assetId = subPath.replace('assets/', '');
    const resp = await fetch(
      `${s2Base}/MIS/v0/assets/${assetId}`,
      { headers: s2Headers }
    );
    return new Response(resp.body, { status: resp.status, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
  }

  if (subPath.match(/^assets\/[^/]+\/thumbnail$/) && request.method === 'GET') {
    const assetId = subPath.replace('assets/', '').replace('/thumbnail', '');
    const resp = await fetch(
      `${s2Base}/MIS/v0/assets/${assetId}/thumbnail`,
      { headers: s2Headers }
    );
    return new Response(resp.body, { status: resp.status, headers: { 'Content-Type': resp.headers.get('Content-Type') || 'image/png', ...corsHeaders() } });
  }

  if (subPath.match(/^assets\/[^/]+\/content$/) && request.method === 'GET') {
    const assetId = subPath.replace('assets/', '').replace('/content', '');
    const resp = await fetch(
      `${s2Base}/MIS/v0/assets/${assetId}/content`,
      { headers: s2Headers }
    );
    return new Response(resp.body, { status: resp.status, headers: { 'Content-Type': resp.headers.get('Content-Type') || 'application/octet-stream', ...corsHeaders() } });
  }

  if (subPath.match(/^assets\/[^/]+\/content$/) && request.method === 'POST') {
    const assetId = subPath.replace('assets/', '').replace('/content', '');
    const body = await request.arrayBuffer();
    // Minimal headers for binary upload — S2 only needs token + content type
    const uploadHeaders = {
      'EskoCloud-Token': token,
      'Content-Type': request.headers.get('Content-Type') || 'application/octet-stream',
      'User-Agent': 'PaulLand-MIS/2.0',
    };
    const resp = await fetch(
      `${s2Base}/MIS/v0/assets/${assetId}/content`,
      { method: 'POST', headers: uploadHeaders, body }
    );
    return new Response(resp.body, { status: resp.status, headers: { 'Content-Type': resp.headers.get('Content-Type') || 'application/json', ...corsHeaders() } });
  }

  // PUT /assets/:assetId/content — Upload binary content via PUT (used by 3-step upload flow)
  if (subPath.match(/^assets\/[^/]+\/content$/) && request.method === 'PUT') {
    const assetId = subPath.replace('assets/', '').replace('/content', '');
    const body = await request.arrayBuffer();
    const uploadHeaders = {
      'EskoCloud-Token': token,
      'Content-Type': request.headers.get('Content-Type') || 'application/octet-stream',
      'User-Agent': 'PaulLand-MIS/2.0',
    };
    const resp = await fetch(
      `${s2Base}/MIS/v0/assets/${assetId}/content`,
      { method: 'PUT', headers: uploadHeaders, body }
    );
    return new Response(resp.body, { status: resp.status, headers: { 'Content-Type': resp.headers.get('Content-Type') || 'application/json', ...corsHeaders() } });
  }

  // POST /assets/:assetId/contentUploadStatus — Finalize a 3-step asset upload
  if (subPath.match(/^assets\/[^/]+\/contentUploadStatus$/) && request.method === 'POST') {
    const assetId = subPath.replace('assets/', '').replace('/contentUploadStatus', '');
    const contentId = reqUrl.searchParams.get('contentId') || '';
    const version = reqUrl.searchParams.get('version') || '';
    const status = reqUrl.searchParams.get('status') || 'completed';
    const qs = `contentId=${encodeURIComponent(contentId)}&version=${encodeURIComponent(version)}&status=${encodeURIComponent(status)}`;
    const resp = await fetch(
      `${s2Base}/MIS/v0/assets/${assetId}/contentUploadStatus?${qs}`,
      { method: 'POST', headers: s2Headers }
    );
    return new Response(resp.body, { status: resp.status, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
  }

  // ─── Compatibility shim: map legacy routes for S2 connections ───
  // list_customers → customers, list_task_templates → workflow-templates, create-job → projects
  if (subPath === 'task-templates') {
    // Redirect to workflow templates for S2
    const resp = await fetch(
      `${s2Base}/MIS/v0/${repoId}/workflowTemplates?${paginationQS}`,
      { headers: s2Headers }
    );
    return new Response(resp.body, { status: resp.status, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
  }

  if (subPath === 'create-job' && request.method === 'PUT') {
    // Legacy create-job → S2 create project
    const body = await request.text();
    const resp = await fetch(
      `${s2Base}/MIS/v0/${repoId}/projects`,
      { method: 'POST', headers: s2Headers, body }
    );
    return new Response(resp.body, { status: resp.status, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
  }

  // Legacy routes not applicable to S2 — return empty arrays instead of 404
  if (['product-templates', 'preflight-profiles', 'config', 'debug'].includes(subPath)) {
    return json([]);
  }

  return json({ error: `S2 route not found: ${subPath}` }, 404);
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

    // Route S2 connections to dedicated S2 handler
    if (conn.api_version === 's2') {
      return handleS2Route(path.replace('mis/', ''), request, conn, env);
    }

    // Route AE connections to dedicated handler
    if (conn.type === 'ae') {
      return handleAeRoute(path.replace('mis/', ''), request, conn, env);
    }

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
      const encodedId = encodeURIComponent(jobId);
      // Try multiple URL patterns — WCP API docs are inconsistent on ECAN vs REPOID
      const urls = [
        `${w2pBase}/api/v0/${WCP_REPOID}/${encodedId}/getJobDetails`,
        `${w2pBase}/api/v0/${WCP_REPOID}/getJobDetails/${encodedId}`,
        `${w2pBase}/api/v0/${WCP_ECAN}/getJobDetails/${encodedId}`,
      ];
      for (const url of urls) {
        const resp = await fetch(url, { headers: wcpHeaders });
        if (resp.ok) {
          return new Response(resp.body, { status: resp.status, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
        }
        // Consume body before trying next URL
        await resp.text();
      }
      // All failed — return last attempt's error
      return json({ error: 'Job not found in WCP', tried: urls.length + ' URL patterns', jobId }, 404);
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
  if (id && env.AI) {
    ctx.waitUntil(embedItem(env, 'content', id).catch(() => {}));
  }

  return json({ ok: true, tags: cleanTags });
}

async function handleEntityUpdate(request, env, ctx) {
  const { table, id, updates } = await request.json();

  const allowedTables = ['people', 'products', 'projects', 'summaries', 'assets', 'companies', 'content', 'prompts', 'tasks'];
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
  const embeddableTables = ['people', 'products', 'projects', 'summaries', 'companies', 'tasks'];
  if (embeddableTables.includes(table) && id && env.AI) {
    ctx.waitUntil(embedItem(env, table, id).catch(() => {}));
  }

  return json({ ok: true });
}

async function handleAssetBatchUpdate(request, env) {
  const body = await request.json();
  const { asset_ids, operation } = body;

  if (!Array.isArray(asset_ids) || asset_ids.length === 0) {
    return json({ error: 'asset_ids must be a non-empty array' }, 400);
  }
  if (asset_ids.length > 200) {
    return json({ error: 'Maximum 200 assets per batch' }, 400);
  }
  if (!operation || typeof operation !== 'object' || !operation.type) {
    return json({ error: 'operation object with type is required' }, 400);
  }

  const supabaseUrl = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return json({ error: 'Server misconfigured' }, 500);
  }

  const headers = {
    'apikey': serviceKey,
    'Authorization': `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  };

  const results = { succeeded: 0, failed: 0, errors: [] };

  // Fetch current assets for tag operations that need current state
  let currentAssets = [];
  if (['add_tags', 'remove_tags'].includes(operation.type)) {
    const idFilter = asset_ids.map(id => `id.eq.${id}`).join(',');
    const fetchRes = await fetch(
      `${supabaseUrl}/rest/v1/assets?or=(${idFilter})&select=id,tags`,
      { headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` } }
    );
    if (fetchRes.ok) currentAssets = await fetchRes.json();
  }

  switch (operation.type) {
    case 'add_tags': {
      const tagsToAdd = operation.tags;
      if (!Array.isArray(tagsToAdd) || tagsToAdd.length === 0) {
        return json({ error: 'operation.tags must be a non-empty array' }, 400);
      }
      for (const id of asset_ids) {
        const asset = currentAssets.find(a => a.id === id);
        const currentTags = asset?.tags || [];
        const newTags = [...new Set([...currentTags, ...tagsToAdd])];
        const res = await fetch(`${supabaseUrl}/rest/v1/assets?id=eq.${id}`, {
          method: 'PATCH', headers: { ...headers, 'Prefer': 'return=minimal' },
          body: JSON.stringify({ tags: newTags }),
        });
        if (res.ok) results.succeeded++; else { results.failed++; results.errors.push(id); }
      }
      break;
    }
    case 'remove_tags': {
      const tagsToRemove = operation.tags;
      if (!Array.isArray(tagsToRemove) || tagsToRemove.length === 0) {
        return json({ error: 'operation.tags must be a non-empty array' }, 400);
      }
      for (const id of asset_ids) {
        const asset = currentAssets.find(a => a.id === id);
        const currentTags = asset?.tags || [];
        const newTags = currentTags.filter(t => !tagsToRemove.includes(t));
        const res = await fetch(`${supabaseUrl}/rest/v1/assets?id=eq.${id}`, {
          method: 'PATCH', headers: { ...headers, 'Prefer': 'return=minimal' },
          body: JSON.stringify({ tags: newTags }),
        });
        if (res.ok) results.succeeded++; else { results.failed++; results.errors.push(id); }
      }
      break;
    }
    case 'replace_tags': {
      const newTags = operation.tags || [];
      const idFilter = asset_ids.map(id => `id.eq.${id}`).join(',');
      const res = await fetch(`${supabaseUrl}/rest/v1/assets?or=(${idFilter})`, {
        method: 'PATCH', headers: { ...headers, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ tags: newTags }),
      });
      if (res.ok) { results.succeeded = asset_ids.length; }
      else { results.failed = asset_ids.length; }
      break;
    }
    case 'set_company': {
      const companyId = operation.company_id ?? null;
      // Fetch current metadata for each asset to preserve other fields
      const idFilter = asset_ids.map(id => `id.eq.${id}`).join(',');
      const fetchRes = await fetch(
        `${supabaseUrl}/rest/v1/assets?or=(${idFilter})&select=id,metadata`,
        { headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` } }
      );
      const assets = fetchRes.ok ? await fetchRes.json() : [];
      for (const id of asset_ids) {
        const asset = assets.find(a => a.id === id);
        const newMeta = { ...(asset?.metadata || {}), company_id: companyId };
        const res = await fetch(`${supabaseUrl}/rest/v1/assets?id=eq.${id}`, {
          method: 'PATCH', headers: { ...headers, 'Prefer': 'return=minimal' },
          body: JSON.stringify({ metadata: newMeta }),
        });
        if (res.ok) results.succeeded++; else { results.failed++; results.errors.push(id); }
      }
      break;
    }
    case 'set_description': {
      const description = operation.description ?? '';
      const idFilter = asset_ids.map(id => `id.eq.${id}`).join(',');
      const res = await fetch(`${supabaseUrl}/rest/v1/assets?or=(${idFilter})`, {
        method: 'PATCH', headers: { ...headers, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ description }),
      });
      if (res.ok) { results.succeeded = asset_ids.length; }
      else { results.failed = asset_ids.length; }
      break;
    }
    case 'link_product': {
      const productId = operation.product_id;
      if (!productId) return json({ error: 'operation.product_id is required' }, 400);
      for (const assetId of asset_ids) {
        const res = await fetch(`${supabaseUrl}/rest/v1/product_assets`, {
          method: 'POST',
          headers: { ...headers, 'Prefer': 'return=minimal' },
          body: JSON.stringify({ product_id: productId, asset_id: assetId }),
        });
        if (res.ok) results.succeeded++; else { results.failed++; results.errors.push(assetId); }
      }
      break;
    }
    case 'unlink_product': {
      const productId = operation.product_id;
      if (!productId) return json({ error: 'operation.product_id is required' }, 400);
      // Find matching junction records
      const idFilter = asset_ids.map(id => `asset_id.eq.${id}`).join(',');
      const jRes = await fetch(
        `${supabaseUrl}/rest/v1/product_assets?product_id=eq.${productId}&or=(${idFilter})&select=id`,
        { headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` } }
      );
      const junctions = jRes.ok ? await jRes.json() : [];
      for (const j of junctions) {
        const res = await fetch(`${supabaseUrl}/rest/v1/product_assets?id=eq.${j.id}`, {
          method: 'DELETE',
          headers: { ...headers, 'Prefer': 'return=minimal' },
        });
        if (res.ok) results.succeeded++; else { results.failed++; }
      }
      break;
    }
    case 'delete': {
      for (const id of asset_ids) {
        // Get asset for r2_key
        const aRes = await fetch(
          `${supabaseUrl}/rest/v1/assets?id=eq.${id}&select=id,r2_key`,
          { headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` } }
        );
        const assets = aRes.ok ? await aRes.json() : [];
        const asset = assets[0];
        if (!asset) { results.failed++; results.errors.push(id); continue; }

        // Delete product_assets junctions
        await fetch(`${supabaseUrl}/rest/v1/product_assets?asset_id=eq.${id}`, {
          method: 'DELETE', headers: { ...headers, 'Prefer': 'return=minimal' },
        }).catch(() => {});

        // Delete from R2
        try { await env.ASSETS_BUCKET.delete(asset.r2_key); } catch {}

        // Delete from Supabase
        const delRes = await fetch(`${supabaseUrl}/rest/v1/assets?id=eq.${id}`, {
          method: 'DELETE', headers: { ...headers, 'Prefer': 'return=minimal' },
        });
        if (delRes.ok) results.succeeded++; else { results.failed++; results.errors.push(id); }
      }
      break;
    }
    default:
      return json({ error: `Unknown operation type: ${operation.type}. Valid types: add_tags, remove_tags, replace_tags, set_company, set_description, link_product, unlink_product, delete` }, 400);
  }

  return json({ ok: true, ...results });
}

async function handleEntityLog(request, env, ctx) {
  const { table, data, returnRow } = await request.json();

  const allowedTables = ['people_log', 'project_updates', 'companies', 'product_content', 'product_assets', 'company_content', 'content', 'persona_log', 'research_log', 'summaries', 'products'];
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

  // Tables where we want fresh rows to be embedded immediately — junction
  // tables (product_content, product_assets, company_content) are not included
  // since they have no standalone text to embed.
  const embeddableLogTables = ['people_log', 'persona_log', 'research_log', 'content', 'summaries', 'companies'];
  const wantsEmbed = embeddableLogTables.includes(table) && env.AI;

  // Always ask for representation when we need the new row's id for embedding,
  // even if the caller didn't request it.
  const needRow = returnRow || wantsEmbed;

  const res = await fetch(
    `${supabaseUrl}/rest/v1/${table}`,
    {
      method: 'POST',
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        'Prefer': needRow ? 'return=representation' : 'return=minimal',
      },
      body: JSON.stringify(data),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    return json({ error: 'Supabase error', detail: text }, res.status);
  }

  let insertedRow = null;
  if (needRow) {
    const rows = await res.json();
    insertedRow = rows[0] || null;
  }

  if (wantsEmbed && insertedRow?.id && ctx) {
    ctx.waitUntil(embedItem(env, table, insertedRow.id).catch(() => {}));
  }

  if (returnRow) {
    return json({ ok: true, row: insertedRow });
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
  if (data[0]?.id && env.AI) {
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

  if (!supabaseUrl || !serviceKey) {
    return json({ error: 'Server misconfigured (Supabase)' }, 500);
  }

  const systemPrompt = type === 'weekly'
    ? buildWeeklySummaryPrompt()
    : buildMonthlySummaryPrompt();

  // Call LLM (with fallback)
  let summaryContent, modelUsed;
  try {
    const result = await callLLM({ env, ctx, feature: 'generate_summary', systemPrompt, userMessage: context_data, maxTokens: 8000, tier: 'balanced' });
    summaryContent = result.text;
    modelUsed = result.model;
    if (!summaryContent) {
      return json({ error: 'Empty response from LLM' }, 500);
    }
  } catch (err) {
    return json({ error: 'AI processing failed', detail: err.message, attempts: err.attempts }, err.status || 502);
  }

  // Upsert to summaries table
  const summaryData = {
    type,
    period_start,
    period_end,
    content: summaryContent,
    metadata: {
      generated_at: new Date().toISOString(),
      model: modelUsed,
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
  if (saved[0]?.id && env.AI) {
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

  if (!supabaseUrl || !serviceKey) {
    return json({ error: 'Server misconfigured (Supabase)' }, 500);
  }

  // 1. Fetch the daily note
  const noteRes = await supabaseGet(supabaseUrl, serviceKey,
    `daily_notes?note_date=eq.${note_date}&limit=1`);
  if (!noteRes.length) {
    return json({ error: 'No daily note found for this date' }, 404);
  }
  const dailyNote = noteRes[0];

  // 2. Fetch context: people, products, projects, attached images
  const [peopleRes, productsRes, projectsRes, imageAssetsRes] = await Promise.all([
    supabaseGet(supabaseUrl, serviceKey, 'people?select=id,name,role,organization&order=name'),
    supabaseGet(supabaseUrl, serviceKey, 'products?select=id,name&order=name'),
    supabaseGet(supabaseUrl, serviceKey, 'projects?select=id,name,product_id&order=name'),
    supabaseGet(supabaseUrl, serviceKey, `assets?metadata->>daily_note_date=eq.${note_date}&select=id,filename,r2_key,mime_type,file_size&order=uploaded_at.asc`),
  ]);

  const peopleNames = peopleRes.map(p => p.name);
  const productNames = productsRes.map(p => p.name);
  const projectNames = projectsRes.map(p => p.name);

  // 2b. Load image content from R2 (cap count + size; filter to supported mime types)
  const imageBlocks = [];
  const includedImages = [];
  const skippedImages = [];
  const bucket = env.ASSETS_BUCKET;
  if (bucket && imageAssetsRes?.length) {
    const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
    const MAX_IMAGES = 20;
    const SUPPORTED = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
    for (const asset of imageAssetsRes) {
      const mime = (asset.mime_type || '').toLowerCase();
      if (!SUPPORTED.has(mime)) {
        skippedImages.push({ id: asset.id, filename: asset.filename, reason: `unsupported mime_type: ${asset.mime_type}` });
        continue;
      }
      if (typeof asset.file_size === 'number' && asset.file_size > MAX_IMAGE_BYTES) {
        skippedImages.push({ id: asset.id, filename: asset.filename, reason: `file_size ${asset.file_size} exceeds 5MB cap` });
        continue;
      }
      if (includedImages.length >= MAX_IMAGES) {
        skippedImages.push({ id: asset.id, filename: asset.filename, reason: `exceeds ${MAX_IMAGES}-image cap` });
        continue;
      }
      try {
        const object = await bucket.get(asset.r2_key);
        if (!object) {
          skippedImages.push({ id: asset.id, filename: asset.filename, reason: 'R2 object missing' });
          continue;
        }
        const buf = await object.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        const b64 = btoa(binary);
        imageBlocks.push({
          type: 'image',
          source: { type: 'base64', media_type: mime, data: b64 },
        });
        includedImages.push({ id: asset.id, filename: asset.filename, mime_type: mime });
      } catch (err) {
        skippedImages.push({ id: asset.id, filename: asset.filename, reason: `R2 read error: ${err.message}` });
      }
    }
  }

  // 2c. Fetch today's + overdue open tasks from the first-class tasks table.
  //     These are passed as JSON blocks to the prompt; the LLM then returns
  //     task_actions (close / reschedule / cancel / create) rather than
  //     parsing markdown bullets. Overdue is its own triage queue — the
  //     model decides per-task rather than bulk-migrating.
  let todaysTasks = [];
  let overdueTasks = [];
  try {
    const orFilter = `or=(due_date.eq.${note_date},and(source_table.eq.daily_notes,source_id.eq.${dailyNote.id}))`;
    todaysTasks = await supabaseGet(supabaseUrl, serviceKey,
      `tasks?${orFilter}&status=in.(todo,doing,blocked)&select=id,title,priority,due_date,source_ref&limit=200&order=priority.asc.nullslast,created_at.asc`);
  } catch (err) {
    todaysTasks = [];
  }
  try {
    overdueTasks = await supabaseGet(supabaseUrl, serviceKey,
      `tasks?due_date=lt.${note_date}&status=in.(todo,doing,blocked)&select=id,title,priority,due_date,source_ref&limit=200&order=due_date.asc,priority.asc.nullslast`);
  } catch (err) {
    overdueTasks = [];
  }

  // 3. Build the prompt
  const systemPrompt = buildReviewSystemPrompt(peopleNames, productNames, projectNames);
  const userPrompt = buildReviewUserPrompt(dailyNote, note_date, includedImages, todaysTasks, overdueTasks);

  // 4. Call LLM — send text + any image blocks (with fallback)
  const userContent = imageBlocks.length
    ? [{ type: 'text', text: userPrompt }, ...imageBlocks]
    : userPrompt;

  let aiResult, modelUsed;
  try {
    const result = await callLLM({
      env,
      ctx,
      feature: 'daily_review',
      systemPrompt,
      messages: [{ role: 'user', content: userContent }],
      maxTokens: 8000,
      tier: 'balanced',
    });
    modelUsed = result.model;
    const responseText = result.text;

    // Extract JSON from response (may be wrapped in ```json blocks)
    const jsonMatch = responseText.match(/```json\s*([\s\S]*?)```/) ||
                      responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return json({ error: 'Could not parse AI response', raw: responseText.substring(0, 2000) }, 500);
    }

    aiResult = JSON.parse(jsonMatch[1] || jsonMatch[0]);
  } catch (err) {
    return json({ error: 'AI processing failed', detail: err.message, attempts: err.attempts }, err.status || 502);
  }

  // 5. Write results to Supabase
  const writeResults = await writeReviewResults(supabaseUrl, serviceKey, note_date, dailyNote, aiResult, peopleRes, productsRes, projectsRes);

  // 6. Create audit record
  await supabasePost(supabaseUrl, serviceKey, 'ai_reviews', {
    review_type: 'daily',
    source_date: note_date,
    status: 'completed',
    input_snapshot: {
      tasks: dailyNote.tasks,
      notes: dailyNote.notes,
      meetings: dailyNote.meetings,
      attached_images: includedImages,
      skipped_images: skippedImages,
    },
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
        task_actions: aiResult.task_actions || [],
        context_notes: aiResult.context_notes || [],
        review_data: aiResult,
        review_writes: writeResults,
      },
    });

  // 8. Execute task_actions against the tasks table. Close/migrate/cancel
  //    existing rows; create new rows linked to this daily note.
  const actionsSummary = await executeTaskActions(
    supabaseUrl, serviceKey,
    aiResult.task_actions || [],
    { dailyNote, note_date }
  );

  // Background re-embed the daily note (now has review_summary)
  if (dailyNote.id && env.AI) {
    ctx.waitUntil(embedItem(env, 'daily_notes', dailyNote.id).catch(() => {}));
  }

  return json({
    ok: true,
    review: aiResult,
    writes: { ...writeResults, actions_summary: actionsSummary },
    todays_tasks: todaysTasks,
  });
}

/**
 * Execute task_actions returned by the end-of-day review against the tasks
 * table. Returns a summary `{closed, migrated, cancelled, created, errors}`.
 */
async function executeTaskActions(supabaseUrl, serviceKey, actions, { dailyNote, note_date }) {
  const summary = { closed: 0, rescheduled: 0, cancelled: 0, created: 0, errors: [] };
  if (!Array.isArray(actions) || !actions.length) return summary;

  const patch = async (id, body) => {
    const res = await fetch(`${supabaseUrl}/rest/v1/tasks?id=eq.${id}`, {
      method: 'PATCH',
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await res.text());
  };

  for (const action of actions) {
    try {
      // Accept legacy "migrate" as a synonym for "reschedule" for backwards
      // compat with any in-flight prompts that still use the old verb.
      const verb = action?.action === 'migrate' ? 'reschedule' : action?.action;
      switch (verb) {
        case 'close':
          if (!action.id) throw new Error('close requires id');
          await patch(action.id, { status: 'done' });
          summary.closed++;
          break;
        case 'reschedule': {
          if (!action.id) throw new Error('reschedule requires id');
          if (!/^\d{4}-\d{2}-\d{2}$/.test(action.due_date || '')) {
            throw new Error('reschedule requires explicit due_date (YYYY-MM-DD)');
          }
          await patch(action.id, { due_date: action.due_date });
          summary.rescheduled++;
          break;
        }
        case 'cancel':
          if (!action.id) throw new Error('cancel requires id');
          await patch(action.id, { status: 'cancelled' });
          summary.cancelled++;
          break;
        case 'create': {
          const title = (action.title || '').trim();
          if (!title) throw new Error('create requires title');
          const body = {
            title,
            status: 'todo',
            priority: ['high', 'medium', 'low'].includes(action.priority) ? action.priority : null,
            due_date: /^\d{4}-\d{2}-\d{2}$/.test(action.due_date || '') ? action.due_date : null,
            source_table: 'daily_notes',
            source_id: dailyNote.id,
            source_ref: `Daily Note ${note_date}`,
            metadata: { created_by: 'daily_review', note_date },
          };
          const res = await fetch(`${supabaseUrl}/rest/v1/tasks`, {
            method: 'POST',
            headers: {
              'apikey': serviceKey,
              'Authorization': `Bearer ${serviceKey}`,
              'Content-Type': 'application/json',
              'Prefer': 'return=minimal',
            },
            body: JSON.stringify(body),
          });
          if (!res.ok) throw new Error(await res.text());
          summary.created++;
          break;
        }
        default:
          throw new Error(`unknown action: ${action?.action}`);
      }
    } catch (err) {
      summary.errors.push({ action, detail: (err?.message || String(err)).slice(0, 300) });
    }
  }
  return summary;
}

function buildReviewSystemPrompt(peopleNames, productNames, projectNames) {
  return `You are Paul Land's end-of-day review assistant. Paul is a Domain Lead (Packaging Job Lifecycle) and Product Manager (WebCenter Pack) at Esko.

Your job is to process his daily note and extract structured information into a JSON response. You must identify:

1. **People entries**: Notes about specific people from meetings and notes sections ONLY. Do NOT extract people entries from tasks — tasks are action items, not observations. Only extract people entries when there is a genuine observation, decision, or insight about that person from a meeting or note.
2. **Product evidence**: Evidence, learnings, or feedback about specific products.
3. **Product decisions**: Decisions made about products (strategic, not tactical).
4. **Project updates**: Updates about specific projects.
5. **Reflections**: Leadership observations, coaching insights, self-awareness moments.
6. **Task actions**: For each task in \`tasks_for_today\`, decide what should happen to it. Triage every task in \`overdue_tasks\` with an explicit decision (close, cancel, or reschedule to a specific date). Optionally propose new tasks from action items mentioned in notes/meetings.
7. **Context notes**: Key context from today that would help prepare for tomorrow's meetings.

## Known People
${peopleNames.join(', ')}

## Known Products
${productNames.join(', ')}

## Known Projects
${projectNames.join(', ')}

## Task Actions
Tasks are first-class rows. The user prompt provides two JSON arrays:
- \`tasks_for_today\` — tasks due today or sourced from this note
- \`overdue_tasks\` — open tasks with a due_date earlier than today

For each task, return a \`task_actions\` entry. Allowed actions:
- \`close\` — notes/meetings clearly indicate the task was completed today.
- \`reschedule\` — the task needs to move. **Always include an explicit \`due_date\` (YYYY-MM-DD).** Pick a realistic date per task based on the notes — do not bulk-bump everything to tomorrow. Overdue tasks stay overdue and visible until explicitly acted on.
- \`cancel\` — the task is no longer relevant or was abandoned.
- Omit the task entirely from \`task_actions\` if it's still actively in progress with no clear signal.

Be conservative with \`close\` — only when completion is explicit. Prefer leaving an overdue task alone over blindly rescheduling it; the overdue section is designed to stay visible as a triage queue.

You may also propose \`create\` actions for clearly actionable new items mentioned in the notes/meetings — e.g. "I said I'd send Geert the timeline" or "Need to draft the Q3 plan by Friday". Only create when the action is unambiguous; don't invent tasks from vague intent.

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
  "task_actions": [
    { "id": "<uuid-from-tasks_for_today-or-overdue_tasks>", "action": "close" },
    { "id": "<uuid-from-tasks_for_today-or-overdue_tasks>", "action": "reschedule", "due_date": "YYYY-MM-DD" },
    { "id": "<uuid-from-tasks_for_today-or-overdue_tasks>", "action": "cancel" },
    { "action": "create", "title": "New task title", "priority": "high|medium|low", "due_date": "YYYY-MM-DD" }
  ],
  "context_notes": [
    { "meeting_title": "Meeting name", "context": "Key context for tomorrow" }
  ],
  "review_summary": "2-3 sentence summary of the day's key outcomes and themes"
}

IMPORTANT:
- Only include entries where there is genuine content to extract. Empty arrays are fine.
- For task_actions, use the exact \`id\` from \`tasks_for_today\` or \`overdue_tasks\` — copy it verbatim. Do not invent ids.
- Match person/product/project names EXACTLY to the known lists above. If unsure, use the closest match.
- Keep entries concise but complete. Each entry should stand on its own without needing the daily note for context.
- The review_summary should capture the day's themes, not list every meeting.
- CRITICAL: Do NOT create people entries from tasks. Tasks like "Follow up with X" or "Speak to Y about Z" are action items, not observations. People entries should ONLY come from actual meeting notes, conversations, or written observations.`;
}

function buildReviewUserPrompt(dailyNote, noteDate, attachedImages = [], todaysTasks = [], overdueTasks = []) {
  let prompt = `## Daily Note for ${noteDate}\n\n`;

  // Tasks come from the first-class `tasks` table. Render as JSON arrays so
  // the model can cite ids verbatim in task_actions. Overdue tasks are a
  // separate triage queue — the model should decide per-task whether to
  // close/cancel/reschedule or leave visible.
  prompt += `### Tasks for today (JSON)\n`;
  prompt += Array.isArray(todaysTasks) && todaysTasks.length
    ? '```json\n' + JSON.stringify(todaysTasks, null, 2) + '\n```\n\n'
    : '(no open tasks for this day)\n\n';

  prompt += `### Overdue tasks (JSON) — triage each\n`;
  prompt += Array.isArray(overdueTasks) && overdueTasks.length
    ? '```json\n' + JSON.stringify(overdueTasks, null, 2) + '\n```\n\n'
    : '(no overdue open tasks)\n\n';

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

  if (attachedImages.length > 0) {
    prompt += `### Attached Images\n${attachedImages.length} image(s) are attached to this daily note and appear as separate content blocks following this text. Read any visible text (handwriting, chat screenshots, whiteboards, diagrams) and treat it as first-class source material alongside the typed notes. When an image materially contributes to an entry, cite it as [image: filename] in the relevant field.\n\n`;
    attachedImages.forEach((img, i) => {
      prompt += `- Image ${i + 1}: ${img.filename}\n`;
    });
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
  const dailyNoteDateRaw = formData.get('daily_note_date') || '';
  const dailyNoteDate = /^\d{4}-\d{2}-\d{2}$/.test(dailyNoteDateRaw) ? dailyNoteDateRaw : null;

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
    metadata: dailyNoteDate ? { daily_note_date: dailyNoteDate } : {},
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

async function handleAssetContent(assetId, env) {
  const bucket = env.ASSETS_BUCKET;
  if (!bucket) return json({ error: 'R2 bucket not configured' }, 500);

  const supabaseUrl = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_KEY;

  // Look up asset record
  const assets = await supabaseGet(supabaseUrl, serviceKey, `assets?id=eq.${assetId}&select=id,filename,r2_key,mime_type`);
  if (!assets.length) return json({ error: 'Asset not found' }, 404);

  const asset = assets[0];
  const object = await bucket.get(asset.r2_key);
  if (!object) return json({ error: 'File not found in R2' }, 404);

  const mime = asset.mime_type || 'application/octet-stream';
  const isText = mime === 'text/csv' || mime === 'text/tab-separated-values' || mime === 'text/plain';

  if (isText) {
    const text = await object.text();
    return json({ filename: asset.filename, mime_type: mime, encoding: 'text', content: text });
  }

  // Binary files (xlsx etc) — return as base64
  const buf = await object.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const b64 = btoa(binary);
  return json({ filename: asset.filename, mime_type: mime, encoding: 'base64', content: b64 });
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
    case 'people_log': {
      const p = row.person || {};
      const parts = [];
      if (p.name) {
        const bits = [p.name];
        if (p.role) bits.push(p.role);
        if (p.organization) bits.push(p.organization);
        parts.push(`Note about ${bits.join(', ')}`);
      } else {
        parts.push(`People Note`);
      }
      parts.push(`(${row.note_date}): ${row.entry || ''}`);
      return parts.join(' ');
    }
    case 'product_evidence':
      return `Product Evidence (${row.note_date}, ${row.evidence_type || 'observation'}): ${row.evidence || ''}`;
    case 'product_decisions':
      return `Decision (${row.note_date}): ${row.decision || ''}\nContext: ${row.context || ''}`;
    case 'reflections_log':
      return `Reflection (${row.note_date}, ${row.category || 'leadership'}): ${row.observation || ''}\nCoach: ${row.coach_perspective || ''}`;
    case 'tasks': {
      const parts = [`Task: ${row.title || '(untitled)'}`];
      if (row.status) parts.push(`Status: ${row.status}`);
      if (row.priority) parts.push(`Priority: ${row.priority}`);
      if (row.due_date) parts.push(`Due: ${row.due_date}`);
      if (row.description) parts.push(row.description);
      if (row.source_ref) parts.push(`Source: ${row.source_ref}`);
      if (row.tags?.length) parts.push(`Tags: ${row.tags.join(', ')}`);
      return parts.join('\n');
    }
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
      meta.title = row.person?.name
        ? `Note about ${row.person.name}`
        : `People Note`;
      meta.date = row.note_date;
      if (row.person?.name) meta.person_name = row.person.name;
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
    case 'tasks':
      meta.title = row.title || 'Task';
      meta.date = row.due_date || '';
      if (row.status) meta.status = row.status;
      if (row.priority) meta.priority = row.priority;
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

  // Hard-split any paragraph bigger than maxChars so no single chunk can exceed
  // the embedding model's per-input token cap (BGE-base: 512 tokens ≈ 2 KB).
  const rawParagraphs = body.split(/\n\n+/);
  const paragraphs = [];
  for (const para of rawParagraphs) {
    if (para.length <= maxChars) {
      paragraphs.push(para);
    } else {
      for (let i = 0; i < para.length; i += maxChars) {
        paragraphs.push(para.substring(i, i + maxChars));
      }
    }
  }

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
 * Generate embeddings for an array of texts via the Workers AI binding.
 *
 * Sub-batches the call to stay under the model's per-request limits:
 * @cf/baai/bge-base-en-v1.5 caps each input at 512 tokens and each batch at
 * ~153,600 tokens. A conservative ceiling (80 inputs / ~90k est-tokens) keeps
 * us well clear of the 5021 "context window exceeded" error that fires when
 * one fat item produces 300+ chunks.
 */
async function generateEmbeddings(env, texts) {
  if (!env.AI) {
    await logAiError(env, { provider: 'cloudflare_ai', model: '@cf/baai/bge-base-en-v1.5', endpoint: 'embed', status: null, message: 'AI binding not available' });
    throw new Error('Workers AI binding not configured on this Pages project');
  }

  const MAX_SUB_INPUTS = 80;
  const MAX_SUB_CHARS = 360_000; // ≈ 90,000 est-tokens @ 4 chars/token
  const out = [];

  let i = 0;
  while (i < texts.length) {
    const subBatch = [];
    let subChars = 0;
    while (
      i < texts.length &&
      subBatch.length < MAX_SUB_INPUTS &&
      (subBatch.length === 0 || subChars + texts[i].length <= MAX_SUB_CHARS)
    ) {
      subBatch.push(texts[i]);
      subChars += texts[i].length;
      i++;
    }

    try {
      const result = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: subBatch });
      if (!result?.data) throw new Error('Unexpected AI binding response: no data');
      out.push(...result.data);
    } catch (e) {
      await logAiError(env, { provider: 'cloudflare_ai', model: '@cf/baai/bge-base-en-v1.5', endpoint: 'embed', status: null, message: e?.message || 'AI binding threw' });
      throw e;
    }
  }

  return out;
}

/**
 * Query Cloudflare Vectorize via env.VECTORIZE binding, return results in the
 * same shape handlers used to get from the Postgres search_embeddings RPC.
 *
 * Similarity-threshold + date/tag post-filters stay client-side so search
 * behaviour is unchanged from the caller's perspective.
 */
async function searchVectorize(env, queryEmbedding, { tables, matchCount, threshold = 0.3 } = {}) {
  if (!env.VECTORIZE) throw new Error('VECTORIZE binding not configured on this Pages project');

  const filter = Array.isArray(tables) && tables.length
    ? (tables.length === 1
        ? { source_table: { $eq: tables[0] } }
        : { source_table: { $in: tables } })
    : undefined;

  const res = await env.VECTORIZE.query(queryEmbedding, {
    topK: matchCount,
    returnMetadata: 'all',
    returnValues: false,
    filter,
  });

  const matches = (res?.matches || []).filter(m => (m.score || 0) >= threshold);
  return matches.map(m => {
    const md = m.metadata || {};
    return {
      source_table: md.source_table,
      source_id: md.source_id,
      chunk_index: md.chunk_index,
      content_text: md.text || '',
      similarity: m.score,
      metadata: {
        title: md.title || '',
        type: md.type || '',
        date: md.date || '',
      },
    };
  });
}

/**
 * Query the Cloudflare AI Search instance indexing our knowledge-capture R2
 * bucket. Returns PDF / DOCX / PPTX / text hits from the asset library —
 * content that's invisible to searchVectorize because asset file bodies are
 * not in Vectorize.
 *
 * Normalises results to the same shape searchVectorize returns, with
 * source_table='assets' and source_id set to the UUID of the matching
 * `assets` row (resolved via r2_key = item.key). Chunks whose r2_key can't
 * be mapped back to an assets row are dropped so the UI source panel always
 * has a real row to display.
 *
 * Graceful degradation: if CF_ACCOUNT_ID / CF_AI_SEARCH_API_TOKEN /
 * AI_SEARCH_INSTANCE_ID are not set, returns []. Network / auth errors
 * are logged and swallowed so Ask continues to work without the asset
 * channel.
 */
async function searchAssetLibrary(env, query, { matchCount = 5, threshold = 0.3 } = {}) {
  if (!env.CF_ACCOUNT_ID || !env.CF_AI_SEARCH_API_TOKEN || !env.AI_SEARCH_INSTANCE_ID) {
    return [];
  }
  if (!query || typeof query !== 'string') return [];

  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai-search/instances/${env.AI_SEARCH_INSTANCE_ID}/search`;
  const body = {
    query,
    ai_search_options: {
      retrieval: {
        retrieval_type: 'hybrid',
        max_num_results: matchCount,
        match_threshold: threshold,
      },
    },
  };

  let json;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.CF_AI_SEARCH_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      await logAiError(env, {
        provider: 'cloudflare-ai-search',
        endpoint: 'search',
        status: res.status,
        message: text.slice(0, 500),
      });
      return [];
    }
    json = await res.json();
  } catch (err) {
    await logAiError(env, {
      provider: 'cloudflare-ai-search',
      endpoint: 'search',
      message: err?.message || String(err),
    });
    return [];
  }

  const chunks = json?.result?.chunks || [];
  if (!chunks.length) return [];

  const r2Keys = Array.from(new Set(chunks.map(c => c?.item?.key).filter(Boolean)));
  if (!r2Keys.length) return [];

  let assetRows = [];
  try {
    const keysParam = r2Keys.map(k => `"${encodeURIComponent(k)}"`).join(',');
    assetRows = await supabaseGet(
      env.SUPABASE_URL,
      env.SUPABASE_SERVICE_KEY,
      `assets?select=id,r2_key,filename,mime_type,uploaded_at&r2_key=in.(${keysParam})`,
    );
  } catch {
    return [];
  }
  const byKey = new Map(assetRows.map(a => [a.r2_key, a]));

  return chunks
    .map((c, i) => {
      const key = c?.item?.key;
      const asset = key ? byKey.get(key) : null;
      if (!asset) return null;
      const title = asset.filename || key || 'Asset';
      const date = asset.uploaded_at ? String(asset.uploaded_at).slice(0, 10) : '';
      return {
        source_table: 'assets',
        source_id: asset.id,
        chunk_index: typeof c.id === 'string' ? i : (c.id ?? i),
        content_text: c.text || '',
        similarity: typeof c.score === 'number' ? c.score : 0,
        metadata: {
          title,
          type: asset.mime_type || 'application/octet-stream',
          date,
          r2_key: key,
        },
      };
    })
    .filter(Boolean);
}

// ─── AI usage error logging ──────────────────────────────────
// Best-effort insert into ai_usage_errors; never throws so it can't cascade
// and break the caller. The admin topbar badge polls this table on load.

async function logAiError(env, { provider, model, endpoint, status, message }) {
  try {
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) return;
    await fetch(`${env.SUPABASE_URL}/rest/v1/ai_usage_errors`, {
      method: 'POST',
      headers: {
        'apikey': env.SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({
        provider: provider || 'unknown',
        model: model || null,
        endpoint: endpoint || null,
        status: Number.isFinite(status) ? status : null,
        message: (message || '').toString().slice(0, 2000),
      }),
    });
  } catch {
    // Never let logging break the caller
  }
}

// ─── LLM usage event logging (cost + quality) ────────────────
// Per-call row in `usage_events`. Fire-and-forget via ctx.waitUntil where
// possible. Cost estimates are computed at write-time from the model name +
// token counts so the dashboard can render USD without re-pricing on read.
//
// Pricing per million tokens. Update when Anthropic changes prices.
const USAGE_PRICING = {
  // Anthropic — input / output / cache_write / cache_read
  'claude-opus-4-7':   { in: 15.00, out: 75.00, cw: 18.75, cr: 1.50 },
  'claude-sonnet-4-6': { in:  3.00, out: 15.00, cw:  3.75, cr: 0.30 },
  'claude-haiku-4-5':  { in:  1.00, out:  5.00, cw:  1.25, cr: 0.10 },
  // Cloudflare Workers AI (embeddings) — effectively free at this volume
  '@cf/baai/bge-base-en-v1.5': { in: 0, out: 0, cw: 0, cr: 0 },
};

function estimateCost(model, { tokens_in = 0, tokens_out = 0, cache_creation_tokens = 0, cache_read_tokens = 0 } = {}) {
  if (!model) return 0;
  // Match by prefix so model IDs with date suffixes (e.g. 'claude-haiku-4-5-20251001') still hit
  const key = Object.keys(USAGE_PRICING).find(k => model.startsWith(k));
  if (!key) return 0;
  const p = USAGE_PRICING[key];
  const cost =
    (tokens_in              * p.in  / 1_000_000) +
    (tokens_out             * p.out / 1_000_000) +
    (cache_creation_tokens  * p.cw  / 1_000_000) +
    (cache_read_tokens      * p.cr  / 1_000_000);
  return Math.round(cost * 1_000_000) / 1_000_000; // 6dp, matches column scale
}

async function logUsageEvent(env, ctx, {
  surface = 'api',
  feature,
  prompt_id = null,
  prompt_version = null,
  model = null,
  tokens_in = 0,
  tokens_out = 0,
  cache_creation_tokens = 0,
  cache_read_tokens = 0,
  output_excerpt = null,
  duration_ms = null,
  error = null,
  metadata = null,
  request_id = null,
} = {}) {
  // Note: we deliberately *await* the write rather than using ctx.waitUntil.
  // In streaming handlers the waitUntil pattern can be reaped silently when
  // writer.close() finalises the response body before the Supabase fetch
  // completes. A 50–100ms synchronous insert is negligible compared to the
  // LLM call we just made, and it guarantees the row lands.
  try {
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY || !feature) return;
    const cost_est = estimateCost(model, { tokens_in, tokens_out, cache_creation_tokens, cache_read_tokens });
    await fetch(`${env.SUPABASE_URL}/rest/v1/usage_events`, {
      method: 'POST',
      headers: {
        'apikey': env.SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({
        surface,
        feature,
        prompt_id,
        prompt_version,
        model,
        tokens_in,
        tokens_out,
        cache_creation_tokens,
        cache_read_tokens,
        cost_est,
        output_excerpt: output_excerpt ? String(output_excerpt).slice(0, 200) : null,
        duration_ms: Number.isFinite(duration_ms) ? duration_ms : null,
        error: error ? String(error).slice(0, 500) : null,
        metadata: metadata && typeof metadata === 'object' ? metadata : null,
        request_id,
      }),
    });
  } catch {
    // Never let logging break the caller
  }
}

// Pull token counts from an Anthropic non-streaming response in one place.
function extractAnthropicUsage(responseJson) {
  const u = responseJson?.usage || {};
  return {
    tokens_in:             Number(u.input_tokens) || 0,
    tokens_out:            Number(u.output_tokens) || 0,
    cache_creation_tokens: Number(u.cache_creation_input_tokens) || 0,
    cache_read_tokens:     Number(u.cache_read_input_tokens) || 0,
  };
}

function isAuthOrQuotaSignal(status, message) {
  if (!status && !message) return false;
  if (status === 401 || status === 402 || status === 403 || status === 429) return true;
  if (status >= 500 && status < 600) return true;
  if (message && /quota|credit|rate.?limit|overloaded|invalid.?api.?key|authentication|neuron/i.test(message)) return true;
  return false;
}

// ─── Tasks handlers ──────────────────────────────────────────

const TASK_ALLOWED_STATUS = new Set(['todo', 'doing', 'done', 'blocked', 'cancelled']);
const TASK_ALLOWED_PRIORITY = new Set(['high', 'medium', 'low']);
const TASK_UPDATABLE_FIELDS = new Set(['title', 'description', 'status', 'priority', 'due_date', 'source_table', 'source_id', 'source_ref', 'tags', 'metadata']);

function buildTaskPatch(input) {
  const patch = {};
  for (const [k, v] of Object.entries(input || {})) {
    if (!TASK_UPDATABLE_FIELDS.has(k)) continue;
    if (k === 'status' && v !== null && !TASK_ALLOWED_STATUS.has(v)) {
      throw new Error(`Invalid status: ${v}. Must be one of ${[...TASK_ALLOWED_STATUS].join(', ')}`);
    }
    if (k === 'priority' && v !== null && !TASK_ALLOWED_PRIORITY.has(v)) {
      throw new Error(`Invalid priority: ${v}. Must be one of ${[...TASK_ALLOWED_PRIORITY].join(', ')}`);
    }
    patch[k] = v;
  }
  return patch;
}

/**
 * GET /api/tasks?status=open|todo|done|all&due=today|week|overdue|upcoming|undated&source_table=...&source_id=...&tag=...&limit=50
 */
async function handleTasksList(request, env) {
  const supabaseUrl = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !serviceKey) return json({ error: 'Server misconfigured' }, 500);

  const url = new URL(request.url);
  const status = url.searchParams.get('status') || 'open';    // open | todo | doing | blocked | done | all
  const due = url.searchParams.get('due');                     // today | week | overdue | upcoming | undated | anytime
  const sourceTable = url.searchParams.get('source_table');
  const sourceId = url.searchParams.get('source_id');
  const tag = url.searchParams.get('tag');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '200', 10) || 200, 500);
  const clientDate = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('client_date') || '')
    ? url.searchParams.get('client_date')
    : new Date().toISOString().slice(0, 10);

  const filters = [];
  if (status === 'open') filters.push('status=not.in.(done,cancelled)');
  else if (status !== 'all' && TASK_ALLOWED_STATUS.has(status)) filters.push(`status=eq.${status}`);

  if (due === 'today') filters.push(`due_date=eq.${clientDate}`);
  else if (due === 'week') {
    const d = new Date(clientDate + 'T00:00:00Z');
    const dow = d.getUTCDay();
    const toMon = dow === 0 ? -6 : 1 - dow;
    const monday = isoAddDays(clientDate, toMon);
    const sunday = isoAddDays(monday, 6);
    filters.push(`due_date=gte.${monday}`);
    filters.push(`due_date=lte.${sunday}`);
  } else if (due === 'overdue') {
    filters.push(`due_date=lt.${clientDate}`);
    filters.push('status=not.in.(done,cancelled)');
  } else if (due === 'upcoming') {
    filters.push(`due_date=gt.${clientDate}`);
  } else if (due === 'undated') {
    filters.push('due_date=is.null');
    filters.push('status=not.in.(done,cancelled)');
  }

  if (sourceTable) filters.push(`source_table=eq.${encodeURIComponent(sourceTable)}`);
  if (sourceId) filters.push(`source_id=eq.${encodeURIComponent(sourceId)}`);
  if (tag) filters.push(`tags=cs.{${encodeURIComponent(tag)}}`);

  // Sort: open tasks by due_date nulls last then priority; all tasks by updated_at desc otherwise
  const order = status === 'open' || due
    ? 'due_date.asc.nullslast,priority.asc.nullslast,created_at.desc'
    : 'updated_at.desc';
  const query = `tasks?${filters.join('&')}${filters.length ? '&' : ''}order=${order}&limit=${limit}`;

  try {
    const rows = await supabaseGet(supabaseUrl, serviceKey, query);
    return json({ ok: true, tasks: rows });
  } catch (err) {
    // Table missing → return empty list so the UI degrades gracefully pre-migration
    if (/relation.*does not exist|Could not find the table/i.test(err.message || '')) {
      return json({ ok: true, tasks: [], missing: true });
    }
    return json({ error: 'Failed to list tasks', detail: err.message }, 500);
  }
}

async function handleTaskGet(id, env) {
  const supabaseUrl = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_KEY;
  const rows = await supabaseGet(supabaseUrl, serviceKey, `tasks?id=eq.${id}&limit=1`);
  return json({ ok: true, task: rows[0] || null });
}

async function handleTaskCreate(request, env, ctx) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  if (!body?.title || typeof body.title !== 'string') {
    return json({ error: 'title is required' }, 400);
  }
  const supabaseUrl = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_KEY;
  let patch;
  try { patch = buildTaskPatch(body); } catch (err) { return json({ error: err.message }, 400); }
  patch.title = body.title;
  if (!patch.status) patch.status = 'todo';

  const res = await fetch(`${supabaseUrl}/rest/v1/tasks`, {
    method: 'POST',
    headers: {
      'apikey': serviceKey,
      'Authorization': `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    },
    body: JSON.stringify(patch),
  });
  if (!res.ok) return json({ error: 'Failed to create', detail: await res.text() }, res.status);
  const rows = await res.json();
  const task = rows[0] || null;
  if (task?.id && env.AI) {
    ctx?.waitUntil(embedItem(env, 'tasks', task.id).catch(() => {}));
  }
  return json({ ok: true, task });
}

async function handleTaskUpdate(id, request, env, ctx) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const supabaseUrl = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_KEY;
  let patch;
  try { patch = buildTaskPatch(body); } catch (err) { return json({ error: err.message }, 400); }
  if (!Object.keys(patch).length) return json({ error: 'No updatable fields supplied' }, 400);

  const res = await fetch(`${supabaseUrl}/rest/v1/tasks?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      'apikey': serviceKey,
      'Authorization': `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    },
    body: JSON.stringify(patch),
  });
  if (!res.ok) return json({ error: 'Failed to update', detail: await res.text() }, res.status);
  const rows = await res.json();
  const task = rows[0] || null;
  // Re-embed if text fields changed (title/description/tags/etc)
  if (task?.id && env.AI && ('title' in patch || 'description' in patch || 'tags' in patch || 'priority' in patch || 'due_date' in patch)) {
    ctx?.waitUntil(embedItem(env, 'tasks', task.id).catch(() => {}));
  }
  return json({ ok: true, task });
}

async function handleTaskComplete(id, env, ctx) {
  return handleTaskUpdate(id, new Request('http://x/', {
    method: 'PATCH',
    body: JSON.stringify({ status: 'done' }),
  }), env, ctx);
}

async function handleTaskDelete(id, env) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/tasks?id=eq.${id}`, {
    method: 'DELETE',
    headers: {
      'apikey': env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Prefer': 'return=minimal',
    },
  });
  if (!res.ok) return json({ error: 'Failed to delete', detail: await res.text() }, res.status);
  return json({ ok: true });
}


/**
 * GET /api/usage-errors?window=24h — list unresolved AI usage errors from the
 * last window and return a count + the most recent 20 rows for the badge UI.
 */
async function handleListUsageErrors(request, env) {
  const supabaseUrl = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !serviceKey) return json({ error: 'Server misconfigured' }, 500);

  const url = new URL(request.url);
  const windowParam = url.searchParams.get('window') || '24h';
  const hours = windowParam.endsWith('h') ? parseInt(windowParam, 10) : 24;
  const since = new Date(Date.now() - hours * 3600_000).toISOString();

  const res = await fetch(
    `${supabaseUrl}/rest/v1/ai_usage_errors?resolved_at=is.null&created_at=gte.${since}&order=created_at.desc&limit=20`,
    {
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Prefer': 'count=exact',
      },
    }
  );
  if (!res.ok) {
    const txt = await res.text();
    // Common case: table doesn't exist yet — degrade gracefully with an empty list
    if (res.status === 404 || /relation.*does not exist|Could not find the table/i.test(txt)) {
      return json({ ok: true, count: 0, errors: [], missing: true });
    }
    return json({ error: 'Failed to load', detail: txt }, res.status);
  }
  const errors = await res.json();
  const countHeader = res.headers.get('content-range') || '';
  const total = parseInt(countHeader.split('/')[1], 10);
  return json({ ok: true, count: Number.isFinite(total) ? total : errors.length, errors });
}

/**
 * POST /api/usage-errors/:id/resolve — mark a single error as resolved.
 */
async function handleResolveUsageError(id, env) {
  const supabaseUrl = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !serviceKey) return json({ error: 'Server misconfigured' }, 500);
  const res = await fetch(
    `${supabaseUrl}/rest/v1/ai_usage_errors?id=eq.${id}`,
    {
      method: 'PATCH',
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({ resolved_at: new Date().toISOString() }),
    }
  );
  if (!res.ok) return json({ error: 'Failed to resolve', detail: await res.text() }, res.status);
  return json({ ok: true });
}

/**
 * Embed a single item: fetch row, build text, generate embeddings, upsert.
 */
async function embedItem(env, sourceTable, sourceId) {
  const supabaseUrl = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_KEY;

  // Fetch the source row. For log tables, expand the related entity so
  // the embedded text can include the subject's name (e.g. people_log needs
  // the person's name for semantic matching on "Who is X?" queries).
  const selectExpr = sourceTable === 'people_log'
    ? '*,person:person_id(name,role,organization,tags)'
    : '*';
  const rows = await supabaseGet(supabaseUrl, serviceKey,
    `${sourceTable}?id=eq.${sourceId}&select=${encodeURIComponent(selectExpr)}&limit=1`);
  if (!rows.length) return { ok: false, error: 'Row not found' };
  const row = rows[0];

  // Build text to embed
  const rawText = buildEmbeddingText(sourceTable, row);
  if (!rawText || rawText.length < 10) return { ok: false, error: 'Insufficient text' };

  // Cap runaway rows: an 80 KB ceiling keeps one item under ~40 chunks / 10k
  // neurons. Anything larger is almost certainly a PDF dump or bulk import
  // where marginal recall doesn't justify the embed cost.
  const MAX_EMBED_CHARS = 80_000;
  const fullText = rawText.length > MAX_EMBED_CHARS ? rawText.substring(0, MAX_EMBED_CHARS) : rawText;

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

  if (!env.VECTORIZE) {
    return { ok: false, error: 'VECTORIZE binding not configured on this Pages project' };
  }

  // Clear the full chunk range for this source (deleteByIds tolerates missing
  // IDs) so a re-embed that shrinks chunk count doesn't leave orphans.
  const MAX_CHUNKS = 40;
  const staleIds = [];
  for (let i = 0; i < MAX_CHUNKS; i++) {
    staleIds.push(`${sourceTable}:${sourceId}:${i}`);
  }

  const vectors = chunks.map((chunk, i) => ({
    id: `${sourceTable}:${sourceId}:${chunk.chunkIndex}`,
    values: embeddings[i],
    metadata: {
      source_table: sourceTable,
      source_id: sourceId,
      chunk_index: chunk.chunkIndex,
      type: metadata.type || '',
      date: metadata.date || '',
      title: metadata.title || '',
      text: chunk.text,
    },
  }));

  try {
    await env.VECTORIZE.deleteByIds(staleIds);
    await env.VECTORIZE.upsert(vectors);
  } catch (err) {
    return { ok: false, error: `Vectorize write error: ${err.message}` };
  }

  await supabasePatch(supabaseUrl, serviceKey,
    `${sourceTable}?id=eq.${sourceId}`,
    { embedded_at: new Date().toISOString() }
  );

  return { ok: true, chunks: chunks.length };
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
    { table: 'tasks', idCol: 'id' },
  ];

  const MAX_ITEMS = 6; // ~5 subrequests each = ~30 + overhead, stays under 50 limit
  const CONSECUTIVE_FAILURE_LIMIT = 3; // halt early when provider is down/out of quota
  const results = {};
  let remaining = false;
  let totalProcessed = 0;
  let consecutiveFailures = 0;
  let halted = false;
  let haltReason = null;

  outer: for (const config of tableConfigs) {
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

      let result;
      try {
        result = await embedItem(env, config.table, row.id);
      } catch (e) {
        result = { ok: false, error: e?.message || 'threw' };
      }

      if (result.ok) {
        count++;
        totalProcessed++;
        consecutiveFailures = 0;
      } else {
        consecutiveFailures++;
        // If several items in a row can't be embedded, it's almost certainly
        // the provider (quota / auth / outage), not the individual row.
        // Stop and tell the caller to back off.
        if (consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
          halted = true;
          haltReason = result.error || 'embedItem returned !ok';
          remaining = true;
          break outer;
        }
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

  return json({ ok: true, embedded: results, remaining, totalProcessed, halted, haltReason });
  } catch (err) {
    return json({ error: 'Embed batch failed: ' + err.message }, 500);
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

  let results;
  try {
    results = await searchVectorize(env, queryEmbedding, { tables, matchCount: fetchCount });
  } catch (err) {
    return json({ error: 'Search failed', detail: err.message }, 500);
  }

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
async function handleAsk(request, env, ctx) {
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

  // 2. Search in parallel across two channels:
  //    - Vectorize: structured rows (content, daily_notes, summaries, …)
  //    - AI Search: R2 asset bodies (PDF, DOCX, etc) — no-op if env unset
  const fetchCount = hasFilters ? 24 : 8;
  const assetMatchCount = hasFilters ? 12 : 5;
  const wantAssets = !tables || tables.includes('assets');
  let searchResults, assetResults;
  try {
    const [vec, ast] = await Promise.all([
      searchVectorize(env, queryEmbedding, { tables, matchCount: fetchCount }),
      wantAssets ? searchAssetLibrary(env, question, { matchCount: assetMatchCount }) : Promise.resolve([]),
    ]);
    searchResults = vec;
    assetResults = ast;
  } catch (err) {
    return json({ error: 'Search failed', detail: err.message }, 500);
  }

  if (hasFilters) {
    searchResults = filterSearchResults(searchResults, { date_from, date_to, tags }).slice(0, 8);
    assetResults = filterSearchResults(assetResults, { date_from, date_to, tags }).slice(0, 5);
  }

  searchResults = [...searchResults, ...assetResults];

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

  const systemPrompt = `You are Jasper, a personal knowledge assistant for Paul Land, a Domain Lead (Packaging Job Lifecycle) and Product Manager (WebCenter Pack) at Esko. If asked who you are, introduce yourself as Jasper.

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

  // 4. Call LLM (with fallback)
  let answer, modelUsed, fallback;
  try {
    const result = await callLLM({ env, ctx, feature: 'ask', systemPrompt, userMessage, maxTokens: 4000, tier: 'balanced' });
    answer = result.text;
    modelUsed = result.model;
    fallback = result.fallback;
  } catch (err) {
    return json({ error: 'AI processing failed', detail: err.message, attempts: err.attempts }, err.status || 502);
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

  return json({ ok: true, answer, sources, model: modelUsed, fallback });
}

// ─── Time-aware intent resolution (for meeting/task questions) ───
// Semantic RAG alone can't answer "what meetings do I have tomorrow?" because
// (a) calendar_events aren't embedded and (b) vector search has no date math.
// These helpers detect intent + a date range, then fetch calendar_events and
// daily_notes directly as authoritative structured context for the LLM.

function isoAddDays(isoDate, n) {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function resolveTimeRange(q, today) {
  if (/\btomorrow\b/.test(q)) return { from: isoAddDays(today, 1), to: isoAddDays(today, 1), label: 'tomorrow' };
  if (/\byesterday\b/.test(q)) return { from: isoAddDays(today, -1), to: isoAddDays(today, -1), label: 'yesterday' };
  if (/\btoday\b/.test(q) || /\bright now\b/.test(q)) return { from: today, to: today, label: 'today' };
  if (/\bthis\s+week\b/.test(q)) {
    const d = new Date(today + 'T00:00:00Z');
    const dow = d.getUTCDay(); // 0=Sun
    const daysToMon = dow === 0 ? -6 : 1 - dow;
    const from = isoAddDays(today, daysToMon);
    return { from, to: isoAddDays(from, 6), label: 'this week' };
  }
  if (/\bnext\s+week\b/.test(q)) {
    const d = new Date(today + 'T00:00:00Z');
    const dow = d.getUTCDay();
    const daysToNextMon = dow === 0 ? 1 : 8 - dow;
    const from = isoAddDays(today, daysToNextMon);
    return { from, to: isoAddDays(from, 6), label: 'next week' };
  }
  const weekdayMatch = q.match(/\b(?:on\s+|this\s+|next\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
  if (weekdayMatch) {
    const names = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const target = names.indexOf(weekdayMatch[1].toLowerCase());
    const d = new Date(today + 'T00:00:00Z');
    const dow = d.getUTCDay();
    let days = (target - dow + 7) % 7;
    if (days === 0) days = /\bnext\b/.test(q) ? 7 : 0;
    if (/\bnext\s/.test(q) && days > 0 && days < 7) days += 7;
    const from = isoAddDays(today, days);
    return { from, to: from, label: weekdayMatch[0].toLowerCase() };
  }
  return null;
}

function resolveTimeIntent(question, today) {
  const q = String(question || '').toLowerCase();
  const meetingHit = /\b(meeting|meetings|call|calls|event|events|1:1|one\s*on\s*one|standup|sync|catchup|catch[- ]?up|webinar|interview|interviews|workshop|workshops|demo|demos|session|sessions)\b/.test(q)
    || /\bwhen(?:'s| is)?\s+my\s+(?:next\s+)?(?:meeting|call|event|interview|1:1|one\s*on\s*one)\b/.test(q);
  const taskHit = /\b(tasks?|to[- ]?dos?|todos?|priorit(?:y|ies)|plate|agenda)\b/.test(q)
    || /\bwhat (?:do|have) i (?:need to |got to )?do\b/.test(q);

  if (!meetingHit && !taskHit) return null;

  const kind = meetingHit && taskHit ? 'both' : (meetingHit ? 'meeting' : 'task');
  let range = resolveTimeRange(q, today);

  // Defaults when the user didn't specify a time window
  if (!range) {
    if (kind === 'task') {
      range = { from: today, to: today, label: 'today (default)' };
    } else {
      // Meeting intent with no date → assume "upcoming" = today + next 14 days
      range = { from: today, to: isoAddDays(today, 14), label: 'upcoming' };
    }
  }

  return { kind, from: range.from, to: range.to, label: range.label };
}

function formatEventTime(event) {
  // start_time and end_time are stored as "HH:MM" strings from the ICS parser,
  // not full ISO datetimes. Use them as-is.
  if (event.all_day) return 'all day';
  if (!event.start_time) return '';
  return event.end_time ? `${event.start_time}–${event.end_time}` : event.start_time;
}

async function fetchStructuredContext(env, intent) {
  const supabaseUrl = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_KEY;
  const { kind, from, to, label } = intent;
  const blocks = [];
  const extraSources = [];
  const rangeLabel = from === to ? from : `${from} → ${to}`;

  if (kind === 'meeting' || kind === 'both') {
    // Calendar events in range
    try {
      const rawEvents = await supabaseGet(supabaseUrl, serviceKey,
        `calendar_events?event_date=gte.${from}&event_date=lte.${to}&order=event_date.asc,start_time.asc&select=uid,title,event_date,start_time,end_time,all_day,location,organizer,attendees`);
      // Dedupe: same meeting can be synced from multiple calendars / reruns.
      const seenKeys = new Set();
      const events = rawEvents.filter(e => {
        const key = `${(e.title || '').toLowerCase()}|${e.event_date}|${e.start_time || ''}`;
        if (seenKeys.has(key)) return false;
        seenKeys.add(key);
        return true;
      });
      if (events.length) {
        const lines = events.map(e => {
          const atts = Array.isArray(e.attendees) ? e.attendees.slice(0, 8) : [];
          const attList = atts.length
            ? `\n  Attendees: ${atts.map(a => typeof a === 'string' ? a : (a.name || a.email || '')).filter(Boolean).join(', ')}${e.attendees.length > atts.length ? ` (+${e.attendees.length - atts.length} more)` : ''}`
            : '';
          return `- **${e.event_date}** ${formatEventTime(e)} — ${e.title || '(untitled)'}${e.location ? ` @ ${e.location}` : ''}${e.organizer ? ` (organiser: ${e.organizer})` : ''}${attList}`;
        });
        blocks.push(`### Calendar events (${rangeLabel})\n\n${lines.join('\n')}`);
        // Surface in sources so the user can click through
        events.forEach(e => extraSources.push({
          source_table: 'calendar_events',
          source_id: e.uid,
          title: e.title || '(untitled event)',
          date: e.event_date,
          similarity: 1.0,
          snippet: `${e.event_date} ${formatEventTime(e)} — ${e.title || ''}`,
          authoritative: true,
        }));
      } else {
        blocks.push(`### Calendar events (${rangeLabel})\n\nNo calendar events found for this range.`);
      }
    } catch (err) {
      blocks.push(`### Calendar events (${rangeLabel})\n\n(Failed to fetch: ${err.message})`);
    }

    // Daily-note meetings field in range
    try {
      const notes = await supabaseGet(supabaseUrl, serviceKey,
        `daily_notes?note_date=gte.${from}&note_date=lte.${to}&order=note_date.asc&select=id,note_date,meetings`);
      const withMeetings = notes.filter(n => n.meetings && n.meetings.trim());
      if (withMeetings.length) {
        const lines = withMeetings.map(n => `**${n.note_date}:**\n${n.meetings}`);
        blocks.push(`### Meeting notes from daily journal (${rangeLabel})\n\n${lines.join('\n\n')}`);
        withMeetings.forEach(n => extraSources.push({
          source_table: 'daily_notes',
          source_id: n.id,
          title: `Daily Note ${n.note_date}`,
          date: n.note_date,
          similarity: 1.0,
          snippet: (n.meetings || '').slice(0, 200),
          authoritative: true,
        }));
      }
    } catch {}
  }

  if (kind === 'task' || kind === 'both') {
    try {
      const notes = await supabaseGet(supabaseUrl, serviceKey,
        `daily_notes?note_date=gte.${from}&note_date=lte.${to}&order=note_date.asc&select=id,note_date,tasks`);
      const withTasks = notes.filter(n => n.tasks && n.tasks.trim());
      if (withTasks.length) {
        const lines = withTasks.map(n => `**${n.note_date}:**\n${n.tasks}`);
        blocks.push(`### Tasks from daily journal (${rangeLabel})\n\n${lines.join('\n\n')}`);
        withTasks.forEach(n => extraSources.push({
          source_table: 'daily_notes',
          source_id: n.id,
          title: `Daily Note ${n.note_date}`,
          date: n.note_date,
          similarity: 1.0,
          snippet: (n.tasks || '').slice(0, 200),
          authoritative: true,
        }));
      } else {
        blocks.push(`### Tasks from daily journal (${rangeLabel})\n\nNo tasks recorded for this range.`);
      }
    } catch {}
  }

  return { blocks, sources: extraSources, label, rangeLabel };
}

/**
 * POST /api/ask-stream — Streaming conversational RAG.
 * Body: { messages: [{role,content}...], tables?, date_from?, date_to?, tags? }
 * Last user message is the question; prior messages are conversation history.
 * RAG runs on the last question each turn. Responds with SSE:
 *   data: {"type":"meta","model":"...","sources":[...]}      (always emitted first)
 *   data: {"type":"delta","text":"..."}                       (streaming tokens)
 *   data: {"type":"meta","model":"...","fallback":true,...}   (only if fallback fired)
 *   data: [DONE]
 */
async function handleAskStream(request, env, ctx) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const { messages, tables, date_from, date_to, tags, client_date, focused_meeting } = body || {};

  if (!Array.isArray(messages) || !messages.length) {
    return json({ error: 'messages array required' }, 400);
  }
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUser?.content || typeof lastUser.content !== 'string') {
    return json({ error: 'Last user message required' }, 400);
  }
  const question = lastUser.content;
  const todayISO = /^\d{4}-\d{2}-\d{2}$/.test(client_date || '')
    ? client_date
    : new Date().toISOString().slice(0, 10);

  const supabaseUrl = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_KEY;
  const hasFilters = date_from || date_to || (tags && tags.length);

  // 1. Embed the question — non-fatal. If embeddings are unavailable (e.g.
  // Workers AI token expired), fall through to zero RAG context. We can
  // still answer time-aware questions from structured context + history.
  let queryEmbedding = null;
  let ragError = null;
  try {
    const embeddings = await generateEmbeddings(env, [question]);
    queryEmbedding = embeddings[0];
  } catch (err) {
    ragError = err.message;
    console.warn('Ask: embedding failed, continuing without RAG:', err.message);
  }

  // 2. Search in parallel across two channels:
  //    - Vectorize (requires embedding): structured rows
  //    - AI Search (no embedding needed, hybrid retrieval server-side): R2
  //      asset bodies. Silently no-op when CF_* / AI_SEARCH_INSTANCE_ID unset.
  let searchResults = [];
  let assetResults = [];
  const fetchCount = hasFilters ? 24 : 8;
  const assetMatchCount = hasFilters ? 12 : 5;
  const wantAssets = !tables || tables.includes('assets');
  const [vecResult, astResult] = await Promise.allSettled([
    queryEmbedding
      ? searchVectorize(env, queryEmbedding, { tables, matchCount: fetchCount })
      : Promise.resolve([]),
    wantAssets ? searchAssetLibrary(env, question, { matchCount: assetMatchCount }) : Promise.resolve([]),
  ]);
  if (vecResult.status === 'fulfilled') {
    searchResults = vecResult.value;
    if (hasFilters) {
      searchResults = filterSearchResults(searchResults, { date_from, date_to, tags }).slice(0, 8);
    }
  } else {
    ragError = ragError || vecResult.reason?.message;
    console.warn('Ask: vector search failed, continuing without RAG:', vecResult.reason?.message);
  }
  if (astResult.status === 'fulfilled') {
    assetResults = astResult.value;
    if (hasFilters) {
      assetResults = filterSearchResults(assetResults, { date_from, date_to, tags }).slice(0, 5);
    }
  } else {
    console.warn('Ask: asset-library search failed, continuing without assets:', astResult.reason?.message);
  }
  searchResults = [...searchResults, ...assetResults];

  const sources = searchResults.map(r => ({
    source_table: r.source_table,
    source_id: r.source_id,
    title: r.metadata?.title || r.source_table,
    date: r.metadata?.date || '',
    similarity: Math.round(r.similarity * 100) / 100,
    snippet: r.content_text.substring(0, 200),
  }));

  // 2b. Time-aware structured context: when the question is about meetings or
  // tasks, fetch calendar_events + daily_notes directly for the resolved date
  // range and prepend as authoritative context. This fixes cases like "what
  // meetings do I have tomorrow?" that pure vector RAG answers poorly.
  let structuredBlocks = [];
  let structuredSources = [];
  let intent = null;
  try {
    intent = resolveTimeIntent(question, todayISO);
    if (intent) {
      const structured = await fetchStructuredContext(env, intent);
      structuredBlocks = structured.blocks;
      structuredSources = structured.sources;
    }
  } catch (err) {
    // Never fail the request because of structured-context fetches — just log
    // and fall back to pure RAG.
    console.warn('Structured context failed:', err.message);
  }

  // 3. Build context + prompts
  const ragBlocks = searchResults.length
    ? searchResults.map((r, i) => {
        const meta = r.metadata || {};
        const source = `[Source ${i + 1}: ${meta.title || r.source_table} ${meta.date ? '(' + meta.date + ')' : ''}]`;
        return `${source}\n${r.content_text}`;
      }).join('\n\n---\n\n')
    : '(No relevant context found in the knowledge base.)';

  const structuredSection = structuredBlocks.length
    ? `## AUTHORITATIVE: Direct calendar & daily-journal data\n\nToday is ${todayISO}. The question resolves to: **${intent.kind}** (${intent.label}).\n\nThe following is pulled directly from structured sources and is authoritative for date-specific questions. Prefer this data over the semantic matches below.\n\n${structuredBlocks.join('\n\n')}\n\n---\n\n`
    : '';

  const contextBlocks = `${structuredSection}## Semantic matches from the knowledge base\n\n${ragBlocks}`;

  let focusedSection = '';
  if (focused_meeting && typeof focused_meeting === 'object' && focused_meeting.title) {
    const fe = focused_meeting;
    const timeLabel = fe.all_day
      ? 'all day'
      : (fe.end_time ? `${fe.start_time}–${fe.end_time}` : fe.start_time || '');
    const atts = Array.isArray(fe.attendees)
      ? fe.attendees.map(a => typeof a === 'string' ? a : (a?.name || a?.email || '')).filter(Boolean).slice(0, 12).join(', ')
      : '';
    focusedSection = `\n\n## FOCUSED MEETING\n\nThe user is preparing for:\n- **${fe.title}** on ${fe.event_date}${timeLabel ? ' at ' + timeLabel : ''}\n${fe.location ? '- Location: ' + fe.location + '\n' : ''}${fe.organizer ? '- Organiser: ' + fe.organizer + '\n' : ''}${atts ? '- Attendees: ' + atts + '\n' : ''}\nAnchor every answer to THIS meeting. When the user asks for prep suggestions, questions, or agenda items, make them specific to this meeting's attendees and subject. When they ask generic questions, interpret them in the context of this meeting unless clearly unrelated.`;
  }

  const systemPrompt = `You are Jasper, a personal knowledge assistant for Paul Land, a Domain Lead (Packaging Job Lifecycle) and Product Manager (WebCenter Pack) at Esko. Today is ${todayISO}. If asked who you are, introduce yourself as Jasper.

Answer questions based ONLY on the provided context. Follow these rules:
- When the context includes an "AUTHORITATIVE" section (calendar events, daily-journal meetings/tasks), treat it as the ground truth for that date range. Answer the "what meetings do I have…" or "what tasks…" question directly from it.
- If the authoritative section is empty for the requested date, say so plainly (e.g. "You have no meetings scheduled tomorrow") — do not speculate.
- Otherwise cite semantic sources by number and date (e.g. "[Source 1]").
- Be concise and direct. Use markdown for readability.
- When summarising across multiple sources, note the date range covered.
- Consider prior turns in this conversation for continuity, but re-ground each answer in the fresh context provided.${focusedSection}`;

  // Merge structured sources above semantic ones in the sources list, de-duped.
  const mergedSources = [
    ...structuredSources,
    ...sources.filter(s => !structuredSources.some(ss => ss.source_table === s.source_table && ss.source_id === s.source_id)),
  ];

  // History excluding the last user message; final user message re-wraps question with context.
  const priorHistory = messages.slice(0, -1).map(m => ({ role: m.role, content: String(m.content || '') }));
  const finalUserMessage = `${contextBlocks}\n\n---\n\n## Question\n\n${question}`;
  const llmMessages = [...priorHistory, { role: 'user', content: finalUserMessage }];

  const preferredModel = DEFAULT_PREFERRED_MODEL;

  // 4. Stream the answer as SSE
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const streamPromise = (async () => {
    try {
      // Emit initial meta with merged (structured + RAG) sources + preferred model
      await writer.write(encoder.encode(`data: ${JSON.stringify({ type: 'meta', model: preferredModel, sources: mergedSources, intent, rag_error: ragError || null })}\n\n`));

      const hasAnyContext = searchResults.length > 0 || structuredBlocks.length > 0;
      if (!hasAnyContext) {
        const fallbackAnswer = ragError
          ? `I couldn't search your knowledge base (embeddings are currently unavailable). Structured calendar and daily-journal lookups still work — try asking about meetings or tasks for a specific day. (Underlying error: ${ragError})`
          : "I couldn't find any relevant information in your knowledge base for this question.";
        await writer.write(encoder.encode(`data: ${JSON.stringify({ type: 'delta', text: fallbackAnswer })}\n\n`));
      } else {
        await callLLM({
          env,
          ctx,
          feature: 'ask_stream',
          systemPrompt,
          messages: llmMessages,
          maxTokens: 4000,
          preferredModel,
          tier: 'balanced',
          streaming: true,
          writer,
          encoder,
        });
      }
      await writer.write(encoder.encode('data: [DONE]\n\n'));
    } catch (err) {
      await writer.write(encoder.encode(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`));
    } finally {
      await writer.close();
    }
  })();
  streamPromise.catch(() => {});

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

/**
 * POST /api/summarize-to-note — Summarise a slice of an Ask conversation into
 * clean markdown meeting notes. Used by the focused-meeting card's "Save
 * discussion as notes" action. Body: { event, messages }.
 */
async function handleSummarizeToNote(request, env, ctx) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const { event, messages } = body || {};
  if (!event || !event.title || !Array.isArray(messages) || messages.length < 2) {
    return json({ error: 'event and a non-trivial messages array are required' }, 400);
  }

  const timeLabel = event.all_day
    ? 'all day'
    : (event.end_time ? `${event.start_time}–${event.end_time}` : event.start_time || '');
  const atts = Array.isArray(event.attendees)
    ? event.attendees.map(a => typeof a === 'string' ? a : (a?.name || a?.email || '')).filter(Boolean).slice(0, 12).join(', ')
    : '';

  const transcript = messages
    .map(m => `**${m.role === 'user' ? 'Me' : 'Assistant'}:**\n${m.content}`)
    .join('\n\n---\n\n');

  const systemPrompt = `You are summarising a brainstorming / prep discussion into clean meeting notes for Paul Land's daily journal.

Target meeting:
- Title: ${event.title}
- Date: ${event.event_date}${timeLabel ? ' · ' + timeLabel : ''}${event.location ? '\n- Location: ' + event.location : ''}${event.organizer ? '\n- Organiser: ' + event.organizer : ''}${atts ? '\n- Attendees: ' + atts : ''}

Return ONLY the notes body in markdown (no top-level heading — the daily-note system adds that). Structure with short sections like:
- **Agenda / topics to cover**
- **Key points**
- **Decisions**
- **Follow-ups / action items**

Skip any section that has nothing to say rather than leaving it empty. Keep it punchy — bullets, not essays. Turn chat-style exchanges into declarative notes (e.g. "Confirmed Q3 plan" not "The assistant said Q3 plan is confirmed").`;

  const userMessage = `Summarise this discussion into notes for the meeting above.\n\n${transcript}`;

  try {
    const { text, model } = await callLLM({
      env,
      ctx,
      feature: 'summarize_to_note',
      systemPrompt,
      userMessage,
      maxTokens: 2000,
      tier: 'balanced',
    });
    return json({ ok: true, summary: text.trim(), model });
  } catch (err) {
    return json({ error: 'Summarisation failed', detail: err.message, attempts: err.attempts }, err.status || 502);
  }
}

// ─── Extract Signals from Content ─────────────────────────────

async function handleExtractSignals(request, env, ctx) {
  try {
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
    const result = await callLLM({ env, ctx, feature: 'extract_signals', systemPrompt, userMessage, maxTokens: 2000, tier: 'quick' });
    const text = result.text || '[]';

    // Parse JSON from response (handle potential markdown wrapping)
    let signals;
    try {
      const jsonStr = text.replace(/^```json?\n?/, '').replace(/\n?```$/, '').trim();
      signals = JSON.parse(jsonStr);
    } catch {
      return json({ error: 'Failed to parse AI response', raw: text }, 500);
    }

    return json({ ok: true, signals, model: result.model });
  } catch (err) {
    return json({ error: 'AI processing failed', detail: err.message, attempts: err.attempts }, err.status || 500);
  }
  } catch (outerErr) {
    return json({ error: 'Handler crashed', detail: outerErr.message, stack: outerErr.stack }, 500);
  }
}

// ─── Prompt loader (for streaming handlers) ──────────────────
// Fetches a prompt row from the `prompts` table by slug so it can
// be edited from admin → Tools → Prompts. Returns null on miss.

async function loadPromptBySlug(env, slug) {
  try {
    const rows = await supabaseGet(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY,
      `prompts?slug=eq.${slug}&limit=1`);
    return rows?.[0] || null;
  } catch {
    return null;
  }
}

function fillTemplate(template, vars) {
  return (template || '').replace(/\{\{(\w+)\}\}/g, (_, k) =>
    vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : '');
}

// ─── LLM dispatcher with multi-provider fallback ─────────────
// Routes to Anthropic (claude-*) or Cloudflare Workers AI (@cf/*).
// Streaming normalises both to `data: {type:'delta', text:'…'}` frames
// plus a `{type:'meta', model, fallback:true, reason}` frame when the
// primary model fails and a fallback takes over. Non-streaming returns
// `{text, model, attempts}`. Retries on 429/5xx/credit-exhausted errors.

const DEFAULT_PREFERRED_MODEL = 'claude-sonnet-4-6';
const FALLBACK_CHAIN_BALANCED = [
  'claude-haiku-4-5-20251001',
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
];
const FALLBACK_CHAIN_REASONING = [
  'claude-opus-4-7',
  'claude-haiku-4-5-20251001',
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
];
const FALLBACK_CHAIN_QUICK = [
  'claude-haiku-4-5-20251001',
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
];

function buildFallbackChain(preferredModel, tier) {
  const extras = tier === 'reasoning' ? FALLBACK_CHAIN_REASONING
               : tier === 'quick' ? FALLBACK_CHAIN_QUICK
               : FALLBACK_CHAIN_BALANCED;
  const seen = new Set();
  return [preferredModel, ...extras].filter(m => {
    if (!m || seen.has(m)) return false;
    seen.add(m);
    return true;
  });
}

function isRetryableError(status, errText) {
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  if (status === 401 || status === 403) return true; // invalid/missing key → try fallback
  if (errText && /credit|quota|rate.?limit|overloaded|invalid.?api.?key|authentication/i.test(errText)) return true;
  return false;
}

function buildAnthropicBody({ model, systemPrompt, userMessage, messages, maxTokens, stream }) {
  const body = {
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
  };
  if (stream) body.stream = true;
  if (Array.isArray(messages) && messages.length) {
    body.messages = messages;
  } else {
    body.messages = [{ role: 'user', content: userMessage }];
  }
  return body;
}

function buildWorkersAiArgs({ systemPrompt, userMessage, messages, maxTokens, stream }) {
  const msgs = Array.isArray(messages) && messages.length
    ? [{ role: 'system', content: systemPrompt }, ...messages]
    : [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMessage }];
  return { messages: msgs, stream: !!stream, max_tokens: maxTokens };
}

/**
 * Attempt to stream from ONE model. If the upstream open fails (bad status,
 * auth, network), returns {ok:false, status, errText} WITHOUT writing any
 * delta to the writer — caller can try the next model. If the open succeeds,
 * forwards deltas and returns {ok:true} after [DONE].
 */
async function streamOneModel({ env, model, systemPrompt, userMessage, messages, maxTokens, writer, encoder }) {
  const sendDelta = (text) => writer.write(encoder.encode(`data: ${JSON.stringify({ type: 'delta', text })}\n\n`));

  if (model.startsWith('claude-')) {
    const anthropicKey = env.ANTHROPIC_API_KEY;
    if (!anthropicKey) return { ok: false, status: 401, errText: 'ANTHROPIC_API_KEY not configured' };

    let res;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify(buildAnthropicBody({ model, systemPrompt, userMessage, messages, maxTokens, stream: true })),
      });
    } catch (err) {
      await logAiError(env, { provider: 'anthropic', model, endpoint: 'stream', status: 0, message: err?.message });
      return { ok: false, status: 0, errText: `Network error: ${err.message}` };
    }
    if (!res.ok) {
      const errText = await res.text();
      if (isAuthOrQuotaSignal(res.status, errText)) {
        await logAiError(env, { provider: 'anthropic', model, endpoint: 'stream', status: res.status, message: errText });
      }
      return { ok: false, status: res.status, errText };
    }

    // Accumulate usage + first chunk of output text from the SSE stream
    const usage = { tokens_in: 0, tokens_out: 0, cache_creation_tokens: 0, cache_read_tokens: 0 };
    let outputExcerpt = '';

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (!data || data === '[DONE]') continue;
        let parsed;
        try { parsed = JSON.parse(data); } catch { continue; }
        if (parsed.type === 'message_start' && parsed.message?.usage) {
          const u = parsed.message.usage;
          usage.tokens_in             = Number(u.input_tokens) || 0;
          usage.tokens_out            = Number(u.output_tokens) || 0;
          usage.cache_creation_tokens = Number(u.cache_creation_input_tokens) || 0;
          usage.cache_read_tokens     = Number(u.cache_read_input_tokens) || 0;
        } else if (parsed.type === 'message_delta' && parsed.usage) {
          // message_delta carries the final output_tokens count
          usage.tokens_out = Number(parsed.usage.output_tokens) || usage.tokens_out;
        } else if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
          if (outputExcerpt.length < 200) outputExcerpt += parsed.delta.text;
          await sendDelta(parsed.delta.text);
        } else if (parsed.type === 'error') {
          // Mid-stream error — surface to client, cannot fall back now
          const msg = parsed.error?.message || JSON.stringify(parsed.error);
          await logAiError(env, { provider: 'anthropic', model, endpoint: 'stream', status: null, message: msg });
          await writer.write(encoder.encode(`data: ${JSON.stringify({ type: 'error', error: msg })}\n\n`));
        }
      }
    }
    return { ok: true, usage, output_excerpt: outputExcerpt.slice(0, 200) };
  }

  if (model.startsWith('@cf/')) {
    if (!env.AI) return { ok: false, status: 500, errText: 'Workers AI binding not available' };
    let stream;
    try {
      stream = await env.AI.run(model, buildWorkersAiArgs({ systemPrompt, userMessage, messages, maxTokens, stream: true }));
    } catch (err) {
      await logAiError(env, { provider: 'cloudflare_ai', model, endpoint: 'stream', status: 0, message: err?.message });
      return { ok: false, status: 0, errText: `Workers AI error: ${err.message}` };
    }

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (!data || data === '[DONE]') continue;
        let parsed;
        try { parsed = JSON.parse(data); } catch { continue; }
        const text = parsed.response
          ?? parsed.choices?.[0]?.delta?.content
          ?? parsed.delta?.text
          ?? '';
        if (text) await sendDelta(text);
      }
    }
    return { ok: true };
  }

  return { ok: false, status: 400, errText: `Unknown model prefix: ${model}` };
}

/**
 * Non-streaming call to one model. Returns {ok, text?, usage?, status?, errText?}.
 */
async function invokeOneModel({ env, model, systemPrompt, userMessage, messages, maxTokens }) {
  if (model.startsWith('claude-')) {
    const anthropicKey = env.ANTHROPIC_API_KEY;
    if (!anthropicKey) return { ok: false, status: 401, errText: 'ANTHROPIC_API_KEY not configured' };

    let res;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify(buildAnthropicBody({ model, systemPrompt, userMessage, messages, maxTokens, stream: false })),
      });
    } catch (err) {
      await logAiError(env, { provider: 'anthropic', model, endpoint: 'invoke', status: 0, message: err?.message });
      return { ok: false, status: 0, errText: `Network error: ${err.message}` };
    }
    if (!res.ok) {
      const errText = await res.text();
      if (isAuthOrQuotaSignal(res.status, errText)) {
        await logAiError(env, { provider: 'anthropic', model, endpoint: 'invoke', status: res.status, message: errText });
      }
      return { ok: false, status: res.status, errText };
    }
    const data = await res.json();
    const text = data.content?.[0]?.text || '';
    return { ok: true, text, usage: extractAnthropicUsage(data) };
  }

  if (model.startsWith('@cf/')) {
    if (!env.AI) return { ok: false, status: 500, errText: 'Workers AI binding not available' };
    try {
      const out = await env.AI.run(model, buildWorkersAiArgs({ systemPrompt, userMessage, messages, maxTokens, stream: false }));
      const text = out?.response ?? out?.result?.response ?? '';
      return { ok: true, text, usage: { tokens_in: 0, tokens_out: 0, cache_creation_tokens: 0, cache_read_tokens: 0 } };
    } catch (err) {
      await logAiError(env, { provider: 'cloudflare_ai', model, endpoint: 'invoke', status: 0, message: err?.message });
      return { ok: false, status: 0, errText: `Workers AI error: ${err.message}` };
    }
  }

  return { ok: false, status: 400, errText: `Unknown model prefix: ${model}` };
}

/**
 * Unified LLM call with automatic fallback.
 *
 * Streaming mode: caller must pass writer+encoder. Does NOT emit [DONE] — the
 * caller does that. Emits `{type:'meta', model, fallback:true, reason}` BEFORE
 * the first delta only if a fallback was triggered (first-attempt success is
 * silent so the caller's own meta frame remains authoritative).
 *
 * Non-streaming mode returns `{text, model, attempts}`.
 */
async function callLLM({
  env,
  ctx,
  feature,
  prompt_id,
  systemPrompt,
  userMessage,
  messages,
  maxTokens = 4000,
  preferredModel = DEFAULT_PREFERRED_MODEL,
  fallbackChain,
  tier = 'balanced',
  streaming = false,
  writer,
  encoder,
}) {
  const chain = fallbackChain && fallbackChain.length
    ? fallbackChain
    : buildFallbackChain(preferredModel, tier);

  const attempts = [];
  let lastErr = null;
  const startedAt = Date.now();

  for (let i = 0; i < chain.length; i++) {
    const model = chain[i];
    const isFallback = i > 0;

    if (streaming) {
      if (isFallback) {
        await writer.write(encoder.encode(`data: ${JSON.stringify({
          type: 'meta',
          model,
          fallback: true,
          reason: `Fell back from ${chain[0]} — ${lastErr?.errText?.slice(0, 200) || 'provider error'}`,
        })}\n\n`));
      }
      const result = await streamOneModel({ env, model, systemPrompt, userMessage, messages, maxTokens, writer, encoder });
      attempts.push({ model, ok: result.ok, status: result.status });
      if (result.ok) {
        if (feature) {
          await logUsageEvent(env, ctx, {
            surface: 'api',
            feature,
            prompt_id: prompt_id || null,
            model,
            ...(result.usage || {}),
            output_excerpt: result.output_excerpt || null,
            duration_ms: Date.now() - startedAt,
            metadata: isFallback ? { fallback_from: chain[0] } : null,
          });
        }
        return { model, attempts };
      }
      lastErr = result;
      if (!isRetryableError(result.status, result.errText) && i < chain.length - 1) {
        // Non-retryable error — still try fallback, user wants graceful degradation
      }
    } else {
      const result = await invokeOneModel({ env, model, systemPrompt, userMessage, messages, maxTokens });
      attempts.push({ model, ok: result.ok, status: result.status });
      if (result.ok) {
        if (feature) {
          await logUsageEvent(env, ctx, {
            surface: 'api',
            feature,
            prompt_id: prompt_id || null,
            model,
            ...(result.usage || {}),
            output_excerpt: result.text ? result.text.slice(0, 200) : null,
            duration_ms: Date.now() - startedAt,
            metadata: isFallback ? { fallback_from: chain[0] } : null,
          });
        }
        return { text: result.text, model, attempts, fallback: isFallback };
      }
      lastErr = result;
    }
  }

  // All models exhausted
  if (streaming) {
    await writer.write(encoder.encode(`data: ${JSON.stringify({
      type: 'error',
      error: `All models failed. Last error: ${lastErr?.errText?.slice(0, 300) || 'unknown'}`,
    })}\n\n`));
    return { model: null, attempts };
  }
  const err = new Error(`All models failed. Last error: ${lastErr?.errText || 'unknown'}`);
  err.attempts = attempts;
  err.status = lastErr?.status || 502;
  throw err;
}

/**
 * Thin compat shim — delegates to callLLM in streaming mode.
 * Existing streaming callers gain multi-model fallback transparently.
 */
async function streamLLMToWriter({ env, ctx, feature, prompt_id, model, systemPrompt, userMessage, messages, maxTokens, writer, encoder }) {
  return callLLM({
    env, ctx, feature, prompt_id,
    systemPrompt, userMessage, messages, maxTokens,
    preferredModel: model,
    tier: 'balanced',
    streaming: true,
    writer, encoder,
  });
}

// ─── Signal Synthesis (streaming) ─────────────────────────────

async function handleSignalSynthesis(request, env, ctx) {
  const { signal_ids, format = 'narrative', focus = 'strategic-implications', context, model: modelOverride } = await request.json();
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

  const focusLabel = focusLabels[focus] || focus;

  const signalsContext = signals.map((s, i) =>
    `### Signal ${i + 1}: ${s.title}
${s.body || '(No detail)'}
Tags: ${(s.tags || []).join(', ')}
Date: ${s.captured_at || 'Unknown'}`
  ).join('\n\n---\n\n');

  const extraContext = context ? `\n## Additional Context\n\n${context}` : '';

  // Load editable prompt from DB (falls back to inline default if missing)
  const promptRow = await loadPromptBySlug(env, 'signal-synthesis');
  const vars = {
    focus_label: focusLabel,
    format_instructions: formatInstructions,
    signals_context: signalsContext,
    extra_context: extraContext,
    signal_count: signals.length,
  };

  const systemPrompt = promptRow?.system_prompt
    ? fillTemplate(promptRow.system_prompt, vars)
    : `You are a strategic intelligence analyst working with Paul Land, a Domain Lead (Packaging Job Lifecycle) and Product Manager at Esko.

Your task is to synthesise multiple strategic signals into a coherent analysis focused on: ${focusLabel}.

${formatInstructions}

Ground your analysis in the specific signals provided. Reference them by their titles when relevant. Draw connections between signals that the reader might miss. End with a clear "so what" — what should the reader do or think differently based on this synthesis.`;

  const userMessage = promptRow?.user_prompt_template
    ? fillTemplate(promptRow.user_prompt_template, vars)
    : `## Signals to Synthesise

${signalsContext}

${extraContext}

Please synthesise these ${signals.length} signals with a focus on ${focusLabel}.`;

  const model = modelOverride || promptRow?.model || 'claude-sonnet-4-6';
  const maxTokens = promptRow?.max_tokens || 4000;

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const streamPromise = (async () => {
    try {
      await writer.write(encoder.encode(`data: ${JSON.stringify({ type: 'meta', model })}\n\n`));
      await streamLLMToWriter({ env, ctx, feature: 'signal_synthesis', model, systemPrompt, userMessage, maxTokens, writer, encoder });
      await writer.write(encoder.encode('data: [DONE]\n\n'));
    } catch (err) {
      await writer.write(encoder.encode(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`));
    } finally {
      await writer.close();
    }
  })();

  streamPromise.catch(() => {});

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

// ─── Reflection Synthesis ─────────────────────────────────────

async function handleReflectionSynthesis(request, env, ctx) {
  const { from_date, to_date, categories, context, model: modelOverride } = await request.json();
  if (!from_date || !to_date) {
    return json({ error: 'from_date and to_date required' }, 400);
  }

  const supabaseUrl = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_KEY;
  const headers = { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` };

  // Load reflections_log entries in range
  let logUrl = `${supabaseUrl}/rest/v1/reflections_log?select=id,note_date,observation,coach_perspective,category&note_date=gte.${from_date}&note_date=lte.${to_date}&order=note_date.asc`;
  if (categories?.length) {
    logUrl += `&category=in.(${categories.map(c => `"${c}"`).join(',')})`;
  }
  const logRes = await fetch(logUrl, { headers });
  const logData = logRes.ok ? await logRes.json() : [];

  // Load content reflections (type=reflection) in range
  const contentUrl = `${supabaseUrl}/rest/v1/content?type=eq.reflection&select=id,title,body,tags,captured_at,metadata&captured_at=gte.${from_date}T00:00:00&captured_at=lte.${to_date}T23:59:59&order=captured_at.asc`;
  const contentRes = await fetch(contentUrl, { headers });
  const contentData = contentRes.ok ? await contentRes.json() : [];

  if (!logData.length && !contentData.length) {
    return json({ error: 'No reflections found in this date range' }, 404);
  }

  const logBlock = logData.map(r =>
    `[${r.note_date}] (${r.category || 'leadership'}) ${r.observation}${r.coach_perspective ? `\n  → Coach: ${r.coach_perspective}` : ''}`
  ).join('\n\n');

  const contentBlock = contentData.map(r =>
    `[${(r.captured_at || '').slice(0, 10)}] ${r.title}\n${r.body || ''}`
  ).join('\n\n---\n\n');

  const reflectionsBlock = [
    logData.length ? `### From daily reviews (${logData.length})\n\n${logBlock}` : '',
    contentData.length ? `### Captured reflections (${contentData.length})\n\n${contentBlock}` : '',
  ].filter(Boolean).join('\n\n');

  const extraContext = context ? `\nAdditional guidance from Paul for this synthesis: ${context}` : '';

  // Load editable prompt from DB (falls back to inline default if missing)
  const promptRow = await loadPromptBySlug(env, 'reflection-synthesis');
  const vars = {
    from_date,
    to_date,
    reflections: reflectionsBlock,
    extra_context: extraContext,
  };

  const systemPrompt = promptRow?.system_prompt
    ? fillTemplate(promptRow.system_prompt, vars) + extraContext
    : `You are a thoughtful coach and sparring partner to Paul Land, a Domain Lead and Product Manager at Esko. Your job is to synthesise a period of his personal reflections into a short, honest mirror — helping him see patterns he's too close to notice.

Write four sections in markdown, in this exact order:

## Themes
For each recurring theme, a bolded name followed by how many times it appeared and a one-sentence description of what he's really wrestling with. 3–6 themes max. Be specific — not "leadership" but "knowing when to trust the team vs step in".

## What's changed
One short paragraph. How has his thinking shifted across this period? Where has he landed on things he was unsure about? Where is he still oscillating?

## Open questions
A bulleted list of the questions he's still working through. These are the things that haven't resolved — worth naming so he can come back to them.

## Suggested links
Bulleted list of suggestions for where these reflections might belong in his knowledge base. Example: "Link the 3 reflections about CSR workload to problem P3" or "This cluster of thinking about energy belongs on your personal development file". Be concrete.

Tone: direct, warm, not sycophantic. Don't flatter. Don't add filler. Quote him sparingly — only when a phrase is genuinely revealing.${extraContext}`;

  const userMessage = promptRow?.user_prompt_template
    ? fillTemplate(promptRow.user_prompt_template, vars)
    : `## Reflections from ${from_date} to ${to_date}

${reflectionsBlock}

Please synthesise per the system prompt.`;

  const model = modelOverride || promptRow?.model || 'claude-sonnet-4-6';
  const maxTokens = promptRow?.max_tokens || 4000;

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const streamPromise = (async () => {
    try {
      await writer.write(encoder.encode(`data: ${JSON.stringify({
        type: 'meta',
        model,
        log_count: logData.length,
        content_count: contentData.length,
        source_ids: { log: logData.map(r => r.id), content: contentData.map(r => r.id) },
      })}\n\n`));
      await streamLLMToWriter({ env, ctx, feature: 'reflection_synthesis', model, systemPrompt, userMessage, maxTokens, writer, encoder });
      await writer.write(encoder.encode('data: [DONE]\n\n'));
    } catch (err) {
      await writer.write(encoder.encode(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`));
    } finally {
      await writer.close();
    }
  })();

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

async function handleCompetitorResearch(request, env, ctx) {
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

      // Cost tracking — even if report is empty, the call was billed
      await logUsageEvent(env, ctx, {
        surface: 'api',
        feature: 'competitor_research',
        model: claudeData.model || 'claude-sonnet-4-20250514',
        ...extractAnthropicUsage(claudeData),
        output_excerpt: report ? report.slice(0, 200) : null,
        metadata: { name, focus: focus || 'all', web_search: true },
      });

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
