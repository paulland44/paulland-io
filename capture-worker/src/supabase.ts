/**
 * Supabase REST API helpers — same pattern as mcp-server/src/supabase.ts
 */

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  READWISE_TOKEN?: string;
  OUTLOOK_ICS_URL?: string;
  USER_TIMEZONE?: string;
  // AE → WCP enrichment poller
  PAULLAND_API_URL?: string;
  PAULLAND_INTERNAL_API_KEY?: string;
  R2_BUCKET: R2Bucket;
}

function headers(key: string, extra?: Record<string, string>) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

export async function supabaseGet(
  url: string,
  key: string,
  path: string
): Promise<any[]> {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    headers: headers(key),
  });
  if (!res.ok) return [];
  return res.json();
}

export async function supabasePost(
  url: string,
  key: string,
  table: string,
  data: any,
  returnRow = false
): Promise<{ ok: boolean; data?: any; error?: string }> {
  const res = await fetch(`${url}/rest/v1/${table}`, {
    method: 'POST',
    headers: headers(key, {
      Prefer: returnRow ? 'return=representation' : 'return=minimal',
    }),
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const text = await res.text();
    return { ok: false, error: text };
  }
  if (returnRow) {
    const rows = await res.json();
    return { ok: true, data: rows };
  }
  return { ok: true };
}

export async function supabasePatch(
  url: string,
  key: string,
  path: string,
  data: any
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: headers(key, { Prefer: 'return=minimal' }),
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const text = await res.text();
    return { ok: false, error: text };
  }
  return { ok: true };
}

export async function supabaseUpsert(
  url: string,
  key: string,
  table: string,
  data: any,
  onConflict: string
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(
    `${url}/rest/v1/${table}?on_conflict=${onConflict}`,
    {
      method: 'POST',
      headers: headers(key, {
        Prefer: 'resolution=merge-duplicates,return=minimal',
      }),
      body: JSON.stringify(data),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    return { ok: false, error: text };
  }
  return { ok: true };
}
