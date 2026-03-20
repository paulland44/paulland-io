/**
 * One-time import of existing weekly/monthly/support summaries
 * from the Obsidian knowledge base into Supabase via REST API.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scripts/import-summaries.js
 *
 * No dependencies needed — uses native fetch and fs.
 */

const { readFileSync, readdirSync } = require('fs');
const { join } = require('path');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_KEY env vars');
  process.exit(1);
}

const KB = '/Users/pala/Documents/knowledge-base';

// ─── Helpers ─────────────────────────────────────────────────

function parseFrontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: text };
  const meta = {};
  match[1].split('\n').forEach(line => {
    const m = line.match(/^(\w+):\s*(.+)$/);
    if (m) meta[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  });
  return { meta, body: match[2] };
}

function cleanObsidianLinks(text) {
  // [[link|display]] → display
  text = text.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2');
  // [[link]] → link (strip path prefixes like brain/weekly/)
  text = text.replace(/\[\[(?:[^/\]]+\/)*([^\]]+)\]\]/g, '$1');
  return text;
}

function isoWeekToDate(year, week) {
  const jan4 = new Date(year, 0, 4);
  const dayOfWeek = jan4.getDay() || 7;
  const monday = new Date(jan4);
  monday.setDate(jan4.getDate() - dayOfWeek + 1 + (week - 1) * 7);
  return monday;
}

function dateStr(d) {
  return d.toISOString().split('T')[0];
}

function extractPeriodDates(body, filename) {
  let m = body.match(/\*\*Period:\*\*\s*(\d{4}-\d{2}-\d{2})\s+to\s+(\d{4}-\d{2}-\d{2})/);
  if (m) return { start: m[1], end: m[2] };

  m = body.match(/\*\*Week of:\*\*\s*(\d{4}-\d{2}-\d{2})\s+to\s+(\d{4}-\d{2}-\d{2})/);
  if (m) return { start: m[1], end: m[2] };

  m = body.match(/Week of (\d{1,2}) (\w+) (\d{4})/);
  if (m) {
    const d = new Date(`${m[2]} ${m[1]}, ${m[3]}`);
    const end = new Date(d);
    end.setDate(d.getDate() + 4);
    return { start: dateStr(d), end: dateStr(end) };
  }

  m = filename.match(/(\d{4})-W(\d{2})/);
  if (m) {
    const mon = isoWeekToDate(parseInt(m[1]), parseInt(m[2]));
    const fri = new Date(mon);
    fri.setDate(mon.getDate() + 4);
    return { start: dateStr(mon), end: dateStr(fri) };
  }

  m = filename.match(/^(\d{4})-(\d{2})\.md$/);
  if (m) {
    const y = parseInt(m[1]), mo = parseInt(m[2]);
    const start = `${y}-${m[2]}-01`;
    const lastDay = new Date(y, mo, 0).getDate();
    const end = `${y}-${m[2]}-${lastDay}`;
    return { start, end };
  }

  return null;
}

function extractSupportDate(body, filename) {
  let m = body.match(/\((\d{4}-\d{2}-\d{2})\)/);
  if (m) {
    const d = new Date(m[1] + 'T12:00:00');
    const dayOfWeek = d.getDay() || 7;
    const monday = new Date(d);
    monday.setDate(d.getDate() - dayOfWeek + 1);
    const friday = new Date(monday);
    friday.setDate(monday.getDate() + 4);
    return { start: dateStr(monday), end: dateStr(friday) };
  }

  m = filename.match(/(\d{4})-W(\d{2})/);
  if (m) {
    const mon = isoWeekToDate(parseInt(m[1]), parseInt(m[2]));
    const fri = new Date(mon);
    fri.setDate(mon.getDate() + 4);
    return { start: dateStr(mon), end: dateStr(fri) };
  }

  return null;
}

async function upsertSummary(record) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/summaries?on_conflict=type,period_start`,
    {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(record),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase error ${res.status}: ${text}`);
  }
}

// ─── Import ─────────────────────────────────────────────────

async function importFile(filePath, filename) {
  const raw = readFileSync(filePath, 'utf-8');
  const { meta, body } = parseFrontmatter(raw);
  const content = cleanObsidianLinks(body.trim());

  let type;
  if (meta.type === 'weekly-summary') type = 'weekly';
  else if (meta.type === 'monthly-review') type = 'monthly';
  else if (meta.type === 'support') type = 'support';
  else {
    console.warn(`  Skipping ${filename}: unknown type "${meta.type}"`);
    return false;
  }

  let dates;
  if (type === 'support') {
    dates = extractSupportDate(content, filename);
  } else {
    dates = extractPeriodDates(content, filename);
  }

  if (!dates) {
    console.warn(`  Skipping ${filename}: could not extract dates`);
    return false;
  }

  const record = {
    type,
    period_start: dates.start,
    period_end: dates.end,
    content,
    metadata: {
      imported_from: filePath,
      imported_at: new Date().toISOString(),
      original_title: meta.title || filename,
    },
  };

  try {
    await upsertSummary(record);
    console.log(`  OK  ${type.padEnd(8)} ${dates.start} → ${dates.end}  ${filename}`);
    return true;
  } catch (err) {
    console.error(`  ERR ${filename}: ${err.message}`);
    return false;
  }
}

async function main() {
  let imported = 0;

  console.log('\n── Weekly Summaries ──');
  const weeklyDir = join(KB, 'brain/weekly');
  for (const f of readdirSync(weeklyDir).filter(f => f.endsWith('.md')).sort()) {
    if (await importFile(join(weeklyDir, f), f)) imported++;
  }

  console.log('\n── Monthly Reviews ──');
  const monthlyDir = join(KB, 'brain/monthly');
  for (const f of readdirSync(monthlyDir).filter(f => f.endsWith('.md')).sort()) {
    if (await importFile(join(monthlyDir, f), f)) imported++;
  }

  console.log('\n── Support Reviews ──');
  const supportDir = join(KB, 'brain/products/support/Weekly Reviews');
  for (const f of readdirSync(supportDir).filter(f => f.endsWith('.md')).sort()) {
    if (await importFile(join(supportDir, f), f)) imported++;
  }

  console.log(`\nDone. Imported ${imported} summaries.`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
