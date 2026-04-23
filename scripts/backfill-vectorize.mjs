#!/usr/bin/env node
/**
 * Backfill Cloudflare Vectorize from the Supabase embeddings table source rows.
 *
 * Run from laptop against production. Reads env vars:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY, CF_ACCOUNT_ID, CF_API_TOKEN
 *
 * Embeds via Cloudflare AI REST (@cf/baai/bge-base-en-v1.5 → 768 dim) and
 * upserts directly into the paulland-kb Vectorize index via REST (NDJSON).
 *
 * Idempotent: vector IDs are deterministic ({table}:{id}:{chunk}), so a
 * re-run overwrites prior uploads for the same source rows.
 *
 * Resume state is written to .backfill-state.json after each completed table.
 * Delete that file to start over.
 */

import fs from 'node:fs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_API_TOKEN = process.env.CF_API_TOKEN;
const VECTORIZE_INDEX = 'paulland-kb';
const STATE_FILE = '.backfill-state.json';

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !CF_ACCOUNT_ID || !CF_API_TOKEN) {
  console.error('Missing env vars. Required: SUPABASE_URL, SUPABASE_SERVICE_KEY, CF_ACCOUNT_ID, CF_API_TOKEN');
  process.exit(1);
}

// ─── Tables to backfill (matches EMBEDDABLE_TABLES in mcp-server) ───

const TABLES = [
  'content',
  'daily_notes',
  'summaries',
  'people',
  'companies',
  'products',
  'projects',
  'people_log',
  'product_evidence',
  'product_decisions',
  'reflections_log',
  'persona_log',
  'research_log',
  'tasks',
];

// ─── Supabase helpers ─────────────────────────────────────────

async function supabaseGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`Supabase GET ${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

async function supabasePatch(path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase PATCH ${path} → ${res.status} ${await res.text()}`);
}

// ─── Embed text builders (mirrors mcp-server/src/embeddings.ts) ───

function buildEmbeddingText(table, row) {
  switch (table) {
    case 'content': {
      const prefixMap = {
        article: 'Article', thought: 'Thought', signal: 'Signal',
        reflection: 'Reflection', reference: 'Reference', problem: 'Problem',
        strategy: 'Strategy', solution: 'Solution', feature: 'Feature',
        product: 'Product', project: 'Project', collection: 'Collection',
      };
      const prefix = prefixMap[row.type] || row.type || 'Content';
      const parts = [`${prefix}: ${row.title || 'Untitled'}`];
      if (row.body) parts.push(row.body);
      if (row.tags?.length) parts.push(`Tags: ${row.tags.join(', ')}`);
      return parts.join('\n');
    }
    case 'daily_notes': {
      const summary = row.metadata?.review_summary;
      if (summary) return `Daily Note ${row.note_date}:\n${summary}`;
      const parts = [`Daily Note ${row.note_date}:`];
      if (row.tasks) parts.push(`Tasks:\n${row.tasks}`);
      if (row.notes) parts.push(`Notes:\n${row.notes}`);
      if (row.meetings) parts.push(`Meetings:\n${row.meetings}`);
      return parts.join('\n').substring(0, 4000);
    }
    case 'summaries':
      return `${row.type} Summary (${row.period_start} to ${row.period_end}):\n${row.content || ''}`;
    case 'people': {
      const parts = [`Person: ${row.name}`];
      if (row.role) parts.push(`Role: ${row.role}`);
      if (row.organization) parts.push(`Organization: ${row.organization}`);
      if (row.tags?.length) parts.push(`Tags: ${row.tags.join(', ')}`);
      return parts.join('\n');
    }
    case 'companies': {
      const parts = [`Company: ${row.name}`];
      if (row.type) parts.push(`Type: ${row.type}`);
      if (row.industry) parts.push(`Industry: ${row.industry}`);
      if (row.notes) parts.push(row.notes);
      if (row.tags?.length) parts.push(`Tags: ${row.tags.join(', ')}`);
      return parts.join('\n');
    }
    case 'products': {
      const parts = [`Product: ${row.name}`];
      if (row.overview) parts.push(row.overview);
      if (row.description) parts.push(row.description);
      if (row.tags?.length) parts.push(`Tags: ${row.tags.join(', ')}`);
      return parts.join('\n');
    }
    case 'projects': {
      const parts = [`Project: ${row.name}`];
      if (row.status) parts.push(`Status: ${row.status}`);
      if (row.description) parts.push(row.description);
      if (row.tags?.length) parts.push(`Tags: ${row.tags.join(', ')}`);
      return parts.join('\n');
    }
    case 'people_log':
      return `People Note (${row.note_date}): ${row.entry || ''}`;
    case 'product_evidence':
      return `Product Evidence (${row.note_date}, ${row.evidence_type || 'observation'}): ${row.evidence || ''}`;
    case 'product_decisions':
      return `Decision (${row.note_date}): ${row.decision || ''}\nContext: ${row.context || ''}`;
    case 'reflections_log':
      return `Reflection (${row.note_date}, ${row.category || 'leadership'}): ${row.observation || ''}\nCoach: ${row.coach_perspective || ''}`;
    case 'persona_log':
      return `Persona Update (${row.log_date}, ${row.section_updated || 'general'}): ${row.entry || ''}`;
    case 'research_log':
      return `Research Update (${row.log_date}, ${row.section_updated || 'general'}): ${row.entry || ''}`;
    case 'tasks': {
      const parts = [`Task: ${row.title || '(untitled)'}`];
      if (row.status) parts.push(`Status: ${row.status}`);
      if (row.priority) parts.push(`Priority: ${row.priority}`);
      if (row.due_date) parts.push(`Due: ${row.due_date}`);
      if (row.description) parts.push(row.description);
      if (row.source_ref) parts.push(`Source: ${row.source_ref}`);
      if (row.tags?.length) parts.push(`Tags: ${row.tags.join(', ')}`);
      return parts.join('\n');
    }
    default:
      return JSON.stringify(row);
  }
}

function buildMetadata(table, row) {
  const m = { source_table: table };
  switch (table) {
    case 'content':
      m.title = row.title || '';
      m.type = row.type || '';
      m.date = row.captured_at || '';
      break;
    case 'daily_notes':
      m.title = `Daily Note ${row.note_date}`;
      m.date = row.note_date;
      break;
    case 'summaries':
      m.title = `${row.type} Summary (${row.period_start} to ${row.period_end})`;
      m.type = row.type;
      m.date = row.period_start;
      break;
    case 'people':
      m.title = row.name || '';
      break;
    case 'companies':
      m.title = row.name || '';
      m.type = row.type || '';
      break;
    case 'products':
    case 'projects':
      m.title = row.name || '';
      if (row.status) m.status = row.status;
      break;
    case 'people_log':
    case 'product_evidence':
    case 'product_decisions':
    case 'reflections_log':
      m.title = table.replace(/_/g, ' ');
      m.date = row.note_date;
      break;
    case 'persona_log':
    case 'research_log':
      m.title = table.replace(/_/g, ' ');
      m.date = row.log_date;
      break;
    case 'tasks':
      m.title = row.title || 'Task';
      m.date = row.due_date || '';
      if (row.status) m.status = row.status;
      if (row.priority) m.priority = row.priority;
      break;
  }
  return m;
}

// ─── Chunking (mirrors chunkText in embeddings.ts) ───

function chunkText(text, maxChars = 2000) {
  if (text.length <= maxChars) return [{ chunkIndex: 0, text }];
  const firstNewline = text.indexOf('\n');
  const titlePrefix = firstNewline > 0 && firstNewline < 200 ? text.substring(0, firstNewline) : '';
  const body = titlePrefix ? text.substring(firstNewline + 1) : text;
  const rawParagraphs = body.split(/\n\n+/);
  const paragraphs = [];
  for (const para of rawParagraphs) {
    if (para.length <= maxChars) paragraphs.push(para);
    else for (let i = 0; i < para.length; i += maxChars) paragraphs.push(para.substring(i, i + maxChars));
  }
  const chunks = [];
  let current = titlePrefix;
  let idx = 0;
  for (const para of paragraphs) {
    if (current.length + para.length + 2 > maxChars && current.length > titlePrefix.length) {
      chunks.push({ chunkIndex: idx++, text: current.trim() });
      current = titlePrefix ? titlePrefix + '\n' + para : para;
    } else {
      current += (current ? '\n\n' : '') + para;
    }
  }
  if (current.trim()) chunks.push({ chunkIndex: idx, text: current.trim() });
  return chunks;
}

// ─── Cloudflare AI REST (embeddings) ───

async function cfEmbed(texts) {
  const MAX_SUB_INPUTS = 80;
  const MAX_SUB_CHARS = 360_000;
  const out = [];
  let i = 0;
  while (i < texts.length) {
    const sub = [];
    let chars = 0;
    while (i < texts.length && sub.length < MAX_SUB_INPUTS && (sub.length === 0 || chars + texts[i].length <= MAX_SUB_CHARS)) {
      sub.push(texts[i]);
      chars += texts[i].length;
      i++;
    }
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/@cf/baai/bge-base-en-v1.5`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: sub }),
      }
    );
    if (!res.ok) throw new Error(`CF AI ${res.status}: ${await res.text()}`);
    const data = await res.json();
    if (!data.result?.data) throw new Error('CF AI: no data');
    out.push(...data.result.data);
  }
  return out;
}

// ─── Vectorize REST (upsert) ───

async function vectorizeUpsert(vectors) {
  if (!vectors.length) return;
  // Upsert in batches of 500 (Vectorize accepts larger, but smaller batches
  // mean shorter retries on transient failures)
  const BATCH = 500;
  for (let i = 0; i < vectors.length; i += BATCH) {
    const slice = vectors.slice(i, i + BATCH);
    const ndjson = slice.map((v) => JSON.stringify(v)).join('\n');
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/vectorize/v2/indexes/${VECTORIZE_INDEX}/upsert`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/x-ndjson' },
        body: ndjson,
      }
    );
    if (!res.ok) throw new Error(`Vectorize upsert ${res.status}: ${await res.text()}`);
  }
}

// ─── State ───

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { completedTables: [] };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ─── Main ───

async function backfillTable(table) {
  console.log(`\n── ${table} ──`);
  const PAGE = 100;
  let offset = 0;
  let totalRows = 0;
  let totalChunks = 0;
  let errors = 0;

  while (true) {
    const rows = await supabaseGet(`${table}?select=*&order=id&limit=${PAGE}&offset=${offset}`);
    if (!rows.length) break;

    for (const row of rows) {
      try {
        const rawText = buildEmbeddingText(table, row);
        if (!rawText || rawText.length < 10) {
          continue; // skip empty rows
        }
        const MAX = 80_000;
        const text = rawText.length > MAX ? rawText.substring(0, MAX) : rawText;
        const chunks = chunkText(text);
        const meta = buildMetadata(table, row);

        const embeddings = await cfEmbed(chunks.map((c) => c.text));
        if (embeddings.length !== chunks.length) {
          console.warn(`  [${table}/${row.id}] embed count mismatch (${embeddings.length} vs ${chunks.length})`);
          errors++;
          continue;
        }

        const vectors = chunks.map((chunk, i) => ({
          id: `${table}:${row.id}:${chunk.chunkIndex}`,
          values: embeddings[i],
          metadata: {
            source_table: table,
            source_id: row.id,
            chunk_index: chunk.chunkIndex,
            type: meta.type || '',
            date: meta.date || '',
            title: meta.title || '',
            text: chunk.text,
          },
        }));
        await vectorizeUpsert(vectors);
        await supabasePatch(`${table}?id=eq.${row.id}`, { embedded_at: new Date().toISOString() });

        totalRows++;
        totalChunks += vectors.length;
      } catch (err) {
        console.warn(`  [${table}/${row.id}] ${err.message}`);
        errors++;
      }
    }

    process.stdout.write(`  rows=${totalRows} chunks=${totalChunks} errors=${errors}\r`);
    offset += rows.length;
    if (rows.length < PAGE) break;
  }

  console.log(`\n  done: ${totalRows} rows, ${totalChunks} chunks, ${errors} errors`);
  return { rows: totalRows, chunks: totalChunks, errors };
}

async function main() {
  const state = loadState();
  const totals = { rows: 0, chunks: 0, errors: 0 };
  const startedAt = Date.now();

  for (const table of TABLES) {
    if (state.completedTables.includes(table)) {
      console.log(`\n── ${table} ── (already done, skipping)`);
      continue;
    }
    try {
      const r = await backfillTable(table);
      totals.rows += r.rows;
      totals.chunks += r.chunks;
      totals.errors += r.errors;
      state.completedTables.push(table);
      saveState(state);
    } catch (err) {
      console.error(`\nFATAL on ${table}: ${err.message}`);
      saveState(state);
      process.exit(1);
    }
  }

  const mins = ((Date.now() - startedAt) / 60_000).toFixed(1);
  console.log(`\n══ backfill complete in ${mins}m ══`);
  console.log(`   ${totals.rows} rows, ${totals.chunks} chunks, ${totals.errors} errors`);
  console.log(`   state file: ${STATE_FILE} (delete to restart)`);
}

main().catch((err) => {
  console.error('Unhandled:', err);
  process.exit(1);
});
