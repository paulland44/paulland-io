/**
 * APNS sender for paulland-mis.
 *
 * Signs an ES256 JWT with the team's APNS .p8 key, then POSTs the push payload
 * to Apple's HTTP/2 endpoint. The JWT is cached for ~50 minutes (Apple caps
 * tokens at 60 min before rotation is required).
 *
 * Routing: development tokens go to `api.development.push.apple.com`; production
 * tokens go to `api.push.apple.com`. The `environment` column on `device_tokens`
 * drives that split — Xcode-installed Debug builds get dev tokens, TestFlight /
 * App Store builds get production tokens.
 */
import type { Env } from './supabase';
import { supabaseGet } from './supabase';

const APNS_HOST_DEV = 'https://api.development.push.apple.com';
const APNS_HOST_PROD = 'https://api.push.apple.com';
const APNS_TOPIC = 'io.paulland.misapp';

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
 * skipped so one bad token doesn't poison the rest.
 *
 * Returns the count of successful sends.
 */
export async function fanoutPush(
  env: Env,
  bundleId: string,
  payload: { title: string; body: string; jobId: string; wcpUrl?: string; category?: string }
): Promise<number> {
  if (!env.APNS_KEY_P8 || !env.APNS_KEY_ID || !env.APPLE_TEAM_ID) {
    console.log('[apns] secrets missing — skipping push');
    return 0;
  }
  const rows = (await supabaseGet(
    env.SUPABASE_URL,
    env.SUPABASE_SERVICE_KEY,
    `device_tokens?bundle_id=eq.${encodeURIComponent(bundleId)}&select=id,token,environment,bundle_id`
  )) as DeviceTokenRow[];
  if (!rows.length) {
    console.log(`[apns] no device tokens registered for ${bundleId}`);
    return 0;
  }

  const jwt = await getOrSignJWT(env);
  let ok = 0;
  await Promise.all(rows.map(async (row) => {
    const host = row.environment === 'production' ? APNS_HOST_PROD : APNS_HOST_DEV;
    const url = `${host}/3/device/${row.token}`;
    const aps: any = {
      alert: { title: payload.title, body: payload.body },
      sound: 'default',
    };
    // category enables UNNotificationAction buttons (e.g. "Open in WCP") on
    // the client. Must be registered with UNUserNotificationCenter on launch.
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
      // 410 Gone → uninstalled / token invalidated. Prune the row.
      if (resp.status === 410) {
        await fetch(
          `${env.SUPABASE_URL}/rest/v1/device_tokens?id=eq.${row.id}`,
          {
            method: 'DELETE',
            headers: {
              apikey: env.SUPABASE_SERVICE_KEY,
              Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
            },
          }
        );
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

async function getOrSignJWT(env: Env): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedJWT && cachedJWT.expiresAt > now + 60) return cachedJWT.jwt;

  const keyId = env.APNS_KEY_ID!;
  const teamId = env.APPLE_TEAM_ID!;
  const privateKey = await importP8Key(env.APNS_KEY_P8!);

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
  // WebCrypto returns raw r||s (64 bytes for P-256). JWT ES256 expects exactly that.
  const sigB64 = base64UrlEncode(new Uint8Array(sigBuf));
  const jwt = `${signingInput}.${sigB64}`;

  // Apple caps JWTs at 60 min — refresh at 50 to stay safe.
  cachedJWT = { jwt, expiresAt: now + 50 * 60 };
  return jwt;
}

/**
 * Import an Apple `.p8` private key. The .p8 file is PEM-encoded PKCS#8;
 * strip the BEGIN/END headers, base64-decode the body, and pass to subtle.
 */
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
