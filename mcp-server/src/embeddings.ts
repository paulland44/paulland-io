/**
 * Embedding generation via Cloudflare Workers AI REST API.
 * Ported from functions/api/[[path]].js
 */

import {
  supabaseGet,
  supabasePost,
  supabasePatch,
  supabaseDelete,
} from './supabase.js';

// ─── Text Building ───────────────────────────────────────────

export function buildEmbeddingText(sourceTable: string, row: any): string {
  switch (sourceTable) {
    case 'content': {
      const prefix =
        row.type === 'article'
          ? 'Article'
          : row.type === 'thought'
            ? 'Thought'
            : row.type === 'signal'
              ? 'Signal'
              : 'Reflection';
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
    default:
      return JSON.stringify(row);
  }
}

export function buildEmbeddingMetadata(
  sourceTable: string,
  row: any
): Record<string, any> {
  const meta: Record<string, any> = { source_table: sourceTable };
  switch (sourceTable) {
    case 'content':
      meta.title = row.title || '';
      meta.type = row.type || '';
      meta.date = row.captured_at || '';
      break;
    case 'daily_notes':
      meta.title = `Daily Note ${row.note_date}`;
      meta.date = row.note_date;
      break;
    case 'summaries':
      meta.title = `${row.type} Summary (${row.period_start} to ${row.period_end})`;
      meta.type = row.type;
      meta.date = row.period_start;
      break;
    case 'people':
      meta.title = row.name || '';
      break;
    case 'companies':
      meta.title = row.name || '';
      meta.type = row.type || '';
      break;
    case 'products':
      meta.title = row.name || '';
      break;
    case 'projects':
      meta.title = row.name || '';
      meta.status = row.status || '';
      break;
    case 'people_log':
      meta.title = 'People Note';
      meta.date = row.note_date;
      break;
    case 'product_evidence':
      meta.title = `Product Evidence (${row.evidence_type || 'observation'})`;
      meta.date = row.note_date;
      break;
    case 'product_decisions':
      meta.title = 'Product Decision';
      meta.date = row.note_date;
      break;
    case 'reflections_log':
      meta.title = `Reflection (${row.category || 'leadership'})`;
      meta.date = row.note_date;
      break;
  }
  return meta;
}

// ─── Chunking ────────────────────────────────────────────────

export function chunkText(
  text: string,
  maxChars = 2000
): { chunkIndex: number; text: string }[] {
  if (text.length <= maxChars) return [{ chunkIndex: 0, text }];

  const firstNewline = text.indexOf('\n');
  const titlePrefix =
    firstNewline > 0 && firstNewline < 200
      ? text.substring(0, firstNewline)
      : '';
  const body = titlePrefix ? text.substring(firstNewline + 1) : text;

  const paragraphs = body.split(/\n\n+/);
  const chunks: { chunkIndex: number; text: string }[] = [];
  let current = titlePrefix;
  let idx = 0;

  for (const para of paragraphs) {
    if (
      current.length + para.length + 2 > maxChars &&
      current.length > titlePrefix.length
    ) {
      chunks.push({ chunkIndex: idx++, text: current.trim() });
      current = titlePrefix ? titlePrefix + '\n' + para : para;
    } else {
      current += (current ? '\n\n' : '') + para;
    }
  }
  if (current.trim()) {
    chunks.push({ chunkIndex: idx, text: current.trim() });
  }

  return chunks;
}

// ─── Cloudflare Workers AI REST API ─────────────────────────

// Support both process.env (local stdio) and explicit init (Worker)
let _cfAccountId: string | undefined;
let _cfApiToken: string | undefined;

export function initEmbeddings(accountId: string, apiToken: string) {
  _cfAccountId = accountId;
  _cfApiToken = apiToken;
}

export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  const accountId = _cfAccountId || process.env.CF_ACCOUNT_ID;
  const apiToken = _cfApiToken || process.env.CF_API_TOKEN;
  if (!accountId || !apiToken) {
    throw new Error(
      'CF_ACCOUNT_ID and CF_API_TOKEN must be set for embedding generation'
    );
  }

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/baai/bge-base-en-v1.5`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: texts }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Workers AI REST API error (${res.status}): ${err}`);
  }

  const data = await res.json() as any;
  if (!data.result?.data)
    throw new Error('Unexpected Workers AI response format');
  return data.result.data;
}

// ─── Embed a single item ────────────────────────────────────

export async function embedItem(
  sourceTable: string,
  sourceId: string
): Promise<{ ok: boolean; chunks?: number; error?: string }> {
  const rows = await supabaseGet(
    `${sourceTable}?id=eq.${sourceId}&limit=1`
  );
  if (!rows.length) return { ok: false, error: 'Row not found' };
  const row = rows[0];

  const fullText = buildEmbeddingText(sourceTable, row);
  if (!fullText || fullText.length < 10)
    return { ok: false, error: 'Insufficient text' };

  const chunks = chunkText(fullText);
  const metadata = buildEmbeddingMetadata(sourceTable, row);

  const texts = chunks.map((c) => c.text);
  let embeddings: number[][];
  try {
    embeddings = await generateEmbeddings(texts);
  } catch (err: any) {
    return { ok: false, error: `Embedding error: ${err.message}` };
  }

  if (!embeddings || embeddings.length !== chunks.length) {
    return { ok: false, error: 'Embedding count mismatch' };
  }

  // Delete existing embeddings for this source
  await supabaseDelete(
    `embeddings?source_table=eq.${sourceTable}&source_id=eq.${sourceId}`
  );

  // Insert new embeddings
  const embeddingRows = chunks.map((chunk, i) => ({
    source_table: sourceTable,
    source_id: sourceId,
    chunk_index: chunk.chunkIndex,
    content_text: chunk.text,
    embedding: JSON.stringify(embeddings[i]),
    metadata,
  }));

  await supabasePost('embeddings', embeddingRows);

  // Update embedded_at on the source row
  await supabasePatch(`${sourceTable}?id=eq.${sourceId}`, {
    embedded_at: new Date().toISOString(),
  });

  return { ok: true, chunks: chunks.length };
}

// ─── EMBEDDABLE_TABLES constant ─────────────────────────────

export const EMBEDDABLE_TABLES = [
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
];
