/**
 * Calendar sync — ported from capture-bot/src/calendar/sync.py
 *
 * Fetches ICS feed from Outlook, parses events for the next 7 days,
 * and upserts them into the calendar_events table.
 */

import type { Env } from './supabase';
import { supabaseUpsert } from './supabase';
import { parseIcsForDates, type CalendarEvent } from './ics-parser';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

export async function syncCalendar(env: Env): Promise<number> {
  const icsUrl = env.OUTLOOK_ICS_URL;
  if (!icsUrl) {
    console.log('OUTLOOK_ICS_URL not set — calendar sync skipped');
    return 0;
  }

  const { SUPABASE_URL: url, SUPABASE_SERVICE_KEY: key } = env;
  const userTz = env.USER_TIMEZONE || 'Europe/London';
  // Sync today + 30 days ahead so the iOS app can show meetings on dates the user is
  // planning notes for (was 7; widened 2026-05-09).
  const daysAhead = 30;

  console.log('Fetching calendar ICS feed...');
  let icsText: string;
  try {
    const resp = await fetch(icsUrl, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(60_000),
    });
    if (!resp.ok) {
      console.error(`ICS fetch failed: ${resp.status}`);
      return 0;
    }
    icsText = await resp.text();
  } catch (e) {
    console.error('Failed to fetch ICS feed:', e);
    return 0;
  }

  console.log(`Parsing ICS feed (${icsText.length} bytes)...`);

  // Build target dates: today + daysAhead
  const today = new Date();
  const targetDates: string[] = [];
  for (let d = 0; d <= daysAhead; d++) {
    const dt = new Date(today);
    dt.setDate(today.getDate() + d);
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const day = String(dt.getDate()).padStart(2, '0');
    targetDates.push(`${y}${m}${day}`);
  }

  // Single-pass parse for all target dates (avoids re-parsing 5MB+ ICS per date)
  const allEvents = parseIcsForDates(icsText, targetDates, userTz);

  if (allEvents.length === 0) {
    console.log(`No calendar events found for next ${daysAhead} days`);
    return 0;
  }

  // Deduplicate by (uid, event_date) — recurring events can produce duplicates
  const seen = new Set<string>();
  const dedupedEvents = allEvents.filter((evt) => {
    const key = `${evt.uid}|${evt.event_date}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Batch upsert to Supabase (single request to avoid subrequest limits)
  const now = new Date().toISOString();
  const rows = dedupedEvents.map((evt) => ({
    uid: evt.uid,
    event_date: evt.event_date,
    title: evt.title,
    start_time: evt.start_time,
    end_time: evt.end_time,
    all_day: evt.all_day,
    location: evt.location,
    organizer: evt.organizer,
    attendees: evt.attendees,
    synced_at: now,
  }));

  const result = await supabaseUpsert(url, key, 'calendar_events', rows, 'uid,event_date');
  if (!result.ok) {
    console.error(`Calendar batch upsert failed: ${result.error}`);
    return 0;
  }

  // Clean up stale future rows: anything in [today, today+daysAhead] whose synced_at
  // is NOT this sync's timestamp must have been dropped from Outlook (e.g. a meeting
  // moved to a different date, or was deleted/declined). Without this, moved meetings
  // duplicate — the old date's row sticks around even though Outlook no longer has it.
  const fmtDate = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const todayStr = fmtDate(today);
  const lastDt = new Date(today);
  lastDt.setDate(today.getDate() + daysAhead);
  const lastStr = fmtDate(lastDt);

  const delUrl =
    `${url}/rest/v1/calendar_events` +
    `?event_date=gte.${todayStr}&event_date=lte.${lastStr}` +
    `&synced_at=neq.${encodeURIComponent(now)}`;
  try {
    const delRes = await fetch(delUrl, {
      method: 'DELETE',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Prefer: 'return=minimal',
      },
    });
    if (!delRes.ok) {
      const body = await delRes.text().catch(() => '');
      console.error(`Stale calendar cleanup failed: ${delRes.status} ${body.substring(0, 200)}`);
    }
  } catch (e) {
    console.error('Stale calendar cleanup error:', e);
  }

  console.log(`Calendar sync complete: ${rows.length} events upserted, range ${todayStr}..${lastStr}`);
  return rows.length;
}
