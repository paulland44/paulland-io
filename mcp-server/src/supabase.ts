/**
 * Supabase REST API helpers — ported from functions/api/[[path]].js
 */

// Support both process.env (local stdio) and explicit init (Worker)
let _url: string | undefined;
let _key: string | undefined;

export function initSupabase(url: string, key: string) {
  _url = url;
  _key = key;
}

function getUrl() { return _url || process.env.SUPABASE_URL!; }
function getKey() { return _key || process.env.SUPABASE_SERVICE_KEY!; }

function headers(extra?: Record<string, string>) {
  return {
    apikey: getKey(),
    Authorization: `Bearer ${getKey()}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

export async function supabaseGet(path: string): Promise<any[]> {
  const res = await fetch(`${getUrl()}/rest/v1/${path}`, {
    headers: headers(),
  });
  if (!res.ok) return [];
  return res.json();
}

export async function supabasePost(
  table: string,
  data: any,
  returnRow = false
): Promise<{ ok: boolean; data?: any; error?: string }> {
  const res = await fetch(`${getUrl()}/rest/v1/${table}`, {
    method: 'POST',
    headers: headers({
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
  path: string,
  data: any
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${getUrl()}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: headers({ Prefer: 'return=minimal' }),
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const text = await res.text();
    return { ok: false, error: text };
  }
  return { ok: true };
}

export async function supabaseDelete(
  path: string
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${getUrl()}/rest/v1/${path}`, {
    method: 'DELETE',
    headers: headers(),
  });
  if (!res.ok) {
    const text = await res.text();
    return { ok: false, error: text };
  }
  return { ok: true };
}

export async function supabaseRpc(
  fnName: string,
  body: any
): Promise<{ ok: boolean; data?: any; error?: string }> {
  const res = await fetch(`${getUrl()}/rest/v1/rpc/${fnName}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    return { ok: false, error: text };
  }
  const data = await res.json();
  return { ok: true, data };
}

export async function supabaseUpsert(
  table: string,
  data: any,
  onConflict: string
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(
    `${getUrl()}/rest/v1/${table}?on_conflict=${onConflict}`,
    {
      method: 'POST',
      headers: headers({
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
