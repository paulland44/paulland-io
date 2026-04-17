/**
 * ICS parser — optimised for Cloudflare Workers CPU limits.
 *
 * Parses large ICS feeds (5MB+) efficiently by:
 * - Single-pass parsing for all target dates
 * - Aggressive pre-filtering before full block parse
 * - Cached Intl.DateTimeFormat instances (expensive to create)
 * - Minimal regex usage — indexOf/slice where possible
 */

export interface CalendarEvent {
  uid: string;
  event_date: string; // YYYY-MM-DD
  title: string;
  start_time: string; // HH:MM or ""
  end_time: string;
  all_day: boolean;
  location: string;
  organizer: string;
  attendees: string[];
}

interface DateTimeInfo {
  date_only: string; // YYYYMMDD
  time: string; // HH:MM or ""
  all_day: boolean;
  is_utc: boolean;
  tzid: string | null;
  hour: number;
  minute: number;
}

// Windows timezone names → IANA
const WINDOWS_TO_IANA: Record<string, string> = {
  'Romance Standard Time': 'Europe/Paris',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central European Standard Time': 'Europe/Budapest',
  'Central Europe Standard Time': 'Europe/Prague',
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'UTC': 'UTC',
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'Pacific Standard Time': 'America/Los_Angeles',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'China Standard Time': 'Asia/Shanghai',
  'India Standard Time': 'Asia/Kolkata',
  'Singapore Standard Time': 'Asia/Singapore',
  'South Africa Standard Time': 'Africa/Johannesburg',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'FLE Standard Time': 'Europe/Kiev',
  'GTB Standard Time': 'Europe/Bucharest',
  'Russian Standard Time': 'Europe/Moscow',
  'Arab Standard Time': 'Asia/Riyadh',
  'Arabian Standard Time': 'Asia/Dubai',
  'Israel Standard Time': 'Asia/Jerusalem',
  'New Zealand Standard Time': 'Pacific/Auckland',
  'E. South America Standard Time': 'America/Sao_Paulo',
  'Atlantic Standard Time': 'America/Halifax',
  'US Eastern Standard Time': 'America/Indianapolis',
  'US Mountain Standard Time': 'America/Phoenix',
  'SA Pacific Standard Time': 'America/Bogota',
  'SE Asia Standard Time': 'Asia/Bangkok',
  'Korea Standard Time': 'Asia/Seoul',
  'West Pacific Standard Time': 'Pacific/Port_Moresby',
  'Taipei Standard Time': 'Asia/Taipei',
  'Cen. Australia Standard Time': 'Australia/Adelaide',
  'E. Australia Standard Time': 'Australia/Brisbane',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Alaskan Standard Time': 'America/Anchorage',
};

// Cached Intl formatters — creating these is very expensive
const fmtCache = new Map<string, Intl.DateTimeFormat>();
function getCachedFmt(tz: string): Intl.DateTimeFormat {
  let fmt = fmtCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    });
    fmtCache.set(tz, fmt);
  }
  return fmt;
}

/**
 * Parse ICS text and return events for ALL target dates in a single pass.
 */
export function parseIcsForDates(
  icsText: string,
  targetDates: string[],
  userTz: string
): CalendarEvent[] {
  const events: CalendarEvent[] = [];

  // Pre-compute bounds
  const sortedDates = [...targetDates].sort();
  const minDate = sortedDates[0];
  const maxDate = sortedDates[sortedDates.length - 1];
  // Numeric for fast comparison
  const minNum = parseInt(minDate, 10);
  const maxNum = parseInt(maxDate, 10);

  // Pre-warm the user timezone formatter
  getCachedFmt(userTz);

  // Iterate VEVENT blocks using indexOf (no split)
  let pos = 0;
  let blockCount = 0;
  let parsedCount = 0;

  while (true) {
    const start = icsText.indexOf('BEGIN:VEVENT', pos);
    if (start === -1) break;
    const end = icsText.indexOf('END:VEVENT', start);
    if (end === -1) break;
    pos = end + 10;
    blockCount++;

    const blockStart = start + 12; // skip "BEGIN:VEVENT"
    const block = icsText.slice(blockStart, end);

    // --- FAST PRE-FILTER (no regex, no string allocation beyond slice) ---
    // Skip cancelled
    if (block.indexOf('STATUS:CANCELLED') !== -1) continue;

    // Quick date extraction
    const rawDate = quickExtractDate(block);
    const hasRrule = block.indexOf('RRULE:') !== -1;

    if (rawDate && !hasRrule) {
      const rawNum = parseInt(rawDate, 10);
      // Non-recurring: skip if clearly out of range (allow 2-day buffer for TZ)
      if (rawNum > maxNum + 2) continue;
      if (rawNum < minNum - 31) continue; // could be multi-day
    }

    // --- FULL PARSE (only for candidates) ---
    parsedCount++;

    // Unfold continuation lines
    const unfolded = unfoldLines(block);
    const parsed = parseBlock(unfolded, userTz);
    if (!parsed) continue;

    const { dtstart, dtend, props, attendees } = parsed;
    const startDate = dtstart.date_only;
    const endDate = dtend?.date_only || startDate;

    // Check each target date
    for (const targetDate of targetDates) {
      let matches = false;
      if (startDate === targetDate) {
        matches = true;
      } else if (startDate < targetDate && endDate > targetDate) {
        matches = true;
      }

      if (!matches && props.rrule) {
        matches = checkRecurrence(props.rrule, startDate, targetDate);
      }
      if (!matches) continue;

      const ed = targetDate;
      events.push({
        uid: props.uid || '',
        event_date: `${ed.slice(0, 4)}-${ed.slice(4, 6)}-${ed.slice(6, 8)}`,
        title: props.summary || 'Untitled Event',
        start_time: dtstart.time || '',
        end_time: dtend?.time || '',
        all_day: dtstart.all_day,
        location: props.location || '',
        organizer: props.organizer || '',
        attendees,
      });
    }
  }

  console.log(`ICS: ${blockCount} blocks, ${parsedCount} fully parsed, ${events.length} matched`);

  events.sort((a, b) => {
    const d = a.event_date.localeCompare(b.event_date);
    return d !== 0 ? d : (a.start_time || '0000').localeCompare(b.start_time || '0000');
  });
  return events;
}

function quickExtractDate(block: string): string | null {
  const idx = block.indexOf('DTSTART');
  if (idx === -1) return null;
  const colonIdx = block.indexOf(':', idx + 7);
  if (colonIdx === -1 || colonIdx > idx + 80) return null;
  const s = block.slice(colonIdx + 1, colonIdx + 9);
  // Fast digit check
  for (let i = 0; i < 8; i++) {
    if (i >= s.length) return null;
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) return null;
  }
  return s;
}

/**
 * Unfold RFC 5545 continuation lines — manual approach (no regex on large strings)
 */
function unfoldLines(block: string): string[] {
  const result: string[] = [];
  let current = '';

  const len = block.length;
  let i = 0;
  while (i < len) {
    // Find end of line
    let eol = block.indexOf('\n', i);
    if (eol === -1) eol = len;

    let line = block.slice(i, eol);
    // Strip trailing \r
    if (line.endsWith('\r')) line = line.slice(0, -1);

    i = eol + 1;

    // Check if next line is a continuation (starts with space or tab)
    if (i < len && (block.charCodeAt(i) === 32 || block.charCodeAt(i) === 9)) {
      current += line;
      continue;
    }

    if (current) {
      current += line;
      result.push(current);
      current = '';
    } else {
      result.push(line);
    }
  }
  if (current) result.push(current);
  return result;
}

interface ParsedBlock {
  dtstart: DateTimeInfo;
  dtend: DateTimeInfo | null;
  props: Record<string, string>;
  attendees: string[];
}

function parseBlock(lines: string[], userTz: string): ParsedBlock | null {
  let dtstart: DateTimeInfo | null = null;
  let dtend: DateTimeInfo | null = null;
  const props: Record<string, string> = {};
  const attendees: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const c = line.charCodeAt(0);

    if (c === 68) { // D
      if (line.startsWith('DTSTART')) {
        dtstart = convertToUserTz(extractDateTime(line), userTz);
      } else if (line.startsWith('DTEND')) {
        dtend = convertToUserTz(extractDateTime(line), userTz);
      }
    } else if (c === 83) { // S
      if (line.startsWith('SUMMARY:')) {
        props.summary = line.slice(8).trim();
      }
    } else if (c === 76 && line.startsWith('LOCATION:')) { // L
      props.location = line.slice(9).trim();
    } else if (c === 79 && line.startsWith('ORGANIZER')) { // O
      props.organizer = extractCn(line) || extractMailto(line) || '';
    } else if (c === 65 && line.startsWith('ATTENDEE')) { // A
      if (attendees.length < 20) {
        const name = extractCn(line) || extractMailto(line);
        if (name) attendees.push(name);
      }
    } else if (c === 85 && line.startsWith('UID:')) { // U
      props.uid = line.slice(4).trim();
    } else if (c === 82 && line.startsWith('RRULE:')) { // R
      props.rrule = line.slice(6).trim();
    }
  }

  if (!dtstart) return null;
  return { dtstart, dtend, props, attendees };
}

function extractDateTime(line: string): DateTimeInfo | null {
  // Find the colon that separates params from value
  const colonIdx = line.indexOf(':');
  if (colonIdx === -1) return null;
  const value = line.slice(colonIdx + 1).trim();

  // Value should be YYYYMMDD or YYYYMMDDTHHmmss or YYYYMMDDTHHmmssZ
  if (value.length < 8) return null;
  const date_only = value.slice(0, 8);

  const isDateOnly = value.length === 8 || line.indexOf('VALUE=DATE') !== -1;
  const is_utc = value.endsWith('Z');

  let time = '';
  let hour = 0;
  let minute = 0;
  if (!isDateOnly && value.length >= 15) {
    hour = parseInt(value.slice(9, 11), 10);
    minute = parseInt(value.slice(11, 13), 10);
    time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }

  let tzid: string | null = null;
  const tzIdx = line.indexOf('TZID=');
  if (tzIdx !== -1) {
    const tzEnd = line.indexOf(':', tzIdx);
    if (tzEnd !== -1) {
      tzid = line.slice(tzIdx + 5, tzEnd).trim();
    }
  }

  return { date_only, time, all_day: isDateOnly, is_utc, tzid, hour, minute };
}

function convertToUserTz(
  dtInfo: DateTimeInfo | null,
  userTzName: string
): DateTimeInfo | null {
  if (!dtInfo || dtInfo.all_day || !dtInfo.time) return dtInfo;

  let sourceTzName: string | null = null;
  if (dtInfo.is_utc) {
    sourceTzName = 'UTC';
  } else if (dtInfo.tzid) {
    sourceTzName = WINDOWS_TO_IANA[dtInfo.tzid] || dtInfo.tzid;
  }

  if (!sourceTzName) return dtInfo;
  if (sourceTzName === userTzName) return dtInfo;

  try {
    const d = dtInfo.date_only;
    const year = parseInt(d.slice(0, 4), 10);
    const month = parseInt(d.slice(4, 6), 10) - 1;
    const day = parseInt(d.slice(6, 8), 10);

    const srcDate = new Date(
      Date.UTC(year, month, day, dtInfo.hour, dtInfo.minute, 0)
    );

    const srcOffset = getUtcOffset(srcDate, sourceTzName);
    const userOffset = getUtcOffset(srcDate, userTzName);

    const adjustMs = (userOffset - srcOffset) * 60_000;
    const userDate = new Date(srcDate.getTime() + adjustMs);

    dtInfo.date_only =
      `${userDate.getUTCFullYear()}${String(userDate.getUTCMonth() + 1).padStart(2, '0')}${String(userDate.getUTCDate()).padStart(2, '0')}`;
    dtInfo.time = `${String(userDate.getUTCHours()).padStart(2, '0')}:${String(userDate.getUTCMinutes()).padStart(2, '0')}`;
    dtInfo.hour = userDate.getUTCHours();
    dtInfo.minute = userDate.getUTCMinutes();
  } catch {
    // Conversion failed — return original
  }

  return dtInfo;
}

function getUtcOffset(date: Date, tzName: string): number {
  const fmt = getCachedFmt(tzName);
  const parts = fmt.formatToParts(date);
  const get = (type: string) =>
    parseInt(parts.find((p) => p.type === type)?.value || '0', 10);

  const tzDate = new Date(
    Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  );
  return Math.round((tzDate.getTime() - date.getTime()) / 60_000);
}

function extractCn(line: string): string | null {
  const idx = line.indexOf('CN=');
  if (idx === -1) return null;
  const start = idx + 3;
  // Find end: semicolon or colon
  let endIdx = line.length;
  const semi = line.indexOf(';', start);
  const colon = line.indexOf(':', start);
  if (semi !== -1 && semi < endIdx) endIdx = semi;
  if (colon !== -1 && colon < endIdx) endIdx = colon;
  const val = line.slice(start, endIdx).trim().replace(/^"|"$/g, '');
  return val || null;
}

function extractMailto(line: string): string | null {
  const idx = line.toLowerCase().indexOf('mailto:');
  if (idx === -1) return null;
  const start = idx + 7;
  let endIdx = line.length;
  for (let i = start; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === 59 || c === 32 || c === 10 || c === 13) { // ; space \n \r
      endIdx = i;
      break;
    }
  }
  return line.slice(start, endIdx).trim() || null;
}

function checkRecurrence(
  rrule: string,
  startStr: string,
  targetStr: string
): boolean {
  const start = parseYMD(startStr);
  const target = parseYMD(targetStr);
  if (!start || !target || target < start) return false;

  const parts: Record<string, string> = {};
  for (const p of rrule.split(';')) {
    const eq = p.indexOf('=');
    if (eq > 0) parts[p.slice(0, eq)] = p.slice(eq + 1);
  }

  const freq = parts.FREQ || '';
  const interval = parseInt(parts.INTERVAL || '1', 10);
  const until = parts.UNTIL || '';
  if (until && targetStr > until.slice(0, 8)) return false;

  const diffDays = Math.round((target.getTime() - start.getTime()) / 86_400_000);

  if (freq === 'DAILY') return diffDays % interval === 0;
  if (freq === 'WEEKLY') {
    if (parts.BYDAY) {
      const dayMap: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
      const tw = target.getDay();
      const days = parts.BYDAY.split(',').map((d) => dayMap[d.trim()] ?? -1);
      if (!days.includes(tw)) return false;
    }
    return diffDays % (7 * interval) < 7;
  }
  if (freq === 'MONTHLY') {
    const sd = new Date(start); const td = new Date(target);
    return sd.getDate() === td.getDate() &&
      ((td.getFullYear() - sd.getFullYear()) * 12 + td.getMonth() - sd.getMonth()) % interval === 0;
  }
  if (freq === 'YEARLY') {
    const sd = new Date(start); const td = new Date(target);
    return sd.getMonth() === td.getMonth() && sd.getDate() === td.getDate() &&
      (td.getFullYear() - sd.getFullYear()) % interval === 0;
  }
  return false;
}

function parseYMD(s: string): Date | null {
  if (s.length !== 8) return null;
  return new Date(parseInt(s.slice(0, 4), 10), parseInt(s.slice(4, 6), 10) - 1, parseInt(s.slice(6, 8), 10));
}
