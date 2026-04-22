/**
 * AE → WCP enrichment poller
 *
 * Sweeps mis_jobs rows where status='AE-Submitted' and enrichment_next_at is
 * due, looks up the WCP project that Automation Engine provisioned (matched
 * on jobId via S2's /projects?searchValue=...), uploads any staged R2
 * attachments via the 3-step S2 flow, and POSTs the full property set to
 * /mis/projects (which upserts because the {MISId, jobId, jobPartId} triplet
 * already exists on the AE-created project).
 *
 * Backoff schedule (minutes): 2, 5, 10, 30, 60, then 120 × 7 ≈ 16 hours total.
 * After 12 attempts the row transitions to Enrichment-Failed.
 */

import type { Env } from './supabase';
import { supabaseGet, supabasePatch } from './supabase';

const ENRICHMENT_BACKOFF_MIN = [2, 5, 10, 30, 60, 120, 120, 120, 120, 120, 120, 120];
const MAX_ROWS_PER_TICK = 20;

interface PendingAttachment {
  key: string;
  filename: string;
  mime: string;
  category?: string;
}

interface JobRow {
  id: string;
  job_id: string;
  connection_id: string;
  enrichment_payload: any;
  enrichment_attempts: number;
  pending_attachments: PendingAttachment[] | null;
}

interface ConnectionRow {
  id: string;
  type: string;
  api_version: string;
  cluster: string | null;
  enrichment_connection_id: string | null;
}

export interface EnrichmentStats {
  scanned: number;
  enriched: number;
  deferred: number;
  failed: number;
  errors: number;
}

export async function syncEnrichment(env: Env): Promise<EnrichmentStats> {
  const stats: EnrichmentStats = { scanned: 0, enriched: 0, deferred: 0, failed: 0, errors: 0 };

  const apiUrl = env.PAULLAND_API_URL;
  const internalKey = env.PAULLAND_INTERNAL_API_KEY;
  if (!apiUrl || !internalKey) {
    console.log('[enrichment] PAULLAND_API_URL or PAULLAND_INTERNAL_API_KEY not set — skipping');
    return stats;
  }

  const { SUPABASE_URL: url, SUPABASE_SERVICE_KEY: key } = env;
  const nowIso = new Date().toISOString();

  // Fetch due rows. The partial index on enrichment_next_at WHERE status='AE-Submitted'
  // keeps this cheap even as mis_jobs grows.
  const rows = await supabaseGet(
    url,
    key,
    `mis_jobs?status=eq.AE-Submitted&enrichment_next_at=lte.${encodeURIComponent(nowIso)}&select=id,job_id,connection_id,enrichment_payload,enrichment_attempts,pending_attachments&limit=${MAX_ROWS_PER_TICK}`
  );

  stats.scanned = rows.length;
  if (!rows.length) {
    console.log('[enrichment] No due rows');
    return stats;
  }

  console.log(`[enrichment] Processing ${rows.length} due rows`);

  for (const row of rows as JobRow[]) {
    try {
      const result = await enrichOne(env, apiUrl, internalKey, row);
      if (result === 'enriched') stats.enriched++;
      else if (result === 'deferred') stats.deferred++;
      else if (result === 'failed') stats.failed++;
    } catch (err: any) {
      stats.errors++;
      console.error(`[enrichment] Error on ${row.job_id}:`, err.message);
      // Treat as deferral — let the next tick retry.
      await scheduleRetry(env, row, `${err.message}`.slice(0, 300));
    }
  }

  console.log(`[enrichment] Done: ${JSON.stringify(stats)}`);
  return stats;
}

type EnrichOutcome = 'enriched' | 'deferred' | 'failed';

async function enrichOne(
  env: Env,
  apiUrl: string,
  internalKey: string,
  row: JobRow
): Promise<EnrichOutcome> {
  const { SUPABASE_URL: url, SUPABASE_SERVICE_KEY: key } = env;

  // Resolve the S2 connection that reads/writes WCP.
  const s2ConnectionId = await resolveS2ConnectionId(env, row.connection_id);
  if (!s2ConnectionId) {
    console.warn(`[enrichment] ${row.job_id}: no S2 enrichment connection found — failing permanently`);
    await supabasePatch(url, key, `mis_jobs?id=eq.${row.id}`, {
      status: 'Enrichment-Failed',
      wcp_response: { error: 'No S2 connection configured for enrichment. Set mis_connections.enrichment_connection_id on the AE connection.' },
    });
    return 'failed';
  }

  // Step 1: search WCP for the project by jobId
  const s2Headers: Record<string, string> = {
    'Accept': 'application/json',
    'X-Internal-API-Key': internalKey,
    'X-MIS-Connection-Id': s2ConnectionId,
  };

  const searchResp = await fetch(
    `${apiUrl}/mis/projects?searchValue=${encodeURIComponent(row.job_id)}&pageSize=5`,
    { headers: s2Headers }
  );
  if (!searchResp.ok) {
    await scheduleRetry(env, row, `Search failed: HTTP ${searchResp.status}`);
    return 'deferred';
  }
  const searchData = await searchResp.json().catch(() => null) as any;
  const items = searchData?.items || searchData?.data || (Array.isArray(searchData) ? searchData : []);
  // S2 searchValue can return near-matches; require exact jobId match on properties.
  const match = items.find((p: any) => p?.properties?.jobId === row.job_id);

  if (!match) {
    await scheduleRetry(env, row, 'WCP project not yet visible');
    return 'deferred';
  }

  const projectNodeId = match.id || match.nodeId;
  console.log(`[enrichment] ${row.job_id}: found WCP project ${projectNodeId}`);

  // Step 2: upload pending attachments (best-effort — partial failures are logged but
  // don't block the properties enrichment).
  const uploadedFilenames: string[] = [];
  if (row.pending_attachments?.length && projectNodeId) {
    for (const att of row.pending_attachments) {
      try {
        const ok = await uploadOneAttachment(env, apiUrl, internalKey, s2ConnectionId, projectNodeId, att);
        if (ok) uploadedFilenames.push(att.filename);
      } catch (err: any) {
        console.warn(`[enrichment] ${row.job_id}: upload failed for ${att.filename}: ${err.message}`);
      }
    }
  }

  // Step 3: POST the enrichment payload — S2 upserts by {MISId, jobId, jobPartId}
  const enrichResp = await fetch(`${apiUrl}/mis/projects`, {
    method: 'POST',
    headers: { ...s2Headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(row.enrichment_payload),
  });
  if (!enrichResp.ok) {
    const errText = await enrichResp.text().catch(() => '');
    await scheduleRetry(env, row, `Enrichment POST failed: HTTP ${enrichResp.status} ${errText.slice(0, 200)}`);
    return 'deferred';
  }

  // Step 4: mark row as enriched
  await supabasePatch(url, key, `mis_jobs?id=eq.${row.id}`, {
    status: 'WCP-Enriched',
    enriched_at: new Date().toISOString(),
    project_node_id: projectNodeId,
    enrichment_payload: null,
    pending_attachments: null,
  });

  // Step 5: clean up R2 for uploaded attachments
  if (uploadedFilenames.length && row.pending_attachments) {
    const toDelete = row.pending_attachments.filter((a) => uploadedFilenames.includes(a.filename));
    for (const att of toDelete) {
      try {
        await env.R2_BUCKET.delete(att.key);
      } catch (err: any) {
        console.warn(`[enrichment] ${row.job_id}: R2 delete failed for ${att.key}: ${err.message}`);
      }
    }
  }

  console.log(`[enrichment] ${row.job_id}: enriched (uploaded ${uploadedFilenames.length}/${row.pending_attachments?.length || 0} attachments)`);
  return 'enriched';
}

// Look up the S2 connection to use for reads/enrichment. Prefer the explicit
// pointer on the AE connection; fall back to a sibling S2 connection with
// matching cluster. Returns the S2 connection's UUID (or null if none found).
async function resolveS2ConnectionId(env: Env, aeConnectionId: string): Promise<string | null> {
  const { SUPABASE_URL: url, SUPABASE_SERVICE_KEY: key } = env;
  const aeRows = (await supabaseGet(
    url,
    key,
    `mis_connections?id=eq.${aeConnectionId}&select=id,type,api_version,cluster,enrichment_connection_id&limit=1`
  )) as ConnectionRow[];
  if (!aeRows.length) return null;

  const ae = aeRows[0];
  if (ae.enrichment_connection_id) return ae.enrichment_connection_id;

  // Fallback: find any S2 connection matching the AE cluster
  if (ae.cluster) {
    const siblings = (await supabaseGet(
      url,
      key,
      `mis_connections?api_version=eq.s2&cluster=eq.${encodeURIComponent(ae.cluster)}&is_active=eq.true&select=id&limit=1`
    )) as { id: string }[];
    if (siblings.length) return siblings[0].id;
  }

  return null;
}

async function uploadOneAttachment(
  env: Env,
  apiUrl: string,
  internalKey: string,
  connectionId: string,
  projectNodeId: string,
  att: PendingAttachment
): Promise<boolean> {
  const obj = await env.R2_BUCKET.get(att.key);
  if (!obj) {
    console.warn(`[enrichment] R2 object ${att.key} not found`);
    return false;
  }
  const bytes = await obj.arrayBuffer();

  const headers: Record<string, string> = {
    'Accept': 'application/json',
    'X-Internal-API-Key': internalKey,
    'X-MIS-Connection-Id': connectionId,
  };

  // Step 1: placeholder
  const createResp = await fetch(`${apiUrl}/mis/projects/${projectNodeId}/assets`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ relUrl: `Input/${att.filename}` }),
  });
  if (!createResp.ok) {
    console.warn(`[enrichment] placeholder failed for ${att.filename}: HTTP ${createResp.status}`);
    return false;
  }
  const placeholder = await createResp.json().catch(() => null) as any;
  const assetId = placeholder?.id;
  const contentUri = placeholder?.contentUri;
  const contentId = placeholder?.contentId;
  const version = placeholder?.version;
  if (!assetId) return false;

  // Step 2: PUT to pre-signed URL if provided, else fallback to proxy POST
  if (contentUri && contentId) {
    const putResp = await fetch(contentUri, {
      method: 'PUT',
      headers: { 'Content-Type': att.mime || 'application/octet-stream' },
      body: bytes,
    });
    if (!putResp.ok) {
      console.warn(`[enrichment] pre-signed PUT failed for ${att.filename}: HTTP ${putResp.status}`);
      return false;
    }
    // Step 3: finalize
    const qs = `contentId=${encodeURIComponent(contentId)}&version=${encodeURIComponent(version)}&status=completed`;
    const finResp = await fetch(`${apiUrl}/mis/assets/${assetId}/contentUploadStatus?${qs}`, {
      method: 'POST',
      headers,
    });
    if (!finResp.ok) {
      console.warn(`[enrichment] finalize failed for ${att.filename}: HTTP ${finResp.status}`);
      return false;
    }
    return true;
  }

  // Legacy single-step fallback
  const legacyResp = await fetch(`${apiUrl}/mis/assets/${assetId}/content`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': att.mime || 'application/octet-stream' },
    body: bytes,
  });
  return legacyResp.ok;
}

async function scheduleRetry(env: Env, row: JobRow, reason: string): Promise<void> {
  const { SUPABASE_URL: url, SUPABASE_SERVICE_KEY: key } = env;
  const nextAttempt = (row.enrichment_attempts || 0) + 1;

  // Exhausted backoff table → permanent failure
  if (nextAttempt > ENRICHMENT_BACKOFF_MIN.length) {
    await supabasePatch(url, key, `mis_jobs?id=eq.${row.id}`, {
      status: 'Enrichment-Failed',
      enrichment_attempts: nextAttempt,
      wcp_response: { error: `Enrichment exhausted after ${nextAttempt - 1} attempts. Last reason: ${reason}` },
    });
    console.warn(`[enrichment] ${row.job_id}: exhausted after ${nextAttempt - 1} attempts`);
    return;
  }

  const delayMin = ENRICHMENT_BACKOFF_MIN[nextAttempt - 1];
  const nextAt = new Date(Date.now() + delayMin * 60 * 1000).toISOString();
  await supabasePatch(url, key, `mis_jobs?id=eq.${row.id}`, {
    enrichment_attempts: nextAttempt,
    enrichment_next_at: nextAt,
  });
  console.log(`[enrichment] ${row.job_id}: deferred (${reason}); attempt ${nextAttempt}/${ENRICHMENT_BACKOFF_MIN.length}, next at ${nextAt}`);
}
