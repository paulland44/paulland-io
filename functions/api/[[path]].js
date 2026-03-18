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
 *   GET  /api/calendar-events  — Fetch calendar events for a date from ICS feed
 */

export async function onRequest(context) {
  const { request, env } = context;

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: corsHeaders(),
    });
  }

  // Validate Cloudflare Access JWT
  const authResult = await validateAccessJWT(request, env);
  if (!authResult.valid) {
    return json({ error: 'Unauthorized', detail: authResult.reason }, 401);
  }

  // Route to handler
  const url = new URL(request.url);
  const path = url.pathname.replace('/api/', '');

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
        return handleUpdateTags(request, env);
      case 'daily-notes':
        return handleUpsertDailyNote(request, env);
      default:
        return json({ error: 'Not found' }, 404);
    }
  }

  return json({ error: 'Method not allowed' }, 405);
}

// ─── Handlers ────────────────────────────────────────────────

async function handleUpdateTags(request, env) {
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

  return json({ ok: true, tags: cleanTags });
}

async function handleUpsertDailyNote(request, env) {
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
  return json({ ok: true, daily_note: data[0] });
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
    // Fetch the ICS feed
    const icsRes = await fetch(icsUrl, {
      headers: { 'User-Agent': 'PaullandIO-Calendar/1.0' },
    });

    if (!icsRes.ok) {
      return json({ error: 'Failed to fetch calendar', status: icsRes.status }, 502);
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
  // DTSTART;TZID=Europe/London:20260318T100000
  // DTSTART:20260318T100000Z
  // DTSTART;VALUE=DATE:20260318
  const colonIdx = line.indexOf(':');
  if (colonIdx === -1) return null;

  const params = line.substring(0, colonIdx);
  const value = line.substring(colonIdx + 1).trim();

  const allDay = params.includes('VALUE=DATE') || (value.length === 8 && /^\d{8}$/.test(value));
  const dateOnly = value.substring(0, 8); // YYYYMMDD

  let time = '';
  if (!allDay && value.length >= 15) {
    // Extract HH:MM from HHMMSS
    time = value.substring(9, 11) + ':' + value.substring(11, 13);
  }

  return { dateOnly, time, allDay, raw: value };
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
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
