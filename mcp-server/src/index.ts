#!/usr/bin/env node
/**
 * MCP Server for paulland.io Knowledge Base
 *
 * Provides tools for Claude to interact with the knowledge base directly,
 * replacing Claude API calls with in-context processing on the Max plan.
 */

// dotenv is loaded by launch.cjs before this module is imported
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import {
  supabaseGet,
  supabasePost,
  supabasePatch,
  supabaseDelete,
  supabaseRpc,
  supabaseUpsert,
} from './supabase.js';
import {
  generateEmbeddings,
  embedItem,
  EMBEDDABLE_TABLES,
} from './embeddings.js';
import { extractArticleContent } from './utils/html-to-markdown.js';
// Note: fs/path are NOT available in the Cloudflare Worker runtime.
// Tools must not depend on filesystem access. Use base64 data parameters instead.

// ─── Date Helpers ────────────────────────────────────────────

function getWeekDates(week: string): string[] {
  // Parse ISO week string like "2026-W13" → array of Mon–Sun date strings
  const match = week.match(/^(\d{4})-W(\d{2})$/);
  if (!match) return [];
  const year = parseInt(match[1]);
  const weekNum = parseInt(match[2]);
  // Jan 4 is always in week 1 (ISO 8601)
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const dayOfWeek = jan4.getUTCDay() || 7; // Mon=1 .. Sun=7
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - dayOfWeek + 1 + (weekNum - 1) * 7);
  const dates: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setUTCDate(monday.getUTCDate() + i);
    dates.push(d.toISOString().split('T')[0]);
  }
  return dates;
}

function getMonthRange(month: string): { first: string; last: string } {
  // "2026-03" → { first: "2026-03-01", last: "2026-03-31" }
  const [year, mon] = month.split('-').map(Number);
  const first = `${month}-01`;
  const lastDay = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  const last = `${month}-${String(lastDay).padStart(2, '0')}`;
  return { first, last };
}

// ─── Server Setup ────────────────────────────────────────────

const server = new McpServer({
  name: 'paulland-kb',
  version: '1.0.0',
});

// ─── MIS Proxy Config ────────────────────────────────────────
// Module-level state — set via initMisProxy() in the Worker, falls back to process.env locally.

let _misApiUrl: string | undefined;
let _misCfClientId: string | undefined;
let _misCfClientSecret: string | undefined;
let _misInternalApiKey: string | undefined;

export function initMisProxy(apiUrl?: string, clientId?: string, clientSecret?: string, internalApiKey?: string) {
  if (apiUrl) _misApiUrl = apiUrl;
  if (clientId) _misCfClientId = clientId;
  if (clientSecret) _misCfClientSecret = clientSecret;
  if (internalApiKey) _misInternalApiKey = internalApiKey;
}

async function resolveConnectionId(connection_id?: string): Promise<{ id: string; name: string; type?: string } | null> {
  if (connection_id) {
    const rows = await supabaseGet(`mis_connections?id=eq.${connection_id}&select=id,name,type&limit=1`);
    return rows.length ? rows[0] : null;
  }
  const rows = await supabaseGet('mis_connections?is_active=eq.true&select=id,name,type&limit=1');
  return rows.length ? rows[0] : null;
}

async function callMisProxy(method: string, path: string, connectionId: string, body?: any) {
  const apiUrl = _misApiUrl || process.env.PAULLAND_API_URL || 'https://paulland.io/api';
  const clientId = _misCfClientId || process.env.CF_ACCESS_CLIENT_ID;
  const clientSecret = _misCfClientSecret || process.env.CF_ACCESS_CLIENT_SECRET;
  const internalApiKey = _misInternalApiKey || process.env.PAULLAND_INTERNAL_API_KEY;
  const headers: Record<string, string> = {
    'Accept': 'application/json',
    'X-MIS-Connection-Id': connectionId,
  };
  if (internalApiKey) {
    headers['X-Internal-API-Key'] = internalApiKey;
  } else {
    if (clientId) headers['CF-Access-Client-Id'] = clientId;
    if (clientSecret) headers['CF-Access-Client-Secret'] = clientSecret;
  }
  if (body) headers['Content-Type'] = 'application/json';

  const resp = await fetch(`${apiUrl}/mis/${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { rawResponse: text.slice(0, 500) }; }
  return { ok: resp.ok, status: resp.status, data };
}

// ─── Asset Upload Helper ─────────────────────────────────────

async function uploadAssetToR2(
  buffer: ArrayBuffer | Buffer,
  filename: string,
  mimeType: string,
  tags: string[],
  description: string,
  productId?: string
): Promise<{ ok: boolean; asset_id?: string; error?: string }> {
  const apiUrl = _misApiUrl || process.env.PAULLAND_API_URL || 'https://paulland.io/api';
  const internalApiKey = _misInternalApiKey || process.env.PAULLAND_INTERNAL_API_KEY;
  const clientId = _misCfClientId || process.env.CF_ACCESS_CLIENT_ID;
  const clientSecret = _misCfClientSecret || process.env.CF_ACCESS_CLIENT_SECRET;

  const formData = new FormData();
  // Handle both Node Buffer and ArrayBuffer (Worker-compatible)
  const arrayBuf = buffer instanceof ArrayBuffer ? buffer
    : buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
  formData.append('file', new Blob([arrayBuf], { type: mimeType }), filename);
  formData.append('tags', tags.join(','));
  formData.append('description', description);
  if (productId) formData.append('product_id', productId);

  const headers: Record<string, string> = {};
  if (internalApiKey) {
    headers['X-Internal-API-Key'] = internalApiKey;
  } else {
    if (clientId) headers['CF-Access-Client-Id'] = clientId;
    if (clientSecret) headers['CF-Access-Client-Secret'] = clientSecret;
  }

  try {
    const resp = await fetch(`${apiUrl}/assets/upload`, {
      method: 'POST',
      headers,
      body: formData,
    });
    if (!resp.ok) {
      const text = await resp.text();
      return { ok: false, error: `Upload failed (${resp.status}): ${text.slice(0, 200)}` };
    }
    const data = await resp.json() as any;
    return { ok: true, asset_id: data?.id || data?.asset?.id || undefined };
  } catch (err: any) {
    return { ok: false, error: `Upload error: ${err.message}` };
  }
}

// ─── Tool & Resource Registration ───────────────────────────
// Wrapped in functions so the Worker can create fresh instances per request.

function registerTools(server: McpServer) {

// ─── Group 1: Content Access (Read) ─────────────────────────

server.tool(
  'list_content',
  'List content items (articles, thoughts, signals, reflections, problems, strategies) with optional filters',
  {
    type: z
      .enum(['article', 'thought', 'signal', 'reflection', 'problem', 'strategy', 'summary', 'weekly-summary', 'monthly-review', 'show-and-tell', 'support-review'])
      .optional()
      .describe('Filter by content type'),
    status: z.string().optional().describe('Filter by status (new, reviewed, archived)'),
    tags: z.array(z.string()).optional().describe('Filter by tags (content must have all specified tags)'),
    search: z.string().optional().describe('Text search in title'),
    limit: z.number().optional().default(20).describe('Max items to return'),
    offset: z.number().optional().default(0).describe('Offset for pagination'),
  },
  async ({ type, status, tags, search, limit, offset }) => {
    let path = `content?select=id,type,title,tags,status,captured_at,url,source&order=captured_at.desc`;
    if (type) path += `&type=eq.${type}`;
    if (status) path += `&status=eq.${status}`;
    if (tags?.length) {
      path += `&tags=cs.{${tags.join(',')}}`;
    }
    if (search) path += `&title=ilike.*${encodeURIComponent(search)}*`;
    path += `&limit=${limit}&offset=${offset}`;

    const rows = await supabaseGet(path);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            { count: rows.length, items: rows },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  'get_content',
  'Get a full content item by ID (includes complete body)',
  {
    id: z.string().describe('Content item UUID'),
  },
  async ({ id }) => {
    const rows = await supabaseGet(`content?id=eq.${id}&limit=1`);
    if (!rows.length) {
      return { content: [{ type: 'text' as const, text: 'Content not found' }] };
    }
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(rows[0], null, 2) }],
    };
  }
);

server.tool(
  'get_summary',
  'Get a full summary by ID from the summaries table (weekly, monthly, show-and-tell, support)',
  {
    id: z.string().describe('Summary UUID (returned by weekly_summary_write, monthly_review_write, etc.)'),
  },
  async ({ id }) => {
    const rows = await supabaseGet(`summaries?id=eq.${id}&limit=1`);
    if (!rows.length) {
      return { content: [{ type: 'text' as const, text: 'Summary not found' }] };
    }
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(rows[0], null, 2) }],
    };
  }
);

server.tool(
  'list_daily_notes',
  'List daily notes for a date range',
  {
    date_from: z
      .string()
      .optional()
      .describe('Start date (YYYY-MM-DD)'),
    date_to: z.string().optional().describe('End date (YYYY-MM-DD)'),
    limit: z.number().optional().default(7).describe('Max notes to return'),
  },
  async ({ date_from, date_to, limit }) => {
    let path = `daily_notes?select=id,note_date,tasks,notes,meetings,metadata&order=note_date.desc&limit=${limit}`;
    if (date_from) path += `&note_date=gte.${date_from}`;
    if (date_to) path += `&note_date=lte.${date_to}`;

    const rows = await supabaseGet(path);
    // Truncate long fields for listing
    const items = rows.map((r: any) => ({
      id: r.id,
      note_date: r.note_date,
      has_tasks: !!r.tasks,
      has_notes: !!r.notes,
      has_meetings: !!r.meetings,
      reviewed: !!r.metadata?.last_reviewed,
      tasks_preview: r.tasks?.substring(0, 200) || '',
      notes_preview: r.notes?.substring(0, 200) || '',
    }));
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify({ count: items.length, items }, null, 2) },
      ],
    };
  }
);

server.tool(
  'get_daily_note',
  'Get the full daily note for a specific date',
  {
    date: z.string().describe('Date in YYYY-MM-DD format'),
  },
  async ({ date }) => {
    const rows = await supabaseGet(
      `daily_notes?note_date=eq.${date}&limit=1`
    );
    if (!rows.length) {
      return {
        content: [{ type: 'text' as const, text: `No daily note found for ${date}` }],
      };
    }
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(rows[0], null, 2) }],
    };
  }
);

server.tool(
  'list_entities',
  'List entities from people, companies, products, or projects tables',
  {
    table: z
      .enum(['people', 'companies', 'products', 'projects'])
      .describe('Entity table to query'),
    search: z
      .string()
      .optional()
      .describe('Search by name'),
    limit: z.number().optional().default(50),
  },
  async ({ table, search, limit }) => {
    let selectFields = 'id,name';
    switch (table) {
      case 'people':
        selectFields = 'id,name,role,organization,tags';
        break;
      case 'companies':
        selectFields = 'id,name,type,industry,is_competitor,tags';
        break;
      case 'products':
        selectFields = 'id,name,company_id,tags';
        break;
      case 'projects':
        selectFields = 'id,name,status,product_id,tags';
        break;
    }
    let path = `${table}?select=${selectFields}&order=name&limit=${limit}`;
    if (search) path += `&name=ilike.*${encodeURIComponent(search)}*`;

    const rows = await supabaseGet(path);
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify({ count: rows.length, items: rows }, null, 2) },
      ],
    };
  }
);

server.tool(
  'get_entity',
  'Get full entity detail including related content and assets',
  {
    table: z.enum(['people', 'companies', 'products', 'projects']),
    id: z.string().describe('Entity UUID'),
  },
  async ({ table, id }) => {
    const rows = await supabaseGet(`${table}?id=eq.${id}&limit=1`);
    if (!rows.length) {
      return { content: [{ type: 'text' as const, text: 'Entity not found' }] };
    }
    const entity = rows[0];

    // Fetch related data based on table
    const related: Record<string, any> = {};
    if (table === 'companies') {
      related.content = await supabaseGet(
        `company_content?company_id=eq.${id}&select=content_id,content(id,title,type,tags)`
      );
      related.products = await supabaseGet(
        `products?company_id=eq.${id}&select=id,name`
      );
    } else if (table === 'products') {
      related.content = await supabaseGet(
        `product_content?product_id=eq.${id}&select=content_id,content(id,title,type,tags)`
      );
      related.assets = await supabaseGet(
        `product_assets?product_id=eq.${id}&select=asset_id,assets(id,filename,mime_type)`
      );
    } else if (table === 'people') {
      related.log = await supabaseGet(
        `people_log?person_id=eq.${id}&select=id,note_date,entry,source&order=note_date.desc&limit=20`
      );
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ entity, related }, null, 2),
        },
      ],
    };
  }
);

server.tool(
  'list_feed_items',
  'List feed items awaiting triage (not yet captured or dismissed)',
  {
    show: z
      .enum(['pending', 'captured', 'dismissed', 'all'])
      .optional()
      .default('pending')
      .describe('Which items to show'),
    limit: z.number().optional().default(30),
  },
  async ({ show, limit }) => {
    let path = `feed_items?select=id,item_title,item_url,item_summary,captured,dismissed,feed_id,created_at&order=created_at.desc&limit=${limit}`;
    if (show === 'pending') {
      path += '&captured=eq.false&dismissed=eq.false';
    } else if (show === 'captured') {
      path += '&captured=eq.true';
    } else if (show === 'dismissed') {
      path += '&dismissed=eq.true';
    }

    const rows = await supabaseGet(path);
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify({ count: rows.length, items: rows }, null, 2) },
      ],
    };
  }
);

// ─── Group 2: Search ─────────────────────────────────────────

server.tool(
  'search_knowledge_base',
  'Semantic vector search across the entire knowledge base using embeddings',
  {
    query: z.string().describe('Search query text'),
    tables: z
      .array(z.string())
      .optional()
      .describe('Limit search to specific tables (e.g. ["content", "daily_notes"])'),
    limit: z.number().optional().default(10),
    date_from: z.string().optional().describe('Filter results from this date'),
    date_to: z.string().optional().describe('Filter results up to this date'),
    tags: z
      .array(z.string())
      .optional()
      .describe('Filter by tags in content'),
  },
  async ({ query, tables, limit, date_from, date_to, tags }) => {
    // Generate embedding for query
    let queryEmbedding: number[];
    try {
      const embeddings = await generateEmbeddings([query]);
      queryEmbedding = embeddings[0];
    } catch (err: any) {
      return {
        content: [
          { type: 'text' as const, text: `Embedding failed: ${err.message}` },
        ],
      };
    }

    const hasFilters = date_from || date_to || (tags && tags.length);
    const fetchCount = hasFilters
      ? Math.min(limit * 3, 60)
      : Math.min(limit, 20);

    const rpcBody: any = {
      query_embedding: JSON.stringify(queryEmbedding),
      match_count: fetchCount,
      similarity_threshold: 0.3,
    };
    if (tables?.length) rpcBody.filter_tables = tables;

    const rpcResult = await supabaseRpc('search_embeddings', rpcBody);
    if (!rpcResult.ok) {
      return {
        content: [
          { type: 'text' as const, text: `Search failed: ${rpcResult.error}` },
        ],
      };
    }

    let results = rpcResult.data || [];

    // Post-filter
    if (hasFilters) {
      results = results.filter((r: any) => {
        const meta = r.metadata || {};
        if (date_from || date_to) {
          const itemDate = meta.date;
          if (itemDate) {
            if (date_from && itemDate < date_from) return false;
            if (date_to && itemDate > date_to) return false;
          }
        }
        if (tags?.length) {
          const text = (r.content_text || '').toLowerCase();
          const metaStr = JSON.stringify(meta).toLowerCase();
          const hasTag = tags.some(
            (t) =>
              text.includes(t.toLowerCase()) ||
              metaStr.includes(t.toLowerCase())
          );
          if (!hasTag) return false;
        }
        return true;
      });
      results = results.slice(0, limit);
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            { count: results.length, results },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ─── Group 3: Write Operations ──────────────────────────────

server.tool(
  'create_content',
  'Create a new content item (article, thought, signal, reflection, problem, strategy)',
  {
    type: z
      .enum(['article', 'thought', 'signal', 'reflection', 'problem', 'strategy'])
      .describe('Content type'),
    title: z.string().describe('Title'),
    body: z.string().describe('Body (markdown)'),
    tags: z.array(z.string()).optional().default([]),
    url: z.string().optional().describe('Source URL if applicable'),
    source: z.string().optional().describe('Source name'),
    status: z.string().optional().default('new'),
    metadata: z.record(z.any()).optional().default({}),
  },
  async ({ type, title, body, tags, url, source, status, metadata }) => {
    const cleanTags = tags
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);

    const result = await supabasePost(
      'content',
      {
        type,
        title,
        body,
        tags: cleanTags,
        url: url || null,
        source: source || null,
        status,
        metadata: metadata || {},
      },
      true
    );

    if (!result.ok) {
      return {
        content: [{ type: 'text' as const, text: `Failed to create: ${result.error}` }],
      };
    }

    const created = result.data?.[0];

    // Trigger embedding in background (fire and forget)
    if (created?.id) {
      embedItem('content', created.id).catch(() => {});
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            { ok: true, id: created?.id, title },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  'update_content',
  'Update an existing content item',
  {
    id: z.string().describe('Content item UUID'),
    updates: z
      .object({
        title: z.string().optional(),
        body: z.string().optional(),
        status: z.string().optional(),
        tags: z.array(z.string()).optional(),
        metadata: z.record(z.any()).optional(),
      })
      .describe('Fields to update'),
  },
  async ({ id, updates }) => {
    if (updates.tags) {
      updates.tags = updates.tags
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean);
    }

    const result = await supabasePatch(`content?id=eq.${id}`, updates);
    if (!result.ok) {
      return {
        content: [{ type: 'text' as const, text: `Failed to update: ${result.error}` }],
      };
    }

    // Re-embed if body or title changed
    if (updates.body || updates.title || updates.tags) {
      embedItem('content', id).catch(() => {});
    }

    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, id }) }],
    };
  }
);

server.tool(
  'update_tags',
  'Update tags on a content item and trigger re-embedding',
  {
    id: z.string().describe('Content item UUID'),
    tags: z.array(z.string()).describe('New tags array'),
  },
  async ({ id, tags }) => {
    const cleanTags = tags
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);

    const result = await supabasePatch(`content?id=eq.${id}`, {
      tags: cleanTags,
    });
    if (!result.ok) {
      return {
        content: [{ type: 'text' as const, text: `Failed: ${result.error}` }],
      };
    }

    embedItem('content', id).catch(() => {});

    return {
      content: [
        { type: 'text' as const, text: JSON.stringify({ ok: true, tags: cleanTags }) },
      ],
    };
  }
);

server.tool(
  'upsert_daily_note',
  'Create or update a daily note by date',
  {
    date: z.string().describe('Date in YYYY-MM-DD format'),
    tasks: z.string().optional().describe('Tasks markdown'),
    notes: z.string().optional().describe('Notes markdown'),
    meetings: z.string().optional().describe('Meetings markdown'),
  },
  async ({ date, tasks, notes, meetings }) => {
    const data: any = { note_date: date };
    if (tasks !== undefined) data.tasks = tasks;
    if (notes !== undefined) data.notes = notes;
    if (meetings !== undefined) data.meetings = meetings;

    const result = await supabaseUpsert('daily_notes', data, 'note_date');
    if (!result.ok) {
      return {
        content: [{ type: 'text' as const, text: `Failed: ${result.error}` }],
      };
    }

    return {
      content: [
        { type: 'text' as const, text: JSON.stringify({ ok: true, date }) },
      ],
    };
  }
);

server.tool(
  'create_entity',
  'Create a new person, company, product, or project',
  {
    table: z.enum(['people', 'companies', 'products', 'projects']),
    data: z.record(z.any()).describe('Entity data (name required, other fields vary by table)'),
  },
  async ({ table, data }) => {
    if (!data.name) {
      return { content: [{ type: 'text' as const, text: 'name is required' }] };
    }

    const result = await supabasePost(table, data, true);
    if (!result.ok) {
      return {
        content: [{ type: 'text' as const, text: `Failed: ${result.error}` }],
      };
    }

    const created = result.data?.[0];
    if (created?.id) {
      embedItem(table, created.id).catch(() => {});
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ ok: true, id: created?.id, name: data.name }),
        },
      ],
    };
  }
);

server.tool(
  'update_entity',
  'Update a person, company, product, or project',
  {
    table: z.enum(['people', 'companies', 'products', 'projects']),
    id: z.string().describe('Entity UUID'),
    updates: z.record(z.any()).describe('Fields to update'),
  },
  async ({ table, id, updates }) => {
    const result = await supabasePatch(`${table}?id=eq.${id}`, updates);
    if (!result.ok) {
      return {
        content: [{ type: 'text' as const, text: `Failed: ${result.error}` }],
      };
    }

    if (EMBEDDABLE_TABLES.includes(table)) {
      embedItem(table, id).catch(() => {});
    }

    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, table, id }) }],
    };
  }
);

server.tool(
  'capture_feed_item',
  'Promote a feed item to a content article (fetches and extracts the full article)',
  {
    feed_item_id: z.string().describe('Feed item UUID'),
  },
  async ({ feed_item_id }) => {
    // Fetch feed item
    const feedItems = await supabaseGet(
      `feed_items?select=*&id=eq.${feed_item_id}`
    );
    if (!feedItems.length) {
      return { content: [{ type: 'text' as const, text: 'Feed item not found' }] };
    }
    const feedItem = feedItems[0];

    if (feedItem.captured) {
      return {
        content: [{ type: 'text' as const, text: 'Feed item already captured' }],
      };
    }

    // Dedup check
    const existing = await supabaseGet(
      `content?select=id&url=eq.${encodeURIComponent(feedItem.item_url)}&limit=1`
    );
    if (existing.length) {
      await supabasePatch(`feed_items?id=eq.${feed_item_id}`, {
        captured: true,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              captured: true,
              deduplicated: true,
              existing_id: existing[0].id,
            }),
          },
        ],
      };
    }

    // Fetch and extract article
    let title = feedItem.item_title || 'Untitled';
    let description = feedItem.item_summary || '';
    let body = '';
    let imageUrl: string | null = null;

    try {
      const resp = await fetch(feedItem.item_url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
      });
      if (resp.ok) {
        const html = await resp.text();
        const extracted = extractArticleContent(html);
        title = extracted.title || title;
        description = extracted.description || description;
        body = extracted.body;
        imageUrl = extracted.imageUrl;
      }
    } catch {
      // Use feed item data as fallback
    }

    if (!body) {
      body =
        description ||
        feedItem.item_summary ||
        `*View original article: ${feedItem.item_url}*`;
    }

    const metadata: any = {
      feed_item_id: feedItem.id,
      source_app: 'reader',
      description,
      image_url: imageUrl,
    };

    const result = await supabasePost(
      'content',
      {
        type: 'article',
        title,
        body,
        url: feedItem.item_url,
        source: 'Readwise Reader',
        tags: [],
        status: 'new',
        metadata,
      },
      true
    );

    if (!result.ok) {
      return {
        content: [
          { type: 'text' as const, text: `Failed to create content: ${result.error}` },
        ],
      };
    }

    const contentId = result.data?.[0]?.id;

    // Mark captured
    await supabasePatch(`feed_items?id=eq.${feed_item_id}`, {
      captured: true,
    });

    // Embed in background
    if (contentId) {
      embedItem('content', contentId).catch(() => {});
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ captured: true, content_id: contentId, title }),
        },
      ],
    };
  }
);

server.tool(
  'dismiss_feed_item',
  'Dismiss a feed item from the triage queue',
  {
    feed_item_id: z.string().describe('Feed item UUID'),
  },
  async ({ feed_item_id }) => {
    const result = await supabasePatch(`feed_items?id=eq.${feed_item_id}`, {
      dismissed: true,
    });
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ ok: result.ok, error: result.error }),
        },
      ],
    };
  }
);

// ─── Group 4: AI Workflow Support ───────────────────────────

server.tool(
  'daily_review_extract',
  'Fetch a daily note with entity context for Claude to perform the daily review extraction in-context (no API call needed). Returns the note content, known entities, and the system prompt to use.',
  {
    date: z.string().describe('Date in YYYY-MM-DD format'),
  },
  async ({ date }) => {
    const noteRes = await supabaseGet(
      `daily_notes?note_date=eq.${date}&limit=1`
    );
    if (!noteRes.length) {
      return {
        content: [{ type: 'text' as const, text: `No daily note found for ${date}` }],
      };
    }
    const dailyNote = noteRes[0];

    // Fetch entity context + problems + prompt
    const [people, products, projects, problemsRes, promptRes] = await Promise.all([
      supabaseGet('people?select=id,name,role,organization&order=name'),
      supabaseGet('products?select=id,name&order=name'),
      supabaseGet('projects?select=id,name,product_id&order=name'),
      supabaseGet('content?type=eq.problem&select=id,title,metadata&order=title&limit=100'),
      supabaseGet('prompts?slug=eq.daily-review&limit=1'),
    ]);
    const prompt = promptRes?.[0] || null;

    const peopleNames = people.map((p: any) => p.name);
    const productNames = products.map((p: any) => p.name);
    const projectNames = projects.map((p: any) => p.name);
    const problemsList = problemsRes
      .filter((p: any) => p.metadata?.problem_id && !p.metadata?.is_index)
      .map((p: any) => `${p.metadata.problem_id}: ${p.title}`)
      .join(', ');

    // Interpolate template variables into system prompt
    let systemPrompt = prompt?.system_prompt || null;
    if (systemPrompt) {
      systemPrompt = systemPrompt
        .replace('{{people_list}}', peopleNames.join(', '))
        .replace('{{product_list}}', productNames.join(', '))
        .replace('{{project_list}}', projectNames.join(', '))
        .replace('{{problems_list}}', problemsList || '(none loaded)');
    }

    // Build the user prompt (same as API version)
    let userPrompt = `## Daily Note for ${date}\n\n`;
    if (dailyNote.tasks) userPrompt += `### Tasks\n${dailyNote.tasks}\n\n`;
    if (dailyNote.notes)
      userPrompt += `### Notes & Thoughts\n${dailyNote.notes}\n\n`;
    if (dailyNote.meetings)
      userPrompt += `### Meetings & Conversations\n${dailyNote.meetings}\n\n`;

    const structured = dailyNote.metadata?.meetings_structured;
    if (structured?.length) {
      userPrompt += `### Meeting Details (structured)\n`;
      for (const m of structured) {
        userPrompt += `#### ${m.title || 'Untitled Meeting'}${m.time ? ` (${m.time})` : ''}\n`;
        userPrompt += `${m.notes || '(no notes)'}\n\n`;
      }
    }

    const stoic = dailyNote.metadata?.stoic_challenge;
    if (stoic && (stoic.frustration || stoic.reframe || stoic.opportunity)) {
      userPrompt += `### Stoic Challenge\n`;
      if (stoic.frustration)
        userPrompt += `**Frustration:** ${stoic.frustration}\n`;
      if (stoic.reframe) userPrompt += `**Reframe:** ${stoic.reframe}\n`;
      if (stoic.opportunity)
        userPrompt += `**Opportunity:** ${stoic.opportunity}\n`;
      userPrompt += '\n';
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              daily_note: dailyNote,
              known_people: peopleNames,
              known_products: productNames,
              known_projects: projectNames,
              known_problems: problemsList,
              system_prompt: systemPrompt,
              user_prompt_template: prompt?.user_prompt_template || null,
              prompt_version: prompt?.version || null,
              user_prompt: userPrompt,
              instructions:
                'Process this daily note and extract: people_entries, product_evidence, product_decisions, project_updates, reflections, migrated_tasks, context_notes, problem_observations (if any meetings or notes relate to known problems), and review_summary. Return as JSON. Then call daily_review_write with the results.',
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  'daily_review_write',
  'Write the structured results of a daily review back to the database. Call this after extracting data from the daily note.',
  {
    date: z.string().describe('Date in YYYY-MM-DD format'),
    review_data: z
      .object({
        people_entries: z
          .array(
            z.object({
              person_name: z.string(),
              entry: z.string(),
            })
          )
          .optional()
          .default([]),
        product_evidence: z
          .array(
            z.object({
              product_name: z.string(),
              evidence: z.string(),
              evidence_type: z.string().optional(),
            })
          )
          .optional()
          .default([]),
        product_decisions: z
          .array(
            z.object({
              product_name: z.string(),
              decision: z.string(),
              context: z.string().optional(),
            })
          )
          .optional()
          .default([]),
        project_updates: z
          .array(
            z.object({
              project_name: z.string(),
              update: z.string(),
            })
          )
          .optional()
          .default([]),
        reflections: z
          .array(
            z.object({
              observation: z.string(),
              coach_perspective: z.string().optional(),
              category: z.string().optional(),
            })
          )
          .optional()
          .default([]),
        migrated_tasks: z.array(z.string()).optional().default([]),
        context_notes: z
          .array(
            z.object({
              meeting_title: z.string(),
              context: z.string(),
            })
          )
          .optional()
          .default([]),
        problem_observations: z
          .array(
            z.object({
              problem_id: z.string().describe('Problem ID (e.g. "P1", "PP3")'),
              observation: z.string().describe('What was observed'),
              evidence_type: z.string().optional().describe('customer_quote, workflow_gap, market_data, interview_insight'),
              source_context: z.string().optional().describe('Which meeting/note it came from'),
            })
          )
          .optional()
          .default([]),
        review_summary: z.string().optional().default(''),
      })
      .describe('Structured review extraction results'),
  },
  async ({ date, review_data }) => {
    // Fetch entity maps for ID lookups
    const [people, products, projects] = await Promise.all([
      supabaseGet('people?select=id,name&order=name'),
      supabaseGet('products?select=id,name&order=name'),
      supabaseGet('projects?select=id,name,product_id&order=name'),
    ]);

    const peopleMap: Record<string, string> = {};
    people.forEach((p: any) => {
      peopleMap[p.name.toLowerCase()] = p.id;
    });
    const productMap: Record<string, string> = {};
    products.forEach((p: any) => {
      productMap[p.name.toLowerCase()] = p.id;
    });
    const projectMap: Record<string, string> = {};
    projects.forEach((p: any) => {
      projectMap[p.name.toLowerCase()] = p.id;
    });

    const sourceRef = { daily_note_date: date };
    const results = {
      people_log: 0,
      product_evidence: 0,
      product_decisions: 0,
      project_updates: 0,
      reflections: 0,
    };

    // Write people log entries
    for (const entry of review_data.people_entries) {
      const personId = peopleMap[entry.person_name?.toLowerCase()];
      if (!personId || !entry.entry) continue;
      await supabasePost('people_log', {
        person_id: personId,
        note_date: date,
        entry: entry.entry,
        source: 'daily_review',
        source_ref: sourceRef,
      });
      results.people_log++;
    }

    // Write product evidence
    for (const entry of review_data.product_evidence) {
      const productId = productMap[entry.product_name?.toLowerCase()];
      if (!productId || !entry.evidence) continue;
      await supabasePost('product_evidence', {
        product_id: productId,
        note_date: date,
        evidence: entry.evidence,
        evidence_type: entry.evidence_type || 'observation',
        source_ref: sourceRef,
      });
      results.product_evidence++;
    }

    // Write product decisions
    for (const entry of review_data.product_decisions) {
      const productId = productMap[entry.product_name?.toLowerCase()];
      if (!entry.decision) continue;
      await supabasePost('product_decisions', {
        product_id: productId || null,
        note_date: date,
        decision: entry.decision,
        context: entry.context || '',
        source_ref: sourceRef,
      });
      results.product_decisions++;
    }

    // Write project updates
    for (const entry of review_data.project_updates) {
      const projectId = projectMap[entry.project_name?.toLowerCase()];
      if (!projectId || !entry.update) continue;
      await supabasePost('project_updates', {
        project_id: projectId,
        note_date: date,
        update_text: entry.update,
        source_ref: sourceRef,
      });
      results.project_updates++;
    }

    // Write reflections
    for (const entry of review_data.reflections) {
      if (!entry.observation) continue;
      let personId = null;
      if (entry.category === 'coaching') {
        for (const [name, id] of Object.entries(peopleMap)) {
          if (entry.observation.toLowerCase().includes(name)) {
            personId = id;
            break;
          }
        }
      }
      await supabasePost('reflections_log', {
        note_date: date,
        observation: entry.observation,
        coach_perspective: entry.coach_perspective || '',
        category: entry.category || 'leadership',
        person_id: personId,
        source_ref: sourceRef,
      });
      results.reflections++;
    }

    // Write problem observations — append evidence to matching problems
    let problemObsCount = 0;
    for (const obs of review_data.problem_observations) {
      if (!obs.problem_id || !obs.observation) continue;
      const problems = await supabaseGet(
        `content?type=eq.problem&metadata->>problem_id=eq.${obs.problem_id}&select=id,body&limit=1`
      );
      if (!problems.length) continue;

      const problem = problems[0];
      const evidenceSection = `\n\n---\n### Evidence from Daily Review ${date}${obs.evidence_type ? ` (${obs.evidence_type})` : ''}\n${obs.source_context ? `*Source: ${obs.source_context}*\n\n` : ''}${obs.observation}`;

      await supabasePatch(`content?id=eq.${problem.id}`, {
        body: (problem.body || '') + evidenceSection,
        updated_at: new Date().toISOString(),
      });

      // Link daily note to problem
      const noteForLink = await supabaseGet(`daily_notes?note_date=eq.${date}&select=id&limit=1`);
      if (noteForLink.length) {
        // Note: content_links requires content IDs — daily_notes are a different table
        // We track this in the problem's body instead
      }

      embedItem('content', problem.id).catch(() => {});
      problemObsCount++;
    }
    (results as any).problem_observations = problemObsCount;

    // Create audit record
    await supabasePost('ai_reviews', {
      review_type: 'daily',
      source_date: date,
      status: 'completed',
      output_summary: review_data.review_summary,
      files_updated: results,
      completed_at: new Date().toISOString(),
    });

    // Update daily note metadata
    const noteRes = await supabaseGet(
      `daily_notes?note_date=eq.${date}&limit=1`
    );
    if (noteRes.length) {
      const dailyNote = noteRes[0];
      const existingMeta = dailyNote.metadata || {};
      await supabasePatch(`daily_notes?note_date=eq.${date}`, {
        metadata: {
          ...existingMeta,
          last_reviewed: new Date().toISOString(),
          review_summary: review_data.review_summary,
          migrated_tasks: review_data.migrated_tasks,
          context_notes: review_data.context_notes,
          review_data,
          review_writes: results,
        },
      });

      // Migrate tasks to next day
      let tasksMigrated = 0;
      const migratedTasks = review_data.migrated_tasks;
      if (migratedTasks.length > 0) {
        const d = new Date(date + 'T12:00:00Z');
        d.setDate(d.getDate() + 1);
        const nextDate = d.toISOString().split('T')[0];

        const nextNotes = await supabaseGet(
          `daily_notes?note_date=eq.${nextDate}&limit=1`
        );
        const nextNote = nextNotes.length ? nextNotes[0] : null;

        const migratedMd = migratedTasks
          .map((t: string) => `- [ ] ${t}`)
          .join('\n');
        const header = `## Tasks (migrated from ${date})\n`;

        let newTasks = '';
        if (nextNote?.tasks?.trim()) {
          const existingLower = nextNote.tasks.toLowerCase();
          const uniqueTasks = migratedTasks.filter(
            (t: string) =>
              !existingLower.includes(t.toLowerCase().substring(0, 30))
          );
          if (uniqueTasks.length > 0) {
            const uniqueMd = uniqueTasks
              .map((t: string) => `- [ ] ${t}`)
              .join('\n');
            newTasks = nextNote.tasks + '\n\n' + header + uniqueMd;
            tasksMigrated = uniqueTasks.length;
          }
        } else {
          newTasks = header + migratedMd;
          tasksMigrated = migratedTasks.length;
        }

        if (tasksMigrated > 0) {
          await supabaseUpsert(
            'daily_notes',
            {
              note_date: nextDate,
              tasks: newTasks,
              notes: nextNote?.notes || '',
              meetings: nextNote?.meetings || '',
            },
            'note_date'
          );
        }

        // Mark migrated tasks as [>] on source day
        let updatedTasks = dailyNote.tasks || '';
        for (const task of migratedTasks) {
          const searchText = task
            .substring(0, Math.min(40, task.length))
            .toLowerCase();
          const lines = updatedTasks.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (
              lines[i].includes('- [ ]') &&
              lines[i].toLowerCase().includes(searchText)
            ) {
              lines[i] = lines[i].replace('- [ ]', '- [>]');
              break;
            }
          }
          updatedTasks = lines.join('\n');
        }

        if (updatedTasks !== dailyNote.tasks) {
          await supabasePatch(`daily_notes?note_date=eq.${date}`, {
            tasks: updatedTasks,
          });
        }
      }

      // Re-embed daily note
      if (dailyNote.id) {
        embedItem('daily_notes', dailyNote.id).catch(() => {});
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              { ok: true, writes: results, tasks_migrated: tasksMigrated },
              null,
              2
            ),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ ok: true, writes: results }, null, 2),
        },
      ],
    };
  }
);

// ─── Weekly Summary Tools ────────────────────────────────────

server.tool(
  'weekly_summary_extract',
  'Fetch all daily notes, review data, and entity context for a given ISO week so Claude can produce a weekly summary in-context. Returns compiled week data and instructions.',
  {
    week: z.string().describe('ISO week string, e.g. "2026-W13"'),
  },
  async ({ week }) => {
    const dates = getWeekDates(week);
    if (!dates.length) {
      return { content: [{ type: 'text' as const, text: `Invalid week format: ${week}. Use YYYY-Www (e.g. 2026-W13).` }] };
    }

    const dateList = dates.map(d => `"${d}"`).join(',');
    const dateFilter = `note_date=in.(${dateList})`;
    const dateRangeFilter = `note_date=gte.${dates[0]}&note_date=lte.${dates[6]}`;

    const [dailyNotes, reviews, peopleLog, productEvidence, productDecisions, projectUpdates, reflections, people, products, projects, promptRes] = await Promise.all([
      supabaseGet(`daily_notes?${dateFilter}&order=note_date`),
      supabaseGet(`ai_reviews?review_type=eq.daily&source_date=in.(${dateList})&order=source_date`),
      supabaseGet(`people_log?${dateRangeFilter}&select=id,person_id,note_date,entry,source&order=note_date`),
      supabaseGet(`product_evidence?${dateRangeFilter}&select=id,product_id,note_date,evidence,evidence_type&order=note_date`),
      supabaseGet(`product_decisions?${dateRangeFilter}&select=id,product_id,note_date,decision,context&order=note_date`),
      supabaseGet(`project_updates?${dateRangeFilter}&select=id,project_id,note_date,update_text&order=note_date`),
      supabaseGet(`reflections_log?${dateRangeFilter}&select=id,note_date,observation,coach_perspective,category&order=note_date`),
      supabaseGet('people?select=id,name,role,organization&order=name'),
      supabaseGet('products?select=id,name&order=name'),
      supabaseGet('projects?select=id,name,product_id&order=name'),
      supabaseGet('prompts?slug=eq.weekly-summary&limit=1'),
    ]);
    const prompt = promptRes?.[0] || null;

    // Build ID→name maps for enrichment
    const peopleMap: Record<string, string> = {};
    people.forEach((p: any) => { peopleMap[p.id] = p.name; });
    const productMap: Record<string, string> = {};
    products.forEach((p: any) => { productMap[p.id] = p.name; });
    const projectMap: Record<string, string> = {};
    projects.forEach((p: any) => { projectMap[p.id] = p.name; });

    // Enrich log entries with names
    const enrichedPeopleLog = peopleLog.map((e: any) => ({ ...e, person_name: peopleMap[e.person_id] || 'Unknown' }));
    const enrichedEvidence = productEvidence.map((e: any) => ({ ...e, product_name: productMap[e.product_id] || 'Unknown' }));
    const enrichedDecisions = productDecisions.map((e: any) => ({ ...e, product_name: productMap[e.product_id] || 'Unknown' }));
    const enrichedProjectUpdates = projectUpdates.map((e: any) => ({ ...e, project_name: projectMap[e.project_id] || 'Unknown' }));

    // Check for existing weekly summary
    const existingSummary = await supabaseGet(`summaries?type=eq.weekly&metadata->>week=eq.${week}&limit=1`);

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          week,
          dates,
          daily_notes: dailyNotes,
          daily_reviews: reviews.map((r: any) => ({ date: r.source_date, summary: r.output_summary })),
          people_log: enrichedPeopleLog,
          product_evidence: enrichedEvidence,
          product_decisions: enrichedDecisions,
          project_updates: enrichedProjectUpdates,
          reflections,
          known_people: people.map((p: any) => p.name),
          known_products: products.map((p: any) => p.name),
          known_projects: projects.map((p: any) => p.name),
          existing_summary: existingSummary.length ? existingSummary[0] : null,
          system_prompt: prompt?.system_prompt || null,
          user_prompt_template: prompt?.user_prompt_template || null,
          prompt_version: prompt?.version || null,
          instructions: 'Compile a weekly summary from this data. Produce a JSON object with: highlights (string[]), key_meetings ([{ title, outcome }]), domain_updates (string[]), product_updates ([{ product_name, update }]), decisions ([{ decision, context, impact }]), learnings (string[]), leadership_development (string), and summary (string). Then call weekly_summary_write with the results.',
        }, null, 2),
      }],
    };
  }
);

server.tool(
  'weekly_summary_write',
  'Write the structured results of a weekly summary back to the database. Call this after processing weekly_summary_extract data.',
  {
    week: z.string().describe('ISO week string, e.g. "2026-W13"'),
    summary_data: z.object({
      highlights: z.array(z.string()).optional().default([]),
      key_meetings: z.array(z.object({
        title: z.string(),
        outcome: z.string(),
      })).optional().default([]),
      domain_updates: z.array(z.string()).optional().default([]),
      product_updates: z.array(z.object({
        product_name: z.string(),
        update: z.string(),
      })).optional().default([]),
      decisions: z.array(z.object({
        decision: z.string(),
        context: z.string().optional(),
        impact: z.string().optional(),
      })).optional().default([]),
      learnings: z.array(z.string()).optional().default([]),
      leadership_development: z.string().optional().default(''),
      summary: z.string().optional().default(''),
    }).describe('Structured weekly summary data'),
  },
  async ({ week, summary_data }) => {
    const dates = getWeekDates(week);
    if (!dates.length) {
      return { content: [{ type: 'text' as const, text: `Invalid week format: ${week}` }] };
    }

    // Build markdown body from structured data
    let body = `# Weekly Summary — ${week}\n\n`;
    body += `**Period:** ${dates[0]} to ${dates[6]}\n\n`;

    if (summary_data.summary) {
      body += `## Overview\n${summary_data.summary}\n\n`;
    }
    if (summary_data.highlights.length) {
      body += `## Highlights\n${summary_data.highlights.map(h => `- ${h}`).join('\n')}\n\n`;
    }
    if (summary_data.key_meetings.length) {
      body += `## Key Meetings\n${summary_data.key_meetings.map(m => `- **${m.title}**: ${m.outcome}`).join('\n')}\n\n`;
    }
    if (summary_data.domain_updates.length) {
      body += `## Domain Updates\n${summary_data.domain_updates.map(u => `- ${u}`).join('\n')}\n\n`;
    }
    if (summary_data.product_updates.length) {
      body += `## Product Updates\n${summary_data.product_updates.map(p => `- **${p.product_name}**: ${p.update}`).join('\n')}\n\n`;
    }
    if (summary_data.decisions.length) {
      body += `## Decisions\n${summary_data.decisions.map(d => `- **${d.decision}**${d.context ? ` — ${d.context}` : ''}${d.impact ? ` → ${d.impact}` : ''}`).join('\n')}\n\n`;
    }
    if (summary_data.learnings.length) {
      body += `## Learnings\n${summary_data.learnings.map(l => `- ${l}`).join('\n')}\n\n`;
    }
    if (summary_data.leadership_development) {
      body += `## Leadership & Development\n${summary_data.leadership_development}\n\n`;
    }

    // Check for existing summary to update (summaries table)
    const existing = await supabaseGet(`summaries?type=eq.weekly&metadata->>week=eq.${week}&limit=1`);

    let summaryId: string;
    if (existing.length) {
      summaryId = existing[0].id;
      await supabasePatch(`summaries?id=eq.${summaryId}`, {
        content: body,
        period_start: dates[0],
        period_end: dates[6],
        metadata: { week, dates, updated_at: new Date().toISOString() },
      });
    } else {
      const created = await supabasePost('summaries', {
        type: 'weekly',
        period_start: dates[0],
        period_end: dates[6],
        content: body,
        metadata: { week, dates },
      }, true);
      summaryId = created.data?.[0]?.id || 'unknown';
    }

    // Create audit record
    await supabasePost('ai_reviews', {
      review_type: 'weekly',
      source_date: dates[0],
      status: 'completed',
      output_summary: summary_data.summary,
      files_updated: { summary_id: summaryId },
      completed_at: new Date().toISOString(),
    });

    // Embed the summary
    if (summaryId && summaryId !== 'unknown') {
      embedItem('summaries', summaryId).catch(() => {});
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ ok: true, summary_id: summaryId, week, action: existing.length ? 'updated' : 'created' }, null, 2),
      }],
    };
  }
);

// ─── Monthly Review Tools ────────────────────────────────────

server.tool(
  'monthly_review_extract',
  'Fetch weekly summaries, daily notes, and all review data for a given month so Claude can produce a monthly review in-context. Returns compiled month data and instructions.',
  {
    month: z.string().describe('Month string, e.g. "2026-03"'),
  },
  async ({ month }) => {
    const { first, last } = getMonthRange(month);
    const dateRangeFilter = `note_date=gte.${first}&note_date=lte.${last}`;

    const [weeklySummaries, dailyNotes, productEvidence, productDecisions, projectUpdates, reflections, people, products, projects, promptRes] = await Promise.all([
      supabaseGet(`summaries?type=eq.weekly&order=created_at&limit=10`),
      supabaseGet(`daily_notes?note_date=gte.${first}&note_date=lte.${last}&order=note_date`),
      supabaseGet(`product_evidence?${dateRangeFilter}&select=id,product_id,note_date,evidence,evidence_type&order=note_date`),
      supabaseGet(`product_decisions?${dateRangeFilter}&select=id,product_id,note_date,decision,context&order=note_date`),
      supabaseGet(`project_updates?${dateRangeFilter}&select=id,project_id,note_date,update_text&order=note_date`),
      supabaseGet(`reflections_log?${dateRangeFilter}&select=id,note_date,observation,coach_perspective,category&order=note_date`),
      supabaseGet('people?select=id,name,role,organization&order=name'),
      supabaseGet('products?select=id,name&order=name'),
      supabaseGet('projects?select=id,name,status&order=name'),
      supabaseGet('prompts?slug=eq.monthly-summary&limit=1'),
    ]);
    const prompt = promptRes?.[0] || null;

    // Filter weekly summaries to those whose week falls within this month
    const monthWeeklies = weeklySummaries.filter((s: any) => {
      const w = s.metadata?.week;
      if (!w) return false;
      const wDates = getWeekDates(w);
      return wDates.some(d => d >= first && d <= last);
    });

    // Build ID→name maps
    const productMap: Record<string, string> = {};
    products.forEach((p: any) => { productMap[p.id] = p.name; });
    const projectMap: Record<string, string> = {};
    projects.forEach((p: any) => { projectMap[p.id] = p.name; });

    const enrichedEvidence = productEvidence.map((e: any) => ({ ...e, product_name: productMap[e.product_id] || 'Unknown' }));
    const enrichedDecisions = productDecisions.map((e: any) => ({ ...e, product_name: productMap[e.product_id] || 'Unknown' }));
    const enrichedProjectUpdates = projectUpdates.map((e: any) => ({ ...e, project_name: projectMap[e.project_id] || 'Unknown' }));

    // Check for existing monthly summary
    const existingSummary = await supabaseGet(`summaries?type=eq.monthly&metadata->>month=eq.${month}&limit=1`);

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          month,
          date_range: { first, last },
          weekly_summaries: monthWeeklies.map((s: any) => ({ week: s.metadata?.week, title: s.title, body: s.body })),
          daily_notes_count: dailyNotes.length,
          daily_notes: dailyNotes,
          product_evidence: enrichedEvidence,
          product_decisions: enrichedDecisions,
          project_updates: enrichedProjectUpdates,
          reflections,
          known_products: products.map((p: any) => p.name),
          known_projects: projects.map((p: any) => ({ name: p.name, status: p.status })),
          existing_summary: existingSummary.length ? existingSummary[0] : null,
          system_prompt: prompt?.system_prompt || null,
          user_prompt_template: prompt?.user_prompt_template || null,
          prompt_version: prompt?.version || null,
          instructions: 'Compile a monthly review from this data. Produce a JSON object with: themes (string[]), problem_progress ([{ problem_id, problem_name, status, evidence }] for P1-P18 and PP1-PP10), strategic_decisions ([{ decision, rationale, impact }]), customer_interactions ([{ customer, context, outcome }]), team_updates (string[]), metrics (object with any quantifiable data), and summary (string). Then call monthly_review_write with the results.',
        }, null, 2),
      }],
    };
  }
);

server.tool(
  'monthly_review_write',
  'Write the structured results of a monthly review back to the database. Call this after processing monthly_review_extract data.',
  {
    month: z.string().describe('Month string, e.g. "2026-03"'),
    review_data: z.object({
      themes: z.array(z.string()).optional().default([]),
      problem_progress: z.array(z.object({
        problem_id: z.string(),
        problem_name: z.string(),
        status: z.string(),
        evidence: z.string().optional(),
      })).optional().default([]),
      strategic_decisions: z.array(z.object({
        decision: z.string(),
        rationale: z.string().optional(),
        impact: z.string().optional(),
      })).optional().default([]),
      customer_interactions: z.array(z.object({
        customer: z.string(),
        context: z.string(),
        outcome: z.string().optional(),
      })).optional().default([]),
      team_updates: z.array(z.string()).optional().default([]),
      metrics: z.record(z.any()).optional().default({}),
      summary: z.string().optional().default(''),
    }).describe('Structured monthly review data'),
  },
  async ({ month, review_data }) => {
    const { first, last } = getMonthRange(month);

    // Build markdown body
    let body = `# Monthly Review — ${month}\n\n`;
    body += `**Period:** ${first} to ${last}\n\n`;

    if (review_data.summary) {
      body += `## Overview\n${review_data.summary}\n\n`;
    }
    if (review_data.themes.length) {
      body += `## Key Themes\n${review_data.themes.map(t => `- ${t}`).join('\n')}\n\n`;
    }
    if (review_data.problem_progress.length) {
      body += `## Problems Progress\n`;
      body += `| Problem | Status | Evidence |\n|---|---|---|\n`;
      body += review_data.problem_progress.map(p => `| ${p.problem_id} — ${p.problem_name} | ${p.status} | ${p.evidence || '—'} |`).join('\n');
      body += '\n\n';
    }
    if (review_data.strategic_decisions.length) {
      body += `## Strategic Decisions\n${review_data.strategic_decisions.map(d => `- **${d.decision}**${d.rationale ? ` — ${d.rationale}` : ''}${d.impact ? ` → ${d.impact}` : ''}`).join('\n')}\n\n`;
    }
    if (review_data.customer_interactions.length) {
      body += `## Customer Interactions\n${review_data.customer_interactions.map(c => `- **${c.customer}**: ${c.context}${c.outcome ? ` → ${c.outcome}` : ''}`).join('\n')}\n\n`;
    }
    if (review_data.team_updates.length) {
      body += `## Team Updates\n${review_data.team_updates.map(u => `- ${u}`).join('\n')}\n\n`;
    }
    if (Object.keys(review_data.metrics).length) {
      body += `## Metrics\n${Object.entries(review_data.metrics).map(([k, v]) => `- **${k}**: ${v}`).join('\n')}\n\n`;
    }

    // Check for existing summary to update (summaries table)
    const existing = await supabaseGet(`summaries?type=eq.monthly&metadata->>month=eq.${month}&limit=1`);

    let summaryId: string;
    if (existing.length) {
      summaryId = existing[0].id;
      await supabasePatch(`summaries?id=eq.${summaryId}`, {
        content: body,
        period_start: first,
        period_end: last,
        metadata: { month, updated_at: new Date().toISOString(), review_data },
      });
    } else {
      const created = await supabasePost('summaries', {
        type: 'monthly',
        period_start: first,
        period_end: last,
        content: body,
        metadata: { month, review_data },
      }, true);
      summaryId = created.data?.[0]?.id || 'unknown';
    }

    // Create audit record
    await supabasePost('ai_reviews', {
      review_type: 'monthly',
      source_date: first,
      status: 'completed',
      output_summary: review_data.summary,
      files_updated: { summary_id: summaryId },
      completed_at: new Date().toISOString(),
    });

    // Embed the summary
    if (summaryId && summaryId !== 'unknown') {
      embedItem('summaries', summaryId).catch(() => {});
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ ok: true, summary_id: summaryId, month, action: existing.length ? 'updated' : 'created' }, null, 2),
      }],
    };
  }
);

// ─── Show & Tell Review Tools ────────────────────────────────

server.tool(
  'show_and_tell_extract',
  'Fetch the daily note and entity context for a Show & Tell meeting date so Claude can extract demos, decisions, and follow-ups in-context. Returns meeting content and instructions.',
  {
    date: z.string().describe('Date of the Show & Tell in YYYY-MM-DD format'),
  },
  async ({ date }) => {
    const noteRes = await supabaseGet(`daily_notes?note_date=eq.${date}&limit=1`);
    if (!noteRes.length) {
      return { content: [{ type: 'text' as const, text: `No daily note found for ${date}` }] };
    }
    const dailyNote = noteRes[0];

    // Get recent product evidence for context (last 2 weeks)
    const twoWeeksAgo = new Date(date + 'T12:00:00Z');
    twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
    const fromDate = twoWeeksAgo.toISOString().split('T')[0];

    const [people, products, recentEvidence, promptRes] = await Promise.all([
      supabaseGet('people?select=id,name,role,organization&order=name'),
      supabaseGet('products?select=id,name&order=name'),
      supabaseGet(`product_evidence?note_date=gte.${fromDate}&note_date=lte.${date}&select=id,product_id,evidence,evidence_type&order=note_date.desc&limit=30`),
      supabaseGet('prompts?slug=eq.show-and-tell&limit=1'),
    ]);
    const prompt = promptRes?.[0] || null;

    const productMap: Record<string, string> = {};
    products.forEach((p: any) => { productMap[p.id] = p.name; });
    const enrichedEvidence = recentEvidence.map((e: any) => ({ ...e, product_name: productMap[e.product_id] || 'Unknown' }));

    // Interpolate template variables into system prompt
    let systemPrompt = prompt?.system_prompt || null;
    if (systemPrompt) {
      systemPrompt = systemPrompt
        .replace('{{people_list}}', people.map((p: any) => p.name).join(', '))
        .replace('{{product_list}}', products.map((p: any) => p.name).join(', '));
    }

    // Build user prompt from daily note
    let noteContent = `## Daily Note for ${date}\n\n`;
    if (dailyNote.meetings) noteContent += `### Meetings & Conversations\n${dailyNote.meetings}\n\n`;
    if (dailyNote.notes) noteContent += `### Notes\n${dailyNote.notes}\n\n`;

    const structured = dailyNote.metadata?.meetings_structured;
    if (structured?.length) {
      noteContent += `### Meeting Details (structured)\n`;
      for (const m of structured) {
        noteContent += `#### ${m.title || 'Untitled Meeting'}${m.time ? ` (${m.time})` : ''}\n`;
        noteContent += `${m.notes || '(no notes)'}\n\n`;
      }
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          date,
          daily_note: noteContent,
          known_people: people.map((p: any) => p.name),
          known_products: products.map((p: any) => p.name),
          recent_product_evidence: enrichedEvidence,
          system_prompt: systemPrompt,
          user_prompt_template: prompt?.user_prompt_template || null,
          prompt_version: prompt?.version || null,
          instructions: 'Extract Show & Tell content from this daily note. Look for demos, product demonstrations, decisions made, and follow-up actions. Produce a JSON object with: demos ([{ presenter, product_name, description, outcome }]), decisions ([{ decision, owner, context }]), follow_ups ([{ action, owner, due_date?, product_name? }]), attendee_observations ([{ person_name, observation }]), and summary (string). Then call show_and_tell_write with the results.',
        }, null, 2),
      }],
    };
  }
);

server.tool(
  'show_and_tell_write',
  'Write the structured results of a Show & Tell review back to the database. Call this after processing show_and_tell_extract data.',
  {
    date: z.string().describe('Date of the Show & Tell in YYYY-MM-DD format'),
    review_data: z.object({
      demos: z.array(z.object({
        presenter: z.string(),
        product_name: z.string(),
        description: z.string(),
        outcome: z.string().optional(),
      })).optional().default([]),
      decisions: z.array(z.object({
        decision: z.string(),
        owner: z.string().optional(),
        context: z.string().optional(),
      })).optional().default([]),
      follow_ups: z.array(z.object({
        action: z.string(),
        owner: z.string().optional(),
        due_date: z.string().optional(),
        product_name: z.string().optional(),
      })).optional().default([]),
      attendee_observations: z.array(z.object({
        person_name: z.string(),
        observation: z.string(),
      })).optional().default([]),
      summary: z.string().optional().default(''),
    }).describe('Structured Show & Tell review data'),
  },
  async ({ date, review_data }) => {
    // Fetch entity maps
    const [people, products] = await Promise.all([
      supabaseGet('people?select=id,name&order=name'),
      supabaseGet('products?select=id,name&order=name'),
    ]);

    const peopleMap: Record<string, string> = {};
    people.forEach((p: any) => { peopleMap[p.name.toLowerCase()] = p.id; });
    const productMap: Record<string, string> = {};
    products.forEach((p: any) => { productMap[p.name.toLowerCase()] = p.id; });

    const sourceRef = { show_and_tell_date: date };
    const results = { demos: 0, decisions: 0, follow_ups: 0, people_log: 0 };

    // Write demo entries as product evidence
    for (const demo of review_data.demos) {
      const productId = productMap[demo.product_name?.toLowerCase()];
      if (!productId) continue;
      await supabasePost('product_evidence', {
        product_id: productId,
        note_date: date,
        evidence: `Demo by ${demo.presenter}: ${demo.description}${demo.outcome ? ` — ${demo.outcome}` : ''}`,
        evidence_type: 'demo',
        source_ref: sourceRef,
      });
      results.demos++;

      // Also log for the presenter
      const presenterId = peopleMap[demo.presenter?.toLowerCase()];
      if (presenterId) {
        await supabasePost('people_log', {
          person_id: presenterId,
          note_date: date,
          entry: `Demoed ${demo.product_name}: ${demo.description}`,
          source: 'show_and_tell',
          source_ref: sourceRef,
        });
        results.people_log++;
      }
    }

    // Write decisions as product decisions
    for (const dec of review_data.decisions) {
      const productId = dec.context ? productMap[dec.context?.toLowerCase()] : null;
      await supabasePost('product_decisions', {
        product_id: productId || null,
        note_date: date,
        decision: dec.decision,
        context: `Show & Tell${dec.owner ? ` — Owner: ${dec.owner}` : ''}${dec.context ? ` — ${dec.context}` : ''}`,
        source_ref: sourceRef,
      });
      results.decisions++;
    }

    // Write attendee observations as people log entries
    for (const obs of review_data.attendee_observations) {
      const personId = peopleMap[obs.person_name?.toLowerCase()];
      if (!personId) continue;
      await supabasePost('people_log', {
        person_id: personId,
        note_date: date,
        entry: obs.observation,
        source: 'show_and_tell',
        source_ref: sourceRef,
      });
      results.people_log++;
    }

    // Build markdown body for content item
    let body = `# Show & Tell Review — ${date}\n\n`;
    if (review_data.summary) body += `## Summary\n${review_data.summary}\n\n`;
    if (review_data.demos.length) {
      body += `## Demos\n${review_data.demos.map(d => `- **${d.presenter}** (${d.product_name}): ${d.description}${d.outcome ? ` → ${d.outcome}` : ''}`).join('\n')}\n\n`;
    }
    if (review_data.decisions.length) {
      body += `## Decisions\n${review_data.decisions.map(d => `- **${d.decision}**${d.owner ? ` (${d.owner})` : ''}${d.context ? ` — ${d.context}` : ''}`).join('\n')}\n\n`;
    }
    if (review_data.follow_ups.length) {
      body += `## Follow-ups\n${review_data.follow_ups.map(f => `- [ ] ${f.action}${f.owner ? ` — @${f.owner}` : ''}${f.due_date ? ` (due: ${f.due_date})` : ''}${f.product_name ? ` [${f.product_name}]` : ''}`).join('\n')}\n\n`;
      results.follow_ups = review_data.follow_ups.length;
    }

    // Create/update in summaries table
    const existing = await supabaseGet(`summaries?type=eq.show-and-tell&metadata->>date=eq.${date}&limit=1`);

    let summaryId: string;
    if (existing.length) {
      summaryId = existing[0].id;
      await supabasePatch(`summaries?id=eq.${summaryId}`, {
        content: body,
        metadata: { date, updated_at: new Date().toISOString(), review_data },
      });
    } else {
      const created = await supabasePost('summaries', {
        type: 'show-and-tell',
        period_start: date,
        period_end: date,
        content: body,
        metadata: { date, review_data },
      }, true);
      summaryId = created.data?.[0]?.id || 'unknown';
    }

    // Create audit record
    await supabasePost('ai_reviews', {
      review_type: 'show_and_tell',
      source_date: date,
      status: 'completed',
      output_summary: review_data.summary,
      files_updated: { summary_id: summaryId, ...results },
      completed_at: new Date().toISOString(),
    });

    // Embed the summary
    if (summaryId && summaryId !== 'unknown') {
      embedItem('summaries', summaryId).catch(() => {});
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ ok: true, summary_id: summaryId, date, writes: results, action: existing.length ? 'updated' : 'created' }, null, 2),
      }],
    };
  }
);

// ─── Support Review Tools (Extract / Write) ─────────────────

server.tool(
  'support_review_extract',
  'Fetch a support export file from the asset library and the review prompt template so Claude can analyse the cases in-context. Returns file content, prompt, and entity context.',
  {
    asset_id: z.string().optional().describe('UUID of the uploaded support asset. If omitted, uses the most recent asset tagged "support"'),
    date: z.string().optional().describe('Review date in YYYY-MM-DD format (defaults to today)'),
  },
  async ({ asset_id, date }) => {
    const reviewDate = date || new Date().toISOString().split('T')[0];

    // 1. Find the asset
    let asset: any;
    if (asset_id) {
      const rows = await supabaseGet(`assets?id=eq.${asset_id}&select=id,filename,mime_type,r2_key,tags`);
      asset = rows?.[0];
    } else {
      const rows = await supabaseGet('assets?tags=cs.{support}&order=uploaded_at.desc&limit=1&select=id,filename,mime_type,r2_key,tags');
      asset = rows?.[0];
    }
    if (!asset) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'No support asset found. Upload a support export file to the asset library first and tag it "support".' }) }] };
    }

    // 2. Fetch prompt template
    const prompts = await supabaseGet('prompts?slug=eq.support-review&select=system_prompt,user_prompt_template');
    const prompt = prompts?.[0];

    // 3. Fetch file content via API
    const apiUrl = _misApiUrl || process.env.PAULLAND_API_URL || 'https://paulland.io/api';
    const internalApiKey = _misInternalApiKey || process.env.PAULLAND_INTERNAL_API_KEY;
    const headers: Record<string, string> = {};
    if (internalApiKey) headers['X-Internal-API-Key'] = internalApiKey;

    let fileContent: any = null;
    try {
      const resp = await fetch(`${apiUrl}/assets/${asset.id}/content`, { headers });
      if (resp.ok) {
        fileContent = await resp.json();
      } else {
        fileContent = { error: `Failed to fetch file: ${resp.status}` };
      }
    } catch (err: any) {
      fileContent = { error: `Fetch error: ${err.message}` };
    }

    // 4. Fetch known entities for matching
    const [people, products] = await Promise.all([
      supabaseGet('people?select=id,name&order=name'),
      supabaseGet('products?select=id,name&order=name'),
    ]);

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          date: reviewDate,
          asset_id: asset.id,
          file_name: asset.filename,
          mime_type: asset.mime_type,
          file_content: fileContent,
          system_prompt: prompt?.system_prompt || null,
          user_prompt_template: prompt?.user_prompt_template || null,
          known_products: products?.map((p: any) => ({ id: p.id, name: p.name })) || [],
          known_people: people?.map((p: any) => ({ id: p.id, name: p.name })) || [],
        }, null, 2),
      }],
    };
  }
);

server.tool(
  'support_review_write',
  'Write the structured results of a support case review back to the database. Call this after analysing the support export with support_review_extract data.',
  {
    date: z.string().describe('Review date in YYYY-MM-DD format'),
    asset_id: z.string().optional().describe('UUID of the source support asset'),
    review_data: z.object({
      summary: z.string().optional().default(''),
      overview_metrics: z.object({
        total: z.number(),
        open: z.number(),
        closed: z.number(),
        avg_age: z.number().optional(),
        oldest_days: z.number().optional(),
      }).optional(),
      aging_cases: z.array(z.object({
        case_number: z.string(),
        subject: z.string(),
        days_open: z.number(),
        customer_name: z.string().optional(),
        status: z.string().optional(),
      })).optional().default([]),
      support_patterns: z.array(z.object({
        pattern: z.string(),
        case_count: z.number().optional(),
        severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
        product_name: z.string().optional(),
      })).optional().default([]),
      feature_gaps: z.array(z.object({
        gap: z.string(),
        evidence: z.string(),
        priority: z.enum(['low', 'medium', 'high']).optional(),
        product_name: z.string().optional(),
      })).optional().default([]),
      customer_entries: z.array(z.object({
        customer_name: z.string(),
        summary: z.string(),
        notable_cases: z.array(z.string()).optional().default([]),
      })).optional().default([]),
    }).describe('Structured support review analysis'),
  },
  async ({ date, asset_id, review_data }) => {
    // 1. Fetch entity maps
    const [people, products] = await Promise.all([
      supabaseGet('people?select=id,name&order=name'),
      supabaseGet('products?select=id,name&order=name'),
    ]);

    const peopleMap: Record<string, string> = {};
    people.forEach((p: any) => { peopleMap[p.name.toLowerCase()] = p.id; });
    const productMap: Record<string, string> = {};
    products.forEach((p: any) => { productMap[p.name.toLowerCase()] = p.id; });

    const sourceRef = { support_review_date: date, asset_id };
    const results = { patterns: 0, feature_gaps: 0, customer_entries: 0 };

    // 2. Build markdown body
    let body = `# Support Review — ${date}\n\n`;
    if (review_data.summary) body += `## Summary\n${review_data.summary}\n\n`;

    if (review_data.overview_metrics) {
      const m = review_data.overview_metrics;
      body += `## Overview\n`;
      body += `| Metric | Value |\n|---|---|\n`;
      body += `| Total Cases | ${m.total} |\n`;
      body += `| Open | ${m.open} |\n`;
      body += `| Closed | ${m.closed} |\n`;
      if (m.avg_age != null) body += `| Avg Age (days) | ${m.avg_age} |\n`;
      if (m.oldest_days != null) body += `| Oldest Case | ${m.oldest_days} days |\n`;
      body += '\n';
    }

    if (review_data.aging_cases.length) {
      body += `## Aging Cases\n`;
      body += `| Case | Subject | Days | Customer | Status |\n|---|---|---|---|---|\n`;
      body += review_data.aging_cases.map(c =>
        `| ${c.case_number} | ${c.subject} | ${c.days_open} | ${c.customer_name || '—'} | ${c.status || '—'} |`
      ).join('\n');
      body += '\n\n';
    }

    if (review_data.support_patterns.length) {
      body += `## Support Patterns\n`;
      body += review_data.support_patterns.map(p =>
        `- **${p.pattern}**${p.case_count ? ` (${p.case_count} cases)` : ''}${p.severity ? ` — ${p.severity}` : ''}${p.product_name ? ` [${p.product_name}]` : ''}`
      ).join('\n');
      body += '\n\n';
    }

    if (review_data.feature_gaps.length) {
      body += `## Feature Gaps\n`;
      body += review_data.feature_gaps.map(g =>
        `- **${g.gap}**: ${g.evidence}${g.priority ? ` (${g.priority})` : ''}${g.product_name ? ` [${g.product_name}]` : ''}`
      ).join('\n');
      body += '\n\n';
    }

    if (review_data.customer_entries.length) {
      body += `## Customer Distribution\n`;
      body += review_data.customer_entries.map(c =>
        `- **${c.customer_name}**: ${c.summary}${c.notable_cases.length ? ` (${c.notable_cases.join(', ')})` : ''}`
      ).join('\n');
      body += '\n\n';
    }

    if (asset_id) body += `\n---\n*Source file: asset ${asset_id}*\n`;

    // 3. Create/update in summaries table
    const existing = await supabaseGet(`summaries?type=eq.support&metadata->>date=eq.${date}&limit=1`);

    let summaryId: string;
    if (existing.length) {
      summaryId = existing[0].id;
      await supabasePatch(`summaries?id=eq.${summaryId}`, {
        content: body,
        metadata: { date, asset_id, updated_at: new Date().toISOString(), review_data },
      });
    } else {
      const created = await supabasePost('summaries', {
        type: 'support',
        period_start: date,
        period_end: date,
        content: body,
        metadata: { date, asset_id, review_data },
      }, true);
      summaryId = created.data?.[0]?.id || 'unknown';
    }

    // 4. Write product evidence for patterns
    for (const pattern of review_data.support_patterns) {
      const productId = pattern.product_name ? productMap[pattern.product_name.toLowerCase()] : null;
      const wcpId = productId || Object.entries(productMap).find(([k]) => k.includes('webcenter'))?.[1] || null;
      if (!wcpId) continue;
      await supabasePost('product_evidence', {
        product_id: wcpId,
        note_date: date,
        evidence: `Support pattern: ${pattern.pattern}${pattern.case_count ? ` (${pattern.case_count} cases)` : ''}`,
        evidence_type: 'support_pattern',
        source_ref: sourceRef,
      });
      results.patterns++;
    }

    // 5. Write product evidence for feature gaps
    for (const gap of review_data.feature_gaps) {
      const productId = gap.product_name ? productMap[gap.product_name.toLowerCase()] : null;
      const wcpId = productId || Object.entries(productMap).find(([k]) => k.includes('webcenter'))?.[1] || null;
      if (!wcpId) continue;
      await supabasePost('product_evidence', {
        product_id: wcpId,
        note_date: date,
        evidence: `Feature gap: ${gap.gap} — ${gap.evidence}`,
        evidence_type: 'feature_gap',
        source_ref: sourceRef,
      });
      results.feature_gaps++;
    }

    // 6. Write people log for customer entries
    for (const entry of review_data.customer_entries) {
      const personId = peopleMap[entry.customer_name?.toLowerCase()]
        || peopleMap[`customer - ${entry.customer_name?.toLowerCase()}`]
        || null;
      if (!personId) continue;
      await supabasePost('people_log', {
        person_id: personId,
        note_date: date,
        entry: `Support review: ${entry.summary}`,
        source: 'support_review',
        source_ref: sourceRef,
      });
      results.customer_entries++;
    }

    // 7. Create audit record
    await supabasePost('ai_reviews', {
      review_type: 'support_review',
      source_date: date,
      status: 'completed',
      output_summary: review_data.summary,
      files_updated: { summary_id: summaryId, asset_id, ...results },
      completed_at: new Date().toISOString(),
    });

    // 8. Embed the summary
    if (summaryId && summaryId !== 'unknown') {
      embedItem('summaries', summaryId).catch(() => {});
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          ok: true,
          summary_id: summaryId,
          asset_id,
          date,
          writes: results,
          action: existing.length ? 'updated' : 'created',
        }, null, 2),
      }],
    };
  }
);

// ─── Embedding Tools ─────────────────────────────────────────

server.tool(
  'generate_embedding',
  'Generate and store embedding for a single content item',
  {
    source_table: z.string().describe('Table name (e.g. content, daily_notes, people)'),
    source_id: z.string().describe('Row UUID'),
  },
  async ({ source_table, source_id }) => {
    if (!EMBEDDABLE_TABLES.includes(source_table)) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Invalid table. Must be one of: ${EMBEDDABLE_TABLES.join(', ')}`,
          },
        ],
      };
    }

    const result = await embedItem(source_table, source_id);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result) }],
    };
  }
);

server.tool(
  'batch_embed',
  'Embed all unembedded items across tables (up to 6 items per call)',
  {
    tables: z
      .array(z.string())
      .optional()
      .describe('Limit to specific tables'),
  },
  async ({ tables }) => {
    const tableConfigs = EMBEDDABLE_TABLES.filter(
      (t) => !tables?.length || tables.includes(t)
    );

    const MAX_ITEMS = 6;
    const results: Record<string, number> = {};
    let remaining = false;
    let totalProcessed = 0;
    const startTime = Date.now();
    const TIMEOUT_MS = 25000;

    for (const table of tableConfigs) {
      if (totalProcessed >= MAX_ITEMS) {
        remaining = true;
        break;
      }
      if (Date.now() - startTime > TIMEOUT_MS) {
        remaining = true;
        break;
      }

      const limit = Math.min(MAX_ITEMS - totalProcessed, 6);
      const rows = await supabaseGet(
        `${table}?embedded_at=is.null&select=id&limit=${limit}`
      );

      if (!rows.length) {
        results[table] = 0;
        continue;
      }

      let count = 0;
      for (const row of rows) {
        if (
          totalProcessed >= MAX_ITEMS ||
          Date.now() - startTime > TIMEOUT_MS
        ) {
          remaining = true;
          break;
        }
        try {
          const result = await embedItem(table, row.id);
          if (result.ok) {
            count++;
            totalProcessed++;
          }
        } catch {
          // Skip failures
        }
      }
      results[table] = count;
      if (remaining) break;
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            { ok: true, embedded: results, remaining, totalProcessed },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ─── Group 5: Utility ───────────────────────────────────────

server.tool(
  'get_system_status',
  'Get an overview of the knowledge base: content counts, unembedded items, pending feed items',
  {},
  async () => {
    const [
      articles,
      thoughts,
      signals,
      reflections,
      problems,
      strategies,
      dailyNotes,
      people,
      companies,
      products,
      projects,
      pendingFeed,
      unembeddedContent,
      summaries,
    ] = await Promise.all([
      supabaseGet('content?type=eq.article&select=id&limit=1000'),
      supabaseGet('content?type=eq.thought&select=id&limit=1000'),
      supabaseGet('content?type=eq.signal&select=id&limit=1000'),
      supabaseGet('content?type=eq.reflection&select=id&limit=1000'),
      supabaseGet('content?type=eq.problem&select=id&limit=1000'),
      supabaseGet('content?type=eq.strategy&select=id&limit=1000'),
      supabaseGet('daily_notes?select=id&limit=1000'),
      supabaseGet('people?select=id&limit=1000'),
      supabaseGet('companies?select=id&limit=1000'),
      supabaseGet('products?select=id&limit=1000'),
      supabaseGet('projects?select=id&limit=1000'),
      supabaseGet(
        'feed_items?captured=eq.false&dismissed=eq.false&select=id&limit=1000'
      ),
      supabaseGet('content?embedded_at=is.null&select=id&limit=1000'),
      supabaseGet('summaries?select=id&limit=1000'),
    ]);

    const status = {
      content: {
        articles: articles.length,
        thoughts: thoughts.length,
        signals: signals.length,
        reflections: reflections.length,
        problems: problems.length,
        strategies: strategies.length,
        summaries: summaries.length,
      },
      daily_notes: dailyNotes.length,
      entities: {
        people: people.length,
        companies: companies.length,
        products: products.length,
        projects: projects.length,
      },
      pending_feed_items: pendingFeed.length,
      unembedded_content: unembeddedContent.length,
    };

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(status, null, 2) }],
    };
  }
);

// ─── Group 6: Prompt Management ─────────────────────────────

server.tool(
  'list_prompts',
  'List all available prompt templates with their metadata (excludes full prompt bodies)',
  {},
  async () => {
    const rows = await supabaseGet(
      'prompts?select=slug,name,description,model,max_tokens,output_format,version,updated_at&order=slug'
    );
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(rows, null, 2) }],
    };
  }
);

server.tool(
  'get_prompt',
  'Get a full prompt template by slug (includes system_prompt and user_prompt_template)',
  { slug: z.string().describe('Prompt slug (e.g. "daily-review", "extract-signals")') },
  async ({ slug }) => {
    const rows = await supabaseGet(`prompts?slug=eq.${slug}&limit=1`);
    if (!rows.length) {
      return {
        content: [{ type: 'text' as const, text: `Prompt "${slug}" not found` }],
        isError: true,
      };
    }
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(rows[0], null, 2) }],
    };
  }
);

server.tool(
  'update_prompt',
  'Update a prompt template (increments version automatically)',
  {
    slug: z.string().describe('Prompt slug to update'),
    updates: z.object({
      system_prompt: z.string().optional(),
      user_prompt_template: z.string().optional(),
      description: z.string().optional(),
      model: z.string().optional(),
      max_tokens: z.number().optional(),
      output_format: z.string().optional(),
      metadata: z.record(z.any()).optional(),
    }).describe('Fields to update'),
  },
  async ({ slug, updates }) => {
    // Fetch current to get version
    const rows = await supabaseGet(`prompts?slug=eq.${slug}&select=version&limit=1`);
    if (!rows.length) {
      return {
        content: [{ type: 'text' as const, text: `Prompt "${slug}" not found` }],
        isError: true,
      };
    }
    const newVersion = (rows[0].version || 1) + 1;
    const patchData = {
      ...updates,
      version: newVersion,
      updated_at: new Date().toISOString(),
    };
    const result = await supabasePatch(`prompts?slug=eq.${slug}`, patchData);
    if (!result.ok) {
      return {
        content: [{ type: 'text' as const, text: `Update failed: ${result.error}` }],
        isError: true,
      };
    }
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, slug, version: newVersion }) }],
    };
  }
);

// ─── Group 7: MIS Job Management ────────────────────────────

server.tool(
  'list_mis_connections',
  'List MIS simulator connections (tokens are never exposed)',
  {},
  async () => {
    const rows = await supabaseGet(
      'mis_connections?select=id,name,type,is_active,cluster,ecan,repo_id,server_url,created_at&order=created_at.desc'
    );
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(rows, null, 2) }],
    };
  }
);

server.tool(
  'list_mis_jobs',
  'List MIS simulator jobs',
  {
    limit: z.number().optional().default(20).describe('Max jobs to return'),
    status: z.string().optional().describe('Filter by status (e.g. "Draft", "Created", "Active")'),
  },
  async ({ limit, status }) => {
    let query = `mis_jobs?order=created_at.desc&limit=${limit}`;
    if (status) query += `&status=eq.${status}`;
    const rows = await supabaseGet(query);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(rows, null, 2) }],
    };
  }
);

server.tool(
  'create_mis_job',
  'Create a draft MIS job record in the simulator. For WCP connections, use list_customers to find a valid customer_code and list_task_templates to find taskTemplateNodeId values. For AE connections, provide job_name, customer_code, and optionally category/custom_field_1. Once created, submit the draft with submit_mis_job.',
  {
    job_name: z.string().describe('Job display name'),
    customer_code: z.string().optional().describe('Partner/customer ID'),
    customer_name: z.string().optional().describe('Partner/customer display name'),
    description: z.string().optional().describe('Job description'),
    due_date: z.string().optional().describe('Due date (ISO 8601, e.g. "2026-04-15T17:00:00Z")'),
    connection_id: z.string().optional().describe('MIS connection UUID (uses active connection if omitted)'),
    tasks: z.array(z.object({
      taskTemplateNodeId: z.string().describe('Task template node ID'),
      assignee: z.string().optional().describe('Assignee email'),
      subject: z.string().optional(),
      message: z.string().optional(),
    })).optional().describe('Job tasks (WCP only)'),
    job_part_id: z.string().optional().describe('Job Part ID (AE only)'),
    category: z.string().optional().describe('Job category e.g. "Production", "Prepress" (AE only)'),
    custom_field_1: z.string().optional().describe('Custom field 1 value e.g. "Flexo" (AE only)'),
  },
  async ({ job_name, customer_code, customer_name, description, due_date, connection_id, tasks, job_part_id, category, custom_field_1 }) => {
    // Resolve connection
    let connection: any = null;
    const connSelect = 'id,name,type,cluster,ecan,repo_id,server_url';
    if (connection_id) {
      const rows = await supabaseGet(
        `mis_connections?id=eq.${connection_id}&select=${connSelect}&limit=1`
      );
      if (rows.length) connection = rows[0];
    } else {
      const rows = await supabaseGet(
        `mis_connections?is_active=eq.true&select=${connSelect}&limit=1`
      );
      if (rows.length) connection = rows[0];
    }

    const isAe = connection?.type === 'ae';

    // Auto-generate job_id
    const code = customer_code || 'GEN';
    const existing = await supabaseGet(
      `mis_jobs?job_id=like.MIS-${code}-%25&select=job_id&order=created_at.desc&limit=1`
    );
    let seq = 1;
    if (existing.length && existing[0].job_id) {
      const match = existing[0].job_id.match(/-(\d+)$/);
      if (match) seq = parseInt(match[1], 10) + 1;
    }
    const job_id = `MIS-${code}-${String(seq).padStart(4, '0')}`;

    // Build payload — different structure for AE vs WCP
    let payload: any;
    if (isAe) {
      payload = {
        jobName: job_name,
        jobId: job_id,
        jobPartId: job_part_id || job_id,
        customerCode: customer_code || '',
        description: description || '',
        category: category || 'Production',
        customField1: custom_field_1 || '',
      };
    } else {
      payload = {
        siteName: connection?.ecan || 'Home',
        customerCode: customer_code || '',
        jobName: job_name,
        jobId: job_id,
        dueDate: due_date || new Date(Date.now() + 7 * 86400000).toISOString(),
      };
      if (description) payload.description = description;
      if (tasks?.length) {
        payload.tasks = tasks.map(t => ({
          taskTemplateNodeId: t.taskTemplateNodeId,
          properties: {
            dueDate: new Date(due_date || Date.now() + 5 * 86400000).getTime(),
            allowFiles: true,
            ...(t.subject ? { subject: t.subject } : {}),
            ...(t.message ? { message: t.message } : {}),
          },
          assignee: t.assignee ? [{ id: t.assignee }] : [],
        }));
      }
    }

    // Insert job record
    const jobRecord = {
      job_id,
      job_name,
      customer_code: customer_code || null,
      customer_name: customer_name || null,
      status: 'Draft',
      phase: isAe ? '' : 'Draft',
      due_date: isAe ? null : (payload.dueDate || null),
      description: description || null,
      connection_id: connection?.id || null,
      connection_name: connection?.name || null,
      solution: connection?.type || 'wcp',
      cluster: connection?.cluster || null,
      payload,
    };

    const result = await supabasePost('mis_jobs', jobRecord, true);
    if (!result.ok) {
      return {
        content: [{ type: 'text' as const, text: `Failed to create job: ${result.error}` }],
        isError: true,
      };
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          ok: true,
          job_id,
          job_name,
          status: 'Draft',
          type: isAe ? 'ae' : 'wcp',
          connection: connection?.name || 'none',
          note: `Job record created as Draft. Submit with submit_mis_job to send to ${isAe ? 'Automation Engine' : 'WebCenter Pack'}.`,
        }, null, 2),
      }],
    };
  }
);

server.tool(
  'submit_mis_job',
  'Submit a draft MIS job to WebCenter Pack or Automation Engine. The job must exist in Draft status (created via create_mis_job). Calls the WCP/AE API through the proxy and updates the job record on success.',
  {
    job_id: z.string().describe('Supabase UUID of the draft job to submit'),
  },
  async ({ job_id }) => {
    // Fetch the job
    const rows = await supabaseGet(`mis_jobs?id=eq.${job_id}&limit=1`);
    if (!rows.length) {
      return {
        content: [{ type: 'text' as const, text: `Job not found: ${job_id}` }],
        isError: true,
      };
    }
    const job = rows[0];

    if (job.status !== 'Draft') {
      return {
        content: [{ type: 'text' as const, text: `Job is not in Draft status (current: ${job.status}). Only Draft jobs can be submitted.` }],
        isError: true,
      };
    }
    if (!job.payload) {
      return {
        content: [{ type: 'text' as const, text: 'Job has no payload. Re-create the job with create_mis_job.' }],
        isError: true,
      };
    }
    if (!job.connection_id) {
      return {
        content: [{ type: 'text' as const, text: 'Job has no connection_id. Re-create the job with a connection specified.' }],
        isError: true,
      };
    }

    // Submit to WCP via proxy
    const result = await callMisProxy('PUT', 'create-job', job.connection_id, job.payload);

    if (!result.ok) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            error: `${job.solution === 'ae' ? 'AE' : 'WCP'} submission failed (HTTP ${result.status})`,
            detail: result.data,
            job_id: job.job_id,
          }, null, 2),
        }],
        isError: true,
      };
    }

    // Update job record on success
    const patchResult = await supabasePatch(`mis_jobs?id=eq.${job_id}`, {
      status: 'Created',
      wcp_response: result.data,
    });
    if (!patchResult.ok) {
      // WCP succeeded but DB update failed — report success with warning
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            job_id: job.job_id,
            warning: 'Job submitted to WCP successfully, but failed to update local record.',
            wcp_response: result.data,
          }, null, 2),
        }],
      };
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          ok: true,
          job_id: job.job_id,
          job_name: job.job_name,
          status: 'Created',
          wcp_response: result.data,
        }, null, 2),
      }],
    };
  }
);

server.tool(
  'list_customers',
  'List customers/partners from WCP. Useful for finding valid customer codes before creating MIS jobs. Not available for AE connections.',
  {
    connection_id: z.string().optional().describe('MIS connection UUID (uses active connection if omitted)'),
  },
  async ({ connection_id }) => {
    const conn = await resolveConnectionId(connection_id);
    if (!conn) {
      return {
        content: [{ type: 'text' as const, text: 'No MIS connection found. Create one in the MIS Settings.' }],
        isError: true,
      };
    }
    if (conn.type === 'ae') {
      return {
        content: [{ type: 'text' as const, text: 'Automation Engine connections do not have a customer list API. Provide customer_code directly when creating an AE job.' }],
      };
    }

    const result = await callMisProxy('GET', 'customers', conn.id);
    if (!result.ok) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ error: `Failed to fetch customers (HTTP ${result.status})`, detail: result.data }, null, 2),
        }],
        isError: true,
      };
    }

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
    };
  }
);

server.tool(
  'list_task_templates',
  'List task templates from WCP. Returns template names and node IDs needed for creating MIS job tasks. Not available for AE connections.',
  {
    connection_id: z.string().optional().describe('MIS connection UUID (uses active connection if omitted)'),
  },
  async ({ connection_id }) => {
    const conn = await resolveConnectionId(connection_id);
    if (!conn) {
      return {
        content: [{ type: 'text' as const, text: 'No MIS connection found. Create one in the MIS Settings.' }],
        isError: true,
      };
    }
    if (conn.type === 'ae') {
      return {
        content: [{ type: 'text' as const, text: 'Automation Engine connections do not use task templates. Create AE jobs directly with job_name, customer_code, category, and custom_field_1.' }],
      };
    }

    const result = await callMisProxy('GET', 'task-templates', conn.id);
    if (!result.ok) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ error: `Failed to fetch task templates (HTTP ${result.status})`, detail: result.data }, null, 2),
        }],
        isError: true,
      };
    }

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
    };
  }
);

// ─── Group 9: Content Linking ──────────────────────────────

server.tool(
  'link_content',
  'Create a link between two content items (e.g. signal→problem, article→problem). Requires the content_links table.',
  {
    source_id: z.string().describe('UUID of the source content item'),
    target_id: z.string().describe('UUID of the target content item'),
    link_type: z.enum(['evidence', 'related', 'derived_from', 'supports']).describe('Type of relationship'),
    context: z.string().optional().describe('Brief note on why these items are linked'),
  },
  async ({ source_id, target_id, link_type, context }) => {
    const result = await supabasePost('content_links', {
      source_id,
      target_id,
      link_type,
      context: context || null,
    }, true);

    if (!result.ok) {
      return { content: [{ type: 'text' as const, text: `Failed to create link: ${result.error}` }], isError: true };
    }

    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, link_type, source_id, target_id }, null, 2) }],
    };
  }
);

server.tool(
  'get_content_links',
  'Get all links for a content item, with linked item titles and types',
  {
    content_id: z.string().describe('UUID of the content item'),
    direction: z.enum(['inbound', 'outbound', 'both']).optional().default('both').describe('Which direction of links to fetch'),
  },
  async ({ content_id, direction }) => {
    const links: any[] = [];

    if (direction === 'outbound' || direction === 'both') {
      const outbound = await supabaseGet(`content_links?source_id=eq.${content_id}&select=id,target_id,link_type,context,created_at`);
      if (outbound.length) {
        const targetIds = outbound.map((l: any) => l.target_id);
        const targets = await supabaseGet(`content?id=in.(${targetIds.join(',')})&select=id,title,type,tags,metadata`);
        const targetMap: Record<string, any> = {};
        targets.forEach((t: any) => { targetMap[t.id] = t; });
        for (const link of outbound) {
          links.push({
            direction: 'outbound',
            link_type: link.link_type,
            context: link.context,
            content: targetMap[link.target_id] || { id: link.target_id },
            created_at: link.created_at,
          });
        }
      }
    }

    if (direction === 'inbound' || direction === 'both') {
      const inbound = await supabaseGet(`content_links?target_id=eq.${content_id}&select=id,source_id,link_type,context,created_at`);
      if (inbound.length) {
        const sourceIds = inbound.map((l: any) => l.source_id);
        const sources = await supabaseGet(`content?id=in.(${sourceIds.join(',')})&select=id,title,type,tags,metadata`);
        const sourceMap: Record<string, any> = {};
        sources.forEach((s: any) => { sourceMap[s.id] = s; });
        for (const link of inbound) {
          links.push({
            direction: 'inbound',
            link_type: link.link_type,
            context: link.context,
            content: sourceMap[link.source_id] || { id: link.source_id },
            created_at: link.created_at,
          });
        }
      }
    }

    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ content_id, total: links.length, links }, null, 2) }],
    };
  }
);

// ─── Group 10: Problem Intelligence ───────────────────────

server.tool(
  'problem_extract',
  'Fetch context for extracting/updating problems from source content (articles, meeting notes, interview transcripts). Returns source content, existing problems, and prompt for Claude to analyse.',
  {
    content_ids: z.array(z.string()).describe('UUIDs of source content items to analyse'),
    problem_ids: z.array(z.string()).optional().describe('Specific problem IDs to focus on (e.g. ["P1", "P3"]). If omitted, all problems are considered.'),
  },
  async ({ content_ids, problem_ids }) => {
    // Fetch source content
    const sourceContent = await supabaseGet(
      `content?id=in.(${content_ids.join(',')})&select=id,title,type,body,tags,metadata`
    );
    if (!sourceContent.length) {
      return { content: [{ type: 'text' as const, text: 'No source content found for the given IDs' }] };
    }

    // Fetch existing problems
    let problemQuery = 'content?type=eq.problem&select=id,title,body,tags,metadata&order=title&limit=100';
    const allProblems = await supabaseGet(problemQuery);

    // Filter to specific problem_ids if provided
    let problems = allProblems;
    if (problem_ids?.length) {
      const pidSet = new Set(problem_ids.map(p => p.toUpperCase()));
      problems = allProblems.filter((p: any) =>
        pidSet.has(p.metadata?.problem_id?.toUpperCase?.())
      );
    }

    // Fetch prompt template
    const promptRes = await supabaseGet('prompts?slug=eq.extract-problems&limit=1');
    const prompt = promptRes?.[0] || null;

    // Build source content text
    const sourceText = sourceContent.map((c: any) =>
      `### ${c.title} (${c.type})\n${c.body?.substring(0, 3000) || '(empty)'}\nTags: ${(c.tags || []).join(', ')}`
    ).join('\n\n---\n\n');

    // Build existing problems reference
    const problemsRef = problems.map((p: any) => {
      const pid = p.metadata?.problem_id || '?';
      const priority = p.metadata?.priority || '?';
      const domain = p.metadata?.problem_domain || '?';
      const excerpt = p.body?.substring(0, 500) || '';
      return `#### ${pid}: ${p.title} [Priority: ${priority}, Domain: ${domain}]\n${excerpt}`;
    }).join('\n\n');

    // Build all problem IDs for quick reference
    const allProblemIds = allProblems.map((p: any) =>
      `${p.metadata?.problem_id || '?'}: ${p.title}`
    ).join('\n');

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          source_content: sourceContent.map((c: any) => ({ id: c.id, title: c.title, type: c.type })),
          source_text: sourceText,
          existing_problems_count: problems.length,
          existing_problems_reference: problemsRef,
          all_problem_ids: allProblemIds,
          system_prompt: prompt?.system_prompt || null,
          user_prompt_template: prompt?.user_prompt_template || null,
          prompt_version: prompt?.version || null,
          instructions: 'Analyse the source content for problem-relevant evidence. For existing problems, identify new evidence, customer quotes, market data, or workflow gaps. For genuinely new problems, propose a new ID following the P-series (P19+) or PP-series convention. Then call problem_write with: problem_updates (existing problem enrichment), new_problems (new problem creation), content_links (links between source and problems), and a summary.',
        }, null, 2),
      }],
    };
  }
);

server.tool(
  'problem_write',
  'Write problem extraction results back to the database. Call this after processing problem_extract data.',
  {
    date: z.string().describe('Date of extraction (YYYY-MM-DD)'),
    source_content_ids: z.array(z.string()).optional().default([]).describe('UUIDs of source content that was analysed'),
    review_data: z.object({
      problem_updates: z.array(z.object({
        problem_id: z.string().describe('Problem ID from metadata (e.g. "P1", "PP3")'),
        update_text: z.string().describe('New evidence or observation to append'),
        evidence_type: z.string().optional().describe('Type: customer_quote, workflow_gap, market_data, interview_insight'),
        source_context: z.string().optional().describe('Where this evidence came from'),
      })).optional().default([]),
      new_problems: z.array(z.object({
        title: z.string(),
        body: z.string(),
        problem_id: z.string().describe('New problem ID (e.g. "P19", "PP11")'),
        priority: z.string().optional().default('Medium'),
        category: z.string().optional(),
        problem_domain: z.string().optional().default('domain'),
        related_problems: z.array(z.string()).optional().default([]),
        tags: z.array(z.string()).optional().default([]),
      })).optional().default([]),
      content_links: z.array(z.object({
        source_id: z.string(),
        target_id: z.string(),
        link_type: z.enum(['evidence', 'related', 'derived_from', 'supports']),
        context: z.string().optional(),
      })).optional().default([]),
      summary: z.string().optional().default(''),
    }).describe('Structured problem extraction results'),
  },
  async ({ date, source_content_ids, review_data }) => {
    const results = { problem_updates: 0, new_problems: 0, content_links: 0 };
    const sourceRef = { extraction_date: date, source_content_ids };

    // Process problem updates — append evidence to existing problems
    for (const update of review_data.problem_updates) {
      // Find the problem by problem_id in metadata
      const problems = await supabaseGet(
        `content?type=eq.problem&metadata->>problem_id=eq.${update.problem_id}&select=id,body,metadata&limit=1`
      );
      if (!problems.length) continue;

      const problem = problems[0];
      const timestamp = new Date().toISOString().split('T')[0];
      const evidenceSection = `\n\n---\n### Evidence Added ${timestamp}${update.evidence_type ? ` (${update.evidence_type})` : ''}\n${update.source_context ? `*Source: ${update.source_context}*\n\n` : ''}${update.update_text}`;

      await supabasePatch(`content?id=eq.${problem.id}`, {
        body: (problem.body || '') + evidenceSection,
        updated_at: new Date().toISOString(),
      });

      // Re-embed the updated problem
      embedItem('content', problem.id).catch(() => {});
      results.problem_updates++;
    }

    // Create new problems
    for (const newProblem of review_data.new_problems) {
      const cleanTags = ['problem', 'discovery', ...(newProblem.tags || [])]
        .map(t => t.trim().toLowerCase())
        .filter(Boolean);

      const result = await supabasePost('content', {
        type: 'problem',
        title: newProblem.title,
        body: newProblem.body,
        tags: cleanTags,
        status: 'active',
        metadata: {
          problem_id: newProblem.problem_id,
          problem_domain: newProblem.problem_domain || 'domain',
          priority: newProblem.priority || 'Medium',
          category: newProblem.category || null,
          related_problems: newProblem.related_problems || [],
          created_from: sourceRef,
        },
      }, true);

      if (result.ok && result.data?.[0]?.id) {
        embedItem('content', result.data[0].id).catch(() => {});
        results.new_problems++;
      }
    }

    // Create content links
    for (const link of review_data.content_links) {
      const linkResult = await supabasePost('content_links', {
        source_id: link.source_id,
        target_id: link.target_id,
        link_type: link.link_type,
        context: link.context || null,
      }, true);
      if (linkResult.ok) results.content_links++;
    }

    // Create audit record
    await supabasePost('ai_reviews', {
      review_type: 'problem_extraction',
      source_date: date,
      status: 'completed',
      output_summary: review_data.summary,
      files_updated: results,
      completed_at: new Date().toISOString(),
    });

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ ok: true, writes: results, summary: review_data.summary }, null, 2),
      }],
    };
  }
);

// ─── Group 11: Strategy Intelligence ──────────────────────

server.tool(
  'strategy_extract',
  'Fetch context for extracting/updating strategies from source content (articles, signals, meeting notes). Returns source content, existing strategies, and prompt for Claude to analyse.',
  {
    content_ids: z.array(z.string()).describe('UUIDs of source content items to analyse'),
    strategy_types: z.array(z.string()).optional().describe('Filter to specific strategy types (e.g. ["product-strategy", "goals"])'),
  },
  async ({ content_ids, strategy_types }) => {
    const sourceContent = await supabaseGet(
      `content?id=in.(${content_ids.join(',')})&select=id,title,type,body,tags,metadata`
    );
    if (!sourceContent.length) {
      return { content: [{ type: 'text' as const, text: 'No source content found for the given IDs' }] };
    }

    let strategyQuery = 'content?type=eq.strategy&select=id,title,body,tags,metadata&order=title&limit=100';
    const allStrategies = await supabaseGet(strategyQuery);

    let strategies = allStrategies;
    if (strategy_types?.length) {
      strategies = allStrategies.filter((s: any) =>
        strategy_types.includes(s.metadata?.strategy_type)
      );
    }

    const promptRes = await supabaseGet('prompts?slug=eq.extract-strategies&limit=1');
    const prompt = promptRes?.[0] || null;

    const sourceText = sourceContent.map((c: any) =>
      `### ${c.title} (${c.type})\n${c.body?.substring(0, 3000) || '(empty)'}\nTags: ${(c.tags || []).join(', ')}`
    ).join('\n\n---\n\n');

    const strategiesRef = strategies.map((s: any) => {
      const st = s.metadata?.strategy_type || '?';
      const pa = s.metadata?.product_area || '?';
      const excerpt = s.body?.substring(0, 400) || '';
      return `#### ${s.title} [Type: ${st}, Area: ${pa}] (ID: ${s.id})\n${excerpt}`;
    }).join('\n\n');

    const allStrategyList = allStrategies.map((s: any) =>
      `${s.metadata?.strategy_type || '?'}: ${s.title} (${s.id})`
    ).join('\n');

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          source_content: sourceContent.map((c: any) => ({ id: c.id, title: c.title, type: c.type })),
          source_text: sourceText,
          existing_strategies_count: strategies.length,
          existing_strategies_reference: strategiesRef,
          all_strategies_list: allStrategyList,
          system_prompt: prompt?.system_prompt || null,
          user_prompt_template: prompt?.user_prompt_template || null,
          prompt_version: prompt?.version || null,
          instructions: 'Analyse the source content for strategy-relevant insights. For existing strategies, identify market trends, competitive intelligence, customer signals, or strategic shifts that should be captured. For genuinely new strategic directions, propose a new strategy record. Then call strategy_write with: strategy_updates (existing strategy enrichment), new_strategies (new strategy creation), content_links (links between source and strategies), and a summary.',
        }, null, 2),
      }],
    };
  }
);

server.tool(
  'strategy_write',
  'Write strategy extraction results back to the database. Call this after processing strategy_extract data.',
  {
    date: z.string().describe('Date of extraction (YYYY-MM-DD)'),
    source_content_ids: z.array(z.string()).optional().default([]).describe('UUIDs of source content that was analysed'),
    review_data: z.object({
      strategy_updates: z.array(z.object({
        strategy_id: z.string().describe('UUID of the strategy to update'),
        update_text: z.string().describe('New insight or evidence to append'),
        insight_type: z.string().optional().describe('Type: market_trend, competitive_intel, customer_signal, strategic_shift'),
        source_context: z.string().optional().describe('Where this insight came from'),
      })).optional().default([]),
      new_strategies: z.array(z.object({
        title: z.string(),
        body: z.string(),
        strategy_type: z.string().optional().default('reference'),
        product_area: z.string().optional().default('Domain'),
        owner: z.string().optional(),
        tags: z.array(z.string()).optional().default([]),
      })).optional().default([]),
      content_links: z.array(z.object({
        source_id: z.string(),
        target_id: z.string(),
        link_type: z.enum(['evidence', 'related', 'derived_from', 'supports']),
        context: z.string().optional(),
      })).optional().default([]),
      summary: z.string().optional().default(''),
    }).describe('Structured strategy extraction results'),
  },
  async ({ date, source_content_ids, review_data }) => {
    const results = { strategy_updates: 0, new_strategies: 0, content_links: 0 };

    // Process strategy updates — append insights to existing strategies
    for (const update of review_data.strategy_updates) {
      const strategies = await supabaseGet(
        `content?id=eq.${update.strategy_id}&type=eq.strategy&select=id,body&limit=1`
      );
      if (!strategies.length) continue;

      const strategy = strategies[0];
      const timestamp = new Date().toISOString().split('T')[0];
      const insightSection = `\n\n---\n### Insight Added ${timestamp}${update.insight_type ? ` (${update.insight_type})` : ''}\n${update.source_context ? `*Source: ${update.source_context}*\n\n` : ''}${update.update_text}`;

      await supabasePatch(`content?id=eq.${strategy.id}`, {
        body: (strategy.body || '') + insightSection,
        updated_at: new Date().toISOString(),
      });

      embedItem('content', strategy.id).catch(() => {});
      results.strategy_updates++;
    }

    // Create new strategies
    for (const newStrategy of review_data.new_strategies) {
      const cleanTags = ['strategy', newStrategy.strategy_type || 'reference', ...(newStrategy.tags || [])]
        .map(t => t.trim().toLowerCase())
        .filter(Boolean);

      const result = await supabasePost('content', {
        type: 'strategy',
        title: newStrategy.title,
        body: newStrategy.body,
        tags: cleanTags,
        status: 'active',
        metadata: {
          strategy_type: newStrategy.strategy_type || 'reference',
          product_area: newStrategy.product_area || 'Domain',
          owner: newStrategy.owner || null,
          doc_status: 'draft',
          created_from: { extraction_date: date, source_content_ids },
        },
      }, true);

      if (result.ok && result.data?.[0]?.id) {
        embedItem('content', result.data[0].id).catch(() => {});
        results.new_strategies++;
      }
    }

    // Create content links
    for (const link of review_data.content_links) {
      const linkResult = await supabasePost('content_links', {
        source_id: link.source_id,
        target_id: link.target_id,
        link_type: link.link_type,
        context: link.context || null,
      }, true);
      if (linkResult.ok) results.content_links++;
    }

    // Create audit record
    await supabasePost('ai_reviews', {
      review_type: 'strategy_extraction',
      source_date: date,
      status: 'completed',
      output_summary: review_data.summary,
      files_updated: results,
      completed_at: new Date().toISOString(),
    });

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ ok: true, writes: results, summary: review_data.summary }, null, 2),
      }],
    };
  }
);

// ─── Group 12: Content–Entity Linking ─────────────────────

server.tool(
  'link_content_to_entity',
  'Link a content item to an entity (company, product, project, or person). Idempotent — duplicate links are ignored.',
  {
    content_id: z.string().describe('UUID of the content item'),
    entity_id: z.string().describe('UUID of the entity'),
    entity_table: z.enum(['companies', 'products', 'projects', 'people']).describe('Which entity table'),
    relationship_type: z.string().optional().default('mentions').describe('e.g. mentions, about, evidence, competitive-intel'),
  },
  async ({ content_id, entity_id, entity_table, relationship_type }) => {
    // Map entity table to junction table
    const junctionMap: Record<string, { table: string; entityCol: string }> = {
      companies: { table: 'company_content', entityCol: 'company_id' },
      products: { table: 'product_content', entityCol: 'product_id' },
    };

    const junction = junctionMap[entity_table];

    if (!junction) {
      // For people and projects, no junction table exists — store as metadata note
      // Verify the entity exists
      const entity = await supabaseGet(`${entity_table}?id=eq.${entity_id}&select=id,name&limit=1`);
      if (!entity.length) {
        return { content: [{ type: 'text' as const, text: `Entity not found in ${entity_table}` }], isError: true };
      }

      // For people: add a people_log entry noting the link
      if (entity_table === 'people') {
        const contentItem = await supabaseGet(`content?id=eq.${content_id}&select=id,title,type&limit=1`);
        const title = contentItem.length ? contentItem[0].title : content_id;
        const contentType = contentItem.length ? contentItem[0].type : 'content';
        await supabasePost('people_log', {
          person_id: entity_id,
          note_date: new Date().toISOString().split('T')[0],
          entry: `Linked ${contentType}: "${title}" (${relationship_type})`,
          source: 'link_content_to_entity',
          source_ref: { content_id, relationship_type },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            ok: true, method: 'people_log', entity_table, entity_name: entity[0].name,
            content_id, relationship_type,
          }, null, 2) }],
        };
      }

      // For projects: add a project_updates entry
      if (entity_table === 'projects') {
        const contentItem = await supabaseGet(`content?id=eq.${content_id}&select=id,title,type&limit=1`);
        const title = contentItem.length ? contentItem[0].title : content_id;
        const contentType = contentItem.length ? contentItem[0].type : 'content';
        await supabasePost('project_updates', {
          project_id: entity_id,
          note_date: new Date().toISOString().split('T')[0],
          update_text: `Linked ${contentType}: "${title}" (${relationship_type})`,
          source_ref: { content_id, relationship_type },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            ok: true, method: 'project_updates', entity_table, entity_name: entity[0].name,
            content_id, relationship_type,
          }, null, 2) }],
        };
      }

      return { content: [{ type: 'text' as const, text: `No junction table for ${entity_table}` }], isError: true };
    }

    // Verify both exist
    const [contentRows, entityRows] = await Promise.all([
      supabaseGet(`content?id=eq.${content_id}&select=id,title&limit=1`),
      supabaseGet(`${entity_table}?id=eq.${entity_id}&select=id,name&limit=1`),
    ]);
    if (!contentRows.length) {
      return { content: [{ type: 'text' as const, text: 'Content item not found' }], isError: true };
    }
    if (!entityRows.length) {
      return { content: [{ type: 'text' as const, text: `Entity not found in ${entity_table}` }], isError: true };
    }

    // Check if link already exists (idempotent)
    const existing = await supabaseGet(
      `${junction.table}?content_id=eq.${content_id}&${junction.entityCol}=eq.${entity_id}&select=id&limit=1`
    );
    if (existing.length) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          ok: true, already_existed: true, junction_id: existing[0].id,
          entity_name: entityRows[0].name, content_title: contentRows[0].title,
        }, null, 2) }],
      };
    }

    // Create the link
    const result = await supabasePost(junction.table, {
      content_id,
      [junction.entityCol]: entity_id,
    }, true);

    if (!result.ok) {
      return { content: [{ type: 'text' as const, text: `Failed to create link: ${result.error}` }], isError: true };
    }

    return {
      content: [{ type: 'text' as const, text: JSON.stringify({
        ok: true, junction_table: junction.table, junction_id: result.data?.[0]?.id,
        entity_table, entity_name: entityRows[0].name,
        content_title: contentRows[0].title, relationship_type,
      }, null, 2) }],
    };
  }
);

} // end registerTools

function registerResources(server: McpServer) {

// ─── Resources (Prompt Templates) ───────────────────────────

server.resource(
  'daily-review-prompt',
  'knowledge://prompts/daily-review',
  async () => ({
    contents: [
      {
        uri: 'knowledge://prompts/daily-review',
        mimeType: 'text/plain',
        text: `You are Paul Land's end-of-day review assistant. Paul is a Domain Lead (Packaging Job Lifecycle) and Product Manager (WebCenter Pack) at Esko.

Your job is to process his daily note and extract structured information into a JSON response. You must identify:

1. **People entries**: Notes about specific people from meetings and notes sections ONLY. Do NOT extract people entries from tasks.
2. **Product evidence**: Evidence, learnings, or feedback about specific products.
3. **Product decisions**: Decisions made about products (strategic, not tactical).
4. **Project updates**: Updates about specific projects.
5. **Reflections**: Leadership observations, coaching insights, self-awareness moments.
6. **Migrated tasks**: Tasks marked [>] or still open [ ] that should carry forward to tomorrow.
7. **Context notes**: Key context from today that would help prepare for tomorrow's meetings.

## Task Notation
- \`[ ]\` = open (not done)
- \`[x]\` = done
- \`[>]\` = migrated (carry forward)
- \`[-]\` = cancelled

## Output Format
Respond with ONLY a JSON object with this structure:
{
  "people_entries": [{ "person_name": "Exact Name", "entry": "..." }],
  "product_evidence": [{ "product_name": "Exact Product", "evidence": "...", "evidence_type": "customer_feedback|metric|decision|observation" }],
  "product_decisions": [{ "product_name": "Exact Product", "decision": "...", "context": "..." }],
  "project_updates": [{ "project_name": "Exact Project", "update": "..." }],
  "reflections": [{ "observation": "...", "coach_perspective": "...", "category": "leadership|coaching|personal" }],
  "migrated_tasks": ["Task text to carry forward"],
  "context_notes": [{ "meeting_title": "...", "context": "..." }],
  "review_summary": "2-3 sentence summary"
}`,
      },
    ],
  })
);

server.resource(
  'weekly-summary-prompt',
  'knowledge://prompts/weekly-summary',
  async () => ({
    contents: [
      {
        uri: 'knowledge://prompts/weekly-summary',
        mimeType: 'text/plain',
        text: `You are Paul Land's weekly review assistant. Paul is a Domain Lead (Packaging Job Lifecycle) and Product Manager (WebCenter Pack) at Esko.

Synthesise the week's daily notes and review data into a comprehensive weekly summary in markdown.

## Sections
### Highlights - 3-4 key accomplishments
### Meetings & Interactions - Organised by day
### Domain Work (Packaging Job Lifecycle) - Strategic/operational progress
### Product Work (WebCenter Pack) - Delivery, decisions, feedback
### Decisions Made - Table: Date | Decision | Context | Impact
### Blockers & Risks
### Learnings
### Tasks Completed
### Leadership & Development - Reflection themes, team coaching, coach's check-in
### Carry Forward - Open tasks
### Next Week Focus - 1-3 priorities

Write in third person ("Paul") for facts, second person ("you") only in Coach's Check-in.`,
      },
    ],
  })
);

server.resource(
  'monthly-summary-prompt',
  'knowledge://prompts/monthly-summary',
  async () => ({
    contents: [
      {
        uri: 'knowledge://prompts/monthly-summary',
        mimeType: 'text/plain',
        text: `You are Paul Land's monthly review assistant. Paul is a Domain Lead (Packaging Job Lifecycle) and Product Manager (WebCenter Pack) at Esko.

Synthesise weekly summaries into a strategic monthly review in markdown.

## Sections
### Month at a Glance - 4-5 bullet narrative
### Strategic Progress - Domain + Product subsections
### Key Decisions - Table: Date | Decision | Impact | Stakeholders
### Patterns & Observations
### Customer & Stakeholder Pulse
### Team & People
### Leadership Development Review - Reflection themes, experiments, coaching perspective
### Next Month Focus

Synthesise and elevate — don't concatenate. Highlight trends over individual events.`,
      },
    ],
  })
);

server.resource(
  'signal-extraction-prompt',
  'knowledge://prompts/signal-extraction',
  async () => ({
    contents: [
      {
        uri: 'knowledge://prompts/signal-extraction',
        mimeType: 'text/plain',
        text: `Extract strategic signals from the provided content. Each signal should be a distinct insight, trend, or piece of intelligence.

Return a JSON array of signal objects:
[
  {
    "title": "Short signal title (max 100 chars)",
    "observation": "The detailed observation or insight (2-3 sentences)",
    "suggested_tags": ["tag1", "tag2"]
  }
]

Extract 1-5 signals per piece of content. Focus on:
- Market trends and shifts
- Competitive intelligence
- Technology developments
- Customer behavior patterns
- Strategic implications
- Industry dynamics`,
      },
    ],
  })
);

} // end registerResources

// Register tools and resources on the module-level server (for local stdio)
registerTools(server);
registerResources(server);

// ─── Export for Worker reuse ─────────────────────────────────

/** Factory: creates a fresh McpServer with all tools/resources registered.
 *  Required for stateless HTTP transport (one server+transport per request). */
export function createServer(): McpServer {
  const s = new McpServer({ name: 'paulland-kb', version: '1.0.0' });
  registerTools(s);
  registerResources(s);
  return s;
}

// Legacy export kept for compatibility
export function getServer() {
  return server;
}

// ─── Start Server (stdio, local only) ───────────────────────

// Only start stdio transport when running directly (not imported by Worker)
const isDirectRun =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('index.js') || process.argv[1].endsWith('launch.cjs'));

if (isDirectRun) {
  (async () => {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  })().catch((err) => {
    console.error('MCP server failed to start:', err);
    process.exit(1);
  });
}
