/**
 * APNS sender for paulland-mis push notifications fired from MCP tools.
 *
 * Mirror of capture-worker/src/apns.ts and email-to-mis-job/src/apns.ts —
 * kept self-contained because each runtime has its own env-access pattern
 * (worker bindings vs Node process.env). Signs an ES256 JWT with the team's
 * APNS .p8 key and POSTs to Apple's HTTP/2 endpoint. JWT cached for ~50 min.
 */

import { supabaseGet } from './supabase.js';

const APNS_HOST_DEV = 'https://api.development.push.apple.com';
const APNS_HOST_PROD = 'https://api.push.apple.com';
const APNS_TOPIC = 'io.paulland.misapp';

// Support both process.env (local stdio) and explicit init (Worker).
let _keyP8: string | undefined;
let _keyId: string | undefined;
let _teamId: string | undefined;

export function initApns(keyP8?: string, keyId?: string, teamId?: string) {
  if (keyP8) _keyP8 = keyP8;
  if (keyId) _keyId = keyId;
  if (teamId) _teamId = teamId;
}

function getKeyP8() { return _keyP8 || process.env.APNS_KEY_P8; }
function getKeyId() { return _keyId || process.env.APNS_KEY_ID; }
function getTeamId() { return _teamId || process.env.APPLE_TEAM_ID; }

interface DeviceTokenRow {
  id: string;
  token: string;
  environment: 'development' | 'production';
  bundle_id: string;
}

interface CachedJWT { jwt: string; expiresAt: number; }
let cachedJWT: CachedJWT | null = null;

/**
 * Fan out a push to every registered device for `bundle_id`. Best-effort —
 * a 410 (BadDeviceToken) deletes the row; any other failure is logged and
 * skipped. Returns the count of successful sends.
 */
export async function fanoutPush(
  bundleId: string,
  payload: { title: string; body: string; jobId: string; wcpUrl?: string; category?: string }
): Promise<number> {
  const keyP8 = getKeyP8();
  const keyId = getKeyId();
  const teamId = getTeamId();
  if (!keyP8 || !keyId || !teamId) {
    console.log('[apns] secrets missing — skipping push');
    return 0;
  }

  const rows = (await supabaseGet(
    `device_tokens?bundle_id=eq.${encodeURIComponent(bundleId)}&select=id,token,environment,bundle_id`
  )) as DeviceTokenRow[];
  if (!rows.length) {
    console.log(`[apns] no device tokens registered for ${bundleId}`);
    return 0;
  }

  const jwt = await getOrSignJWT(keyP8, keyId, teamId);
  let ok = 0;
  await Promise.all(rows.map(async (row) => {
    const host = row.environment === 'production' ? APNS_HOST_PROD : APNS_HOST_DEV;
    const url = `${host}/3/device/${row.token}`;
    const aps: any = {
      alert: { title: payload.title, body: payload.body },
      sound: 'default',
    };
    if (payload.category) aps.category = payload.category;
    const apnsBody: Record<string, unknown> = { aps, jobId: payload.jobId };
    if (payload.wcpUrl) apnsBody.wcpUrl = payload.wcpUrl;
    const body = JSON.stringify(apnsBody);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `bearer ${jwt}`,
          'apns-topic': APNS_TOPIC,
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'content-type': 'application/json',
        },
        body,
      });
      if (resp.ok) {
        ok++;
        return;
      }
      if (resp.status === 410) {
        // BadDeviceToken — prune the row so we stop sending to a dead token.
        const supaUrl = process.env.SUPABASE_URL;
        const supaKey = process.env.SUPABASE_SERVICE_KEY;
        if (supaUrl && supaKey) {
          await fetch(`${supaUrl}/rest/v1/device_tokens?id=eq.${row.id}`, {
            method: 'DELETE',
            headers: { apikey: supaKey, Authorization: `Bearer ${supaKey}` },
          });
        }
        console.log(`[apns] pruned dead token ${row.token.slice(0, 8)}… (HTTP 410)`);
        return;
      }
      const text = await resp.text().catch(() => '');
      console.warn(`[apns] HTTP ${resp.status} on token ${row.token.slice(0, 8)}…: ${text.slice(0, 200)}`);
    } catch (err: any) {
      console.warn(`[apns] transport error on token ${row.token.slice(0, 8)}…: ${err.message}`);
    }
  }));
  console.log(`[apns] fanout ${bundleId}: ${ok}/${rows.length} sent`);
  return ok;
}

// ─── JWT signing ──────────────────────────────────────────────

async function getOrSignJWT(keyP8: string, keyId: string, teamId: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedJWT && cachedJWT.expiresAt > now + 60) return cachedJWT.jwt;

  const privateKey = await importP8Key(keyP8);
  const header = { alg: 'ES256', kid: keyId, typ: 'JWT' };
  const payload = { iss: teamId, iat: now };
  const headerB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;

  const sigBuf = await crypto.subtle.sign(
    { name: 'ECDSA', hash: { name: 'SHA-256' } },
    privateKey,
    new TextEncoder().encode(signingInput)
  );
  const sigB64 = base64UrlEncode(new Uint8Array(sigBuf));
  const jwt = `${signingInput}.${sigB64}`;

  cachedJWT = { jwt, expiresAt: now + 50 * 60 };
  return jwt;
}

async function importP8Key(pem: string): Promise<CryptoKey> {
  const cleaned = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const der = base64Decode(cleaned);
  return crypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
}

function base64UrlEncode(bytes: Uint8Array): string {
  let str = '';
  for (let i = 0; i < bytes.byteLength; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64Decode(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const len = bin.length;
  const buf = new ArrayBuffer(len);
  const view = new Uint8Array(buf);
  for (let i = 0; i < len; i++) view[i] = bin.charCodeAt(i);
  return buf;
}
