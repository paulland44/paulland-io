/**
 * Capture Worker — Cloudflare Worker with Cron Triggers
 *
 * Replaces the Railway-hosted capture-bot for:
 * 1. Readwise Reader sync (content + feed items)
 * 2. Outlook Calendar sync (ICS → calendar_events)
 *
 * Runs every 30 minutes via cron trigger.
 *
 * IMPORTANT: Syncs run SEQUENTIALLY (not parallel) because Cloudflare Workers
 * have a 1000 subrequest limit per invocation, shared across all fetches.
 * Calendar runs first (~2 subrequests), then Reader gets the rest.
 */

import type { Env } from './supabase';
import { syncReader } from './reader-sync';
import { syncCalendar } from './calendar-sync';
import { syncEnrichment } from './enrichment-sync';

async function runSyncs(env: Env): Promise<void> {
  // Calendar first — only needs 2 subrequests (fetch ICS + batch upsert)
  try {
    await syncCalendar(env);
  } catch (e) {
    console.error('Calendar sync failed:', e);
  }

  // Enrichment second — bounded (≤20 rows × ~5 subrequests each = ~100 max)
  try {
    await syncEnrichment(env);
  } catch (e) {
    console.error('Enrichment sync failed:', e);
  }

  // Reader last — uses the remaining budget (~900 subrequests)
  try {
    await syncReader(env);
  } catch (e) {
    console.error('Reader sync failed:', e);
  }
}

export default {
  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    // Two crons fire into this handler. The fast */2 cron is
    // enrichment-only (keeps AE → WCP demos snappy); the */30 does the
    // full round (calendar + reader + enrichment).
    if (event.cron === '*/2 * * * *') {
      console.log('Capture worker fast cron — enrichment only');
      ctx.waitUntil(
        syncEnrichment(env).catch((e) => console.error('Enrichment sync failed:', e))
      );
      return;
    }
    console.log('Capture worker cron triggered');
    ctx.waitUntil(runSyncs(env));
  },

  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health' || url.pathname === '/') {
      return new Response(JSON.stringify({ status: 'ok', worker: 'capture-worker' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Diagnostic: SHA-256 first 12 of this worker's PAULLAND_INTERNAL_API_KEY
    // + round-trip to Pages to show their view. Remove once debugging done.
    if (url.pathname === '/_diag/key-fp') {
      const fp = async (s?: string) => {
        if (!s) return null;
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
        return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
      };
      const localFp = await fp(env.PAULLAND_INTERNAL_API_KEY);
      const localLen = env.PAULLAND_INTERNAL_API_KEY ? env.PAULLAND_INTERNAL_API_KEY.length : null;
      let pagesResp: any = null;
      try {
        const r = await fetch(`${env.PAULLAND_API_URL || 'https://paulland.io/api'}/_diag/key-fp`, {
          headers: { 'X-Internal-API-Key': env.PAULLAND_INTERNAL_API_KEY || '' },
        });
        pagesResp = await r.json().catch(() => ({ parseError: true }));
      } catch (e: any) {
        pagesResp = { fetchError: e.message };
      }
      return new Response(JSON.stringify({ place: 'capture-worker', localFp, localLen, pages: pagesResp }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/trigger' && request.method === 'POST') {
      ctx.waitUntil(runSyncs(env));
      return new Response(
        JSON.stringify({ status: 'triggered', message: 'Sync started in background. Check worker logs for results.' }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (url.pathname === '/trigger-enrichment' && request.method === 'POST') {
      ctx.waitUntil(
        syncEnrichment(env).catch((e) => console.error('Enrichment sync failed:', e))
      );
      return new Response(
        JSON.stringify({ status: 'triggered', sync: 'enrichment' }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response('Not found', { status: 404 });
  },
};
