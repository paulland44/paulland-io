/**
 * Cloudflare Vectorize client — used by the MCP worker and Pages Functions.
 *
 * Runs against the binding (env.VECTORIZE) in Worker context. The laptop
 * backfill script uses the REST API directly and does not import from here.
 */

export interface VectorMetadata {
  source_table: string;
  source_id: string;
  chunk_index: number;
  type: string;
  date: string;
  title: string;
  text: string;
  [key: string]: string | number;
}

export interface VectorItem {
  id: string;
  values: number[];
  metadata: VectorMetadata;
}

export interface VectorMatch {
  id: string;
  score: number;
  metadata: VectorMetadata;
}

// Typed as `any` — Cloudflare's Workers types define VectorizeIndex but the
// mcp-server package can't import them without a runtime-specific dependency.
// The surface we call is stable: upsert, query, deleteByIds.
type VectorizeBinding = any;

let _binding: VectorizeBinding | undefined;
let _restAccountId: string | undefined;
let _restApiToken: string | undefined;
let _restIndexName = 'paulland-kb';

export function initVectorize(binding: VectorizeBinding) {
  _binding = binding;
}

/** Node/stdio context — falls back to Cloudflare REST API. */
export function initVectorizeRest(accountId: string, apiToken: string, indexName = 'paulland-kb') {
  _restAccountId = accountId;
  _restApiToken = apiToken;
  _restIndexName = indexName;
}

function bindingAvailable(): boolean {
  return !!_binding;
}

function restAvailable(): boolean {
  return !!_restAccountId && !!_restApiToken;
}

async function restCall(pathSuffix: string, body: unknown, contentType = 'application/json'): Promise<any> {
  if (!restAvailable()) throw new Error('Vectorize not initialised (no binding and no REST credentials)');
  const url = `https://api.cloudflare.com/client/v4/accounts/${_restAccountId}/vectorize/v2/indexes/${_restIndexName}/${pathSuffix}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${_restApiToken}`,
    'Content-Type': contentType,
  };
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Vectorize REST ${pathSuffix} ${res.status}: ${errText.slice(0, 200)}`);
  }
  return res.json();
}

export function vectorId(
  sourceTable: string,
  sourceId: string,
  chunkIndex: number
): string {
  return `${sourceTable}:${sourceId}:${chunkIndex}`;
}

// Max chunks a single source can produce — driven by embedItem's 80 KB text
// cap and 2 KB chunks. Used to build deterministic stale-ID ranges on re-embed.
export const MAX_CHUNKS_PER_SOURCE = 40;

export async function upsertVectors(vectors: VectorItem[]): Promise<void> {
  if (!vectors.length) return;
  if (bindingAvailable()) {
    await _binding.upsert(vectors);
  } else {
    const ndjson = vectors.map((v) => JSON.stringify(v)).join('\n');
    await restCall('upsert', ndjson, 'application/x-ndjson');
  }
}

export async function replaceSourceVectors(
  sourceTable: string,
  sourceId: string,
  vectors: VectorItem[]
): Promise<void> {
  const staleIds: string[] = [];
  for (let i = 0; i < MAX_CHUNKS_PER_SOURCE; i++) {
    staleIds.push(vectorId(sourceTable, sourceId, i));
  }
  if (bindingAvailable()) {
    await _binding.deleteByIds(staleIds);
    if (vectors.length) await _binding.upsert(vectors);
  } else {
    await restCall('delete_by_ids', { ids: staleIds });
    if (vectors.length) {
      const ndjson = vectors.map((v) => JSON.stringify(v)).join('\n');
      await restCall('upsert', ndjson, 'application/x-ndjson');
    }
  }
}

export async function queryVectors(
  queryEmbedding: number[],
  opts: {
    topK?: number;
    filter?: Record<string, unknown>;
    similarityThreshold?: number;
  } = {}
): Promise<VectorMatch[]> {
  const { topK = 10, filter, similarityThreshold = 0 } = opts;
  let matches: VectorMatch[];
  if (bindingAvailable()) {
    const res = await _binding.query(queryEmbedding, {
      topK,
      returnMetadata: 'all',
      returnValues: false,
      filter,
    });
    matches = res.matches || [];
  } else {
    const res = await restCall('query', {
      vector: queryEmbedding,
      topK,
      returnMetadata: 'all',
      returnValues: false,
      filter,
    });
    matches = res?.result?.matches || [];
  }
  return similarityThreshold > 0
    ? matches.filter((m: VectorMatch) => m.score >= similarityThreshold)
    : matches;
}

export async function deleteSourceVectors(
  sourceTable: string,
  sourceId: string
): Promise<void> {
  const ids: string[] = [];
  for (let i = 0; i < MAX_CHUNKS_PER_SOURCE; i++) {
    ids.push(vectorId(sourceTable, sourceId, i));
  }
  if (bindingAvailable()) {
    await _binding.deleteByIds(ids);
  } else {
    await restCall('delete_by_ids', { ids });
  }
}

// Convert a Vectorize match to the result shape handlers have historically
// returned from the Postgres RPC — keeps downstream code identical.
export function matchToLegacyResult(m: VectorMatch) {
  const md = m.metadata;
  return {
    source_table: md.source_table,
    source_id: md.source_id,
    chunk_index: md.chunk_index,
    content_text: md.text || '',
    similarity: m.score,
    metadata: {
      title: md.title || '',
      type: md.type || '',
      date: md.date || '',
    },
  };
}

// Build a Vectorize filter from the legacy search params. `tables` becomes
// a $in on source_table. Date/tag post-filters stay client-side so we can
// keep current behaviour byte-for-byte.
export function buildTableFilter(tables?: string[] | null) {
  if (!tables || !tables.length) return undefined;
  if (tables.length === 1) {
    return { source_table: { $eq: tables[0] } };
  }
  return { source_table: { $in: tables } };
}
