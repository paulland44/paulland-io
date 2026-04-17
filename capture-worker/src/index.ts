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

async function runSyncs(env: Env): Promise<void> {
  // Calendar first — only needs 2 subrequests (fetch ICS + batch upsert)
  try {
    await syncCalendar(env);
  } catch (e) {
    console.error('Calendar sync failed:', e);
  }

  // Reader second — uses the remaining budget (~990 subrequests)
  try {
    await syncReader(env);
  } catch (e) {
    console.error('Reader sync failed:', e);
  }
}

export default {
  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
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

    if (url.pathname === '/trigger' && request.method === 'POST') {
      ctx.waitUntil(runSyncs(env));
      return new Response(
        JSON.stringify({ status: 'triggered', message: 'Sync started in background. Check worker logs for results.' }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response('Not found', { status: 404 });
  },
};
