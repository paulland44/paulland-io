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
import * as XLSX from 'xlsx';

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
  'List content items (articles, thoughts, signals, reflections, problems, strategies, references) with optional filters',
  {
    type: z
      .enum(['article', 'thought', 'signal', 'reflection', 'problem', 'strategy', 'reference', 'summary', 'weekly-summary', 'monthly-review', 'show-and-tell', 'support-review'])
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
        selectFields = 'id,name,type,industry,tags';
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
  'Create a new content item (article, thought, signal, reflection, problem, strategy, reference)',
  {
    type: z
      .enum(['article', 'thought', 'signal', 'reflection', 'problem', 'strategy', 'reference'])
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
      embedItem('content', created.id).catch((err) => {
        console.error(`[create_content] embedding failed for ${created.id}: ${err?.message}`);
      });
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
  'Fetch a daily note with entity context for Claude to perform the daily review extraction in-context (no API call needed). Returns the note content, known entities, the system prompt to use, and any image attachments as vision content blocks.',
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

    // Fetch entity context + problems + prompt + attached images
    const [people, products, projects, problemsRes, promptRes, imageAssets] = await Promise.all([
      supabaseGet('people?select=id,name,role,organization&order=name'),
      supabaseGet('products?select=id,name&order=name'),
      supabaseGet('projects?select=id,name,product_id&order=name'),
      supabaseGet('content?type=eq.problem&select=id,title,metadata&order=title&limit=100'),
      supabaseGet('prompts?slug=eq.daily-review&limit=1'),
      supabaseGet(`assets?metadata->>daily_note_date=eq.${date}&select=id,filename,mime_type,file_size&order=uploaded_at.asc`),
    ]);
    const prompt = promptRes?.[0] || null;

    const peopleNames = people.map((p: any) => p.name);
    const productNames = products.map((p: any) => p.name);
    const projectNames = projects.map((p: any) => p.name);
    const problemsList = problemsRes
      .filter((p: any) => p.metadata?.problem_id && !p.metadata?.is_index)
      .map((p: any) => `${p.metadata.problem_id}: ${p.title}`)
      .join(', ');

    // Filter to supported image types, size-cap each, and cap total count
    const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB
    const MAX_IMAGES = 20;
    const SUPPORTED_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
    const skipped: Array<{ id: string; filename: string; reason: string }> = [];
    const eligible: any[] = [];
    for (const a of imageAssets || []) {
      const mime = (a.mime_type || '').toLowerCase();
      if (!SUPPORTED_IMAGE_MIMES.has(mime)) {
        skipped.push({ id: a.id, filename: a.filename, reason: `unsupported mime_type: ${a.mime_type}` });
        continue;
      }
      if (typeof a.file_size === 'number' && a.file_size > MAX_IMAGE_BYTES) {
        skipped.push({ id: a.id, filename: a.filename, reason: `file_size ${a.file_size} exceeds 5MB cap` });
        continue;
      }
      if (eligible.length >= MAX_IMAGES) {
        skipped.push({ id: a.id, filename: a.filename, reason: `exceeds ${MAX_IMAGES}-image cap` });
        continue;
      }
      eligible.push(a);
    }

    // Fetch image bytes via Pages API (returns { encoding: "base64", content: "..." })
    const apiUrl = _misApiUrl || process.env.PAULLAND_API_URL || 'https://paulland.io/api';
    const internalApiKey = _misInternalApiKey || process.env.PAULLAND_INTERNAL_API_KEY;
    const imageHeaders: Record<string, string> = {};
    if (internalApiKey) imageHeaders['X-Internal-API-Key'] = internalApiKey;

    const imageBlocks: Array<{ type: 'image'; data: string; mimeType: string }> = [];
    const includedImages: Array<{ id: string; filename: string; mime_type: string; index: number }> = [];
    for (let i = 0; i < eligible.length; i++) {
      const a = eligible[i];
      try {
        const resp = await fetch(`${apiUrl}/assets/${a.id}/content`, { headers: imageHeaders });
        if (!resp.ok) {
          skipped.push({ id: a.id, filename: a.filename, reason: `fetch failed: ${resp.status}` });
          continue;
        }
        const data = (await resp.json()) as any;
        if (data.encoding !== 'base64' || !data.content) {
          skipped.push({ id: a.id, filename: a.filename, reason: 'missing base64 content' });
          continue;
        }
        imageBlocks.push({
          type: 'image' as const,
          data: data.content,
          mimeType: a.mime_type,
        });
        includedImages.push({
          id: a.id,
          filename: a.filename,
          mime_type: a.mime_type,
          index: includedImages.length,
        });
      } catch (err: any) {
        skipped.push({ id: a.id, filename: a.filename, reason: `fetch error: ${err.message}` });
      }
    }

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

    if (includedImages.length > 0) {
      userPrompt += `### Attached Images\n${includedImages.length} image(s) follow this prompt as separate content blocks. Read any visible text and use it as additional source material for extraction.\n\n`;
      for (const img of includedImages) {
        userPrompt += `- Image ${img.index + 1}: ${img.filename}\n`;
      }
      userPrompt += '\n';
    }

    const baseInstructions =
      'Process this daily note and extract: people_entries, product_evidence, product_decisions, project_updates, reflections, migrated_tasks, context_notes, problem_observations (if any meetings or notes relate to known problems), and review_summary. Return as JSON. Then call daily_review_write with the results.';
    const imageInstructions = includedImages.length
      ? ` The ${includedImages.length} image block(s) that follow this text are photos/screenshots attached to the daily note. Read any visible text (handwriting, chat screenshots, whiteboards, diagrams, receipts) and treat it as first-class source material alongside the typed notes. When an image materially contributes to an entry, cite it as [image: filename] in the relevant field.`
      : '';

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
              attached_images: includedImages,
              skipped_images: skipped,
              instructions: baseInstructions + imageInstructions,
            },
            null,
            2
          ),
        },
        ...imageBlocks,
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
        persona_updates: z
          .array(
            z.object({
              persona_name: z.string().describe('Name of the persona (e.g. "CSR", "Production Manager")'),
              section: z.string().describe('Section to update (pain_points, discovery_questions, goals, workflow_stages, tools_systems, segment_variations)'),
              observation: z.string().describe('What was learned about this persona'),
            })
          )
          .optional()
          .default([]),
        research_updates: z
          .array(
            z.object({
              content_title: z.string().describe('Title of the research content to update'),
              observation: z.string().describe('New observation or evidence'),
              section: z.string().optional().describe('Which part of the research was updated'),
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

    // Write persona updates
    let personaUpdateCount = 0;
    for (const pu of review_data.persona_updates) {
      if (!pu.persona_name || !pu.observation) continue;
      // Find persona by name (fuzzy match on title)
      const personas = await supabaseGet(
        `content?type=eq.reference&metadata->>reference_type=eq.persona&title=ilike.*${encodeURIComponent(pu.persona_name)}*&select=id,title,body&limit=1`
      );
      if (!personas.length) continue;
      const persona = personas[0];
      const today = date;

      // Map section name to markdown header
      const sectionHeaders: Record<string, string> = {
        pain_points: '## Pain Points', discovery_questions: '## Discovery Questions',
        goals: '## Goals & Motivations', workflow_stages: '## Workflow Stages',
        tools_systems: '## Tools & Systems Used', segment_variations: '## Segment Variations',
        profile: '## Profile', buying_influence: '## Buying Influence',
      };
      const header = sectionHeaders[pu.section] || `## ${pu.section}`;
      const updateBlock = `\n\n> **Update ${today}** (daily_review): ${pu.observation}`;

      let body = persona.body || '';
      const headerIdx = body.indexOf(header);
      if (headerIdx === -1) {
        body += `\n\n${header}\n${updateBlock}`;
      } else {
        const afterHeader = body.indexOf('\n## ', headerIdx + header.length);
        if (afterHeader === -1) {
          body += updateBlock;
        } else {
          body = body.slice(0, afterHeader) + updateBlock + body.slice(afterHeader);
        }
      }

      await supabasePatch(`content?id=eq.${persona.id}`, { body, updated_at: new Date().toISOString() });
      await supabasePost('persona_log', {
        content_id: persona.id, log_date: today, entry: pu.observation,
        source: 'daily_review', source_ref: { daily_note_date: date, section: pu.section },
        section_updated: pu.section,
      });
      embedItem('content', persona.id).catch(() => {});
      personaUpdateCount++;
    }
    (results as any).persona_updates = personaUpdateCount;

    // Write research updates
    let researchUpdateCount = 0;
    for (const ru of review_data.research_updates) {
      if (!ru.content_title || !ru.observation) continue;
      const items = await supabaseGet(
        `content?type=eq.reference&title=ilike.*${encodeURIComponent(ru.content_title)}*&select=id,title,body&limit=1`
      );
      if (!items.length) continue;
      const item = items[0];
      const today = date;
      const updateBlock = `\n\n---\n### Update ${today} (daily_review)${ru.section ? ` — ${ru.section}` : ''}\n${ru.observation}`;

      await supabasePatch(`content?id=eq.${item.id}`, {
        body: (item.body || '') + updateBlock,
        updated_at: new Date().toISOString(),
      });
      await supabasePost('research_log', {
        content_id: item.id, log_date: today, entry: ru.observation,
        source: 'daily_review', source_ref: { daily_note_date: date },
        section_updated: ru.section || null,
      });
      embedItem('content', item.id).catch(() => {});
      researchUpdateCount++;
    }
    (results as any).research_updates = researchUpdateCount;

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

// ─── Asset Tools ─────────────────────────────────────────────

server.tool(
  'list_assets',
  'List assets in the knowledge base asset library with optional tag and type filters',
  {
    tags: z.array(z.string()).optional().describe('Filter by tags (asset must have all specified tags)'),
    mime_type: z.string().optional().describe('Filter by MIME type prefix, e.g. "image/", "application/pdf", "application/vnd"'),
    search: z.string().optional().describe('Search by filename'),
    limit: z.number().optional().default(20).describe('Max items to return'),
    offset: z.number().optional().default(0).describe('Offset for pagination'),
  },
  async ({ tags, mime_type, search, limit, offset }) => {
    let path = `assets?select=id,filename,mime_type,file_size,tags,description,uploaded_at&order=uploaded_at.desc&limit=${limit}&offset=${offset}`;
    if (tags?.length) {
      path += `&tags=cs.{${tags.join(',')}}`;
    }
    if (mime_type) {
      path += `&mime_type=like.${mime_type}*`;
    }
    if (search) {
      path += `&filename=ilike.*${search}*`;
    }
    const rows = await supabaseGet(path);
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          total: rows.length,
          assets: rows,
        }, null, 2),
      }],
    };
  }
);

// ─── Asset Upload & Read Tools ─────────────────────────────

const MIME_BY_EXT: Record<string, string> = {
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pdf': 'application/pdf',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

function guessMimeType(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot === -1) return 'application/octet-stream';
  const ext = filename.slice(dot).toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

server.tool(
  'upload_asset',
  'Upload a file to the knowledge base asset library. Accepts base64-encoded file content. Use this to save documents (Word, Excel, PPT, PDF, images, etc.) from the conversation into the asset library for future reference and analysis.',
  {
    file_content: z.string().describe('Base64-encoded file content'),
    filename: z.string().describe('Original filename with extension (e.g. "report.xlsx", "notes.docx")'),
    mime_type: z.string().optional().describe('MIME type. Auto-detected from extension if omitted.'),
    tags: z.array(z.string()).optional().default([]).describe('Tags for organizing the asset'),
    description: z.string().optional().default('').describe('Description of the file'),
    product_id: z.string().optional().describe('Optional product UUID to link the asset to'),
  },
  async ({ file_content, filename, mime_type, tags, description, product_id }) => {
    try {
      const binary = Uint8Array.from(atob(file_content), c => c.charCodeAt(0));
      const buffer = binary.buffer as ArrayBuffer;
      const resolvedMime = mime_type || guessMimeType(filename);

      const result = await uploadAssetToR2(buffer, filename, resolvedMime, tags, description, product_id);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        isError: !result.ok,
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: `Base64 decode or upload failed: ${err.message}` }) }],
        isError: true,
      };
    }
  }
);

server.tool(
  'get_asset_content',
  'Read the content of a file from the asset library. Returns text content directly for text-based files (CSV, TSV, TXT, Markdown). Parses XLSX to CSV. Returns base64 for binary files (DOCX, PPTX, PDF, images) which Claude can interpret natively.',
  {
    asset_id: z.string().describe('UUID of the asset to read'),
  },
  async ({ asset_id }) => {
    // 1. Look up asset metadata
    const rows = await supabaseGet(`assets?id=eq.${asset_id}&select=id,filename,mime_type,r2_key,tags,description`);
    const asset = rows?.[0];
    if (!asset) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Asset not found' }) }], isError: true };
    }

    // 2. Fetch file content via Pages API
    const apiUrl = _misApiUrl || process.env.PAULLAND_API_URL || 'https://paulland.io/api';
    const internalApiKey = _misInternalApiKey || process.env.PAULLAND_INTERNAL_API_KEY;
    const headers: Record<string, string> = {};
    if (internalApiKey) headers['X-Internal-API-Key'] = internalApiKey;

    try {
      const resp = await fetch(`${apiUrl}/assets/${asset.id}/content`, { headers });
      if (!resp.ok) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Failed to fetch file: ${resp.status}` }) }], isError: true };
      }

      const fileData = await resp.json() as any;

      // 3. Text files — return directly
      if (fileData.encoding === 'text') {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            filename: asset.filename,
            mime_type: asset.mime_type,
            tags: asset.tags,
            description: asset.description,
            encoding: 'text',
            content: fileData.content,
          }, null, 2) }],
        };
      }

      // 4. XLSX — parse to CSV with SheetJS
      const mime = asset.mime_type || '';
      if (mime.includes('spreadsheet') || mime.includes('excel') || asset.filename?.endsWith('.xlsx') || asset.filename?.endsWith('.xls')) {
        try {
          const binary = Uint8Array.from(atob(fileData.content), c => c.charCodeAt(0));
          const workbook = XLSX.read(binary, { type: 'array' });
          const sheets: Record<string, string> = {};
          for (const name of workbook.SheetNames) {
            sheets[name] = XLSX.utils.sheet_to_csv(workbook.Sheets[name]);
          }
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
              filename: asset.filename,
              mime_type: asset.mime_type,
              tags: asset.tags,
              description: asset.description,
              encoding: 'text',
              sheets,
            }, null, 2) }],
          };
        } catch (xlsErr: any) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `XLSX parse error: ${xlsErr.message}` }) }], isError: true };
        }
      }

      // 5. Other binary files (PDF, DOCX, PPTX, images) — return base64
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          filename: asset.filename,
          mime_type: asset.mime_type,
          tags: asset.tags,
          description: asset.description,
          encoding: 'base64',
          content: fileData.content,
        }, null, 2) }],
      };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Fetch error: ${err.message}` }) }], isError: true };
    }
  }
);

server.tool(
  'batch_update_assets',
  'Perform bulk operations on multiple assets at once. Supports: add_tags, remove_tags, replace_tags, set_company, set_description, link_product, unlink_product, delete.',
  {
    asset_ids: z.array(z.string()).min(1).max(200).describe('Array of asset UUIDs to update'),
    operation: z.object({
      type: z.enum(['add_tags', 'remove_tags', 'replace_tags', 'set_company', 'set_description', 'link_product', 'unlink_product', 'delete']).describe('Operation type'),
      tags: z.array(z.string()).optional().describe('Tags for add_tags, remove_tags, or replace_tags operations'),
      company_id: z.string().nullable().optional().describe('Company UUID for set_company (null to clear)'),
      description: z.string().optional().describe('Description text for set_description'),
      product_id: z.string().optional().describe('Product UUID for link_product or unlink_product'),
    }).describe('Operation to perform'),
  },
  async ({ asset_ids, operation }) => {
    const apiUrl = _misApiUrl || process.env.PAULLAND_API_URL || 'https://paulland.io/api';
    const internalApiKey = _misInternalApiKey || process.env.PAULLAND_INTERNAL_API_KEY;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (internalApiKey) headers['X-Internal-API-Key'] = internalApiKey;

    // Add CF Access headers if available
    const clientId = _misCfClientId || process.env.CF_ACCESS_CLIENT_ID;
    const clientSecret = _misCfClientSecret || process.env.CF_ACCESS_CLIENT_SECRET;
    if (clientId) headers['CF-Access-Client-Id'] = clientId;
    if (clientSecret) headers['CF-Access-Client-Secret'] = clientSecret;

    try {
      const resp = await fetch(`${apiUrl}/assets/batch-update`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ asset_ids, operation }),
      });

      const result = await resp.json() as any;
      if (!resp.ok) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: result.error || 'Batch update failed', status: resp.status }) }], isError: true };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          ok: true,
          operation: operation.type,
          total: asset_ids.length,
          succeeded: result.succeeded,
          failed: result.failed,
          errors: result.errors,
        }, null, 2) }],
      };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Batch update error: ${err.message}` }) }], isError: true };
    }
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

    // 3. Fetch file content via API and parse if needed
    let fileText = '';
    let parseError = '';
    try {
      const resp = await fetch(`${apiUrl}/assets/${asset.id}/content`, { headers });
      if (!resp.ok) {
        parseError = `Failed to fetch file: ${resp.status}`;
      } else {
        const fileData = await resp.json();
        if (fileData.encoding === 'text') {
          // CSV/TSV — use directly
          fileText = fileData.content;
        } else if (fileData.encoding === 'base64') {
          // Binary (XLSX) — parse with SheetJS
          try {
            const binary = Uint8Array.from(atob(fileData.content), c => c.charCodeAt(0));
            const workbook = XLSX.read(binary, { type: 'array' });
            const sheetName = workbook.SheetNames[0];
            if (sheetName) {
              fileText = XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName]);
            } else {
              parseError = 'XLSX file has no sheets';
            }
          } catch (xlsErr: any) {
            parseError = `XLSX parse error: ${xlsErr.message}`;
          }
        }
      }
    } catch (err: any) {
      parseError = `Fetch error: ${err.message}`;
    }

    // 4. Fetch known entities for matching
    const [people, products] = await Promise.all([
      supabaseGet('people?select=id,name&order=name'),
      supabaseGet('products?select=id,name&order=name'),
    ]);

    // 5. Count actual case data rows (skip metadata/headers/footer)
    const allRows = fileText.split('\n');
    let totalCases = 0;
    const headerIdx = allRows.findIndex(r => r.includes('Case Number'));
    if (headerIdx >= 0) {
      const headerCols = allRows[headerIdx].split(',').map(c => c.trim().replace(/^"|"$/g, ''));
      const caseNumCol = headerCols.findIndex(c => c === 'Case Number');
      if (caseNumCol >= 0) {
        for (let i = headerIdx + 1; i < allRows.length; i++) {
          const cols = allRows[i].split(',');
          const val = (cols[caseNumCol] || '').trim().replace(/^"|"$/g, '');
          if (/^\d{8}$/.test(val)) totalCases++;
        }
      }
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          date: reviewDate,
          asset_id: asset.id,
          file_name: asset.filename,
          mime_type: asset.mime_type,
          total_cases: totalCases,
          file_content: fileText || null,
          parse_error: parseError || undefined,
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

// ─── Sales Report Tools (Extract / Write) ────────────────────

server.tool(
  'sales_report_extract',
  'Fetch a sales report XLSX from the asset library and return parsed sheet data plus the prompt template so Claude can analyse revenue in-context. Returns CSV data for three sheets: Revenue by BU & products, Core by Geo, Tilia by Geo.',
  {
    asset_id: z.string().optional().describe('UUID of the uploaded sales report asset. If omitted, uses the most recent asset tagged "sales-report"'),
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
      const rows = await supabaseGet('assets?tags=cs.{sales-report}&order=uploaded_at.desc&limit=1&select=id,filename,mime_type,r2_key,tags');
      asset = rows?.[0];
    }
    if (!asset) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'No sales report asset found. Upload an XLSX file to the asset library and tag it "sales-report".' }) }] };
    }

    // 2. Fetch prompt template
    const prompts = await supabaseGet('prompts?slug=eq.sales-report&select=system_prompt,user_prompt_template');
    const prompt = prompts?.[0];

    // 3. Fetch file content via API
    const apiUrl = _misApiUrl || process.env.PAULLAND_API_URL || 'https://paulland.io/api';
    const internalApiKey = _misInternalApiKey || process.env.PAULLAND_INTERNAL_API_KEY;
    const headers: Record<string, string> = {};
    if (internalApiKey) headers['X-Internal-API-Key'] = internalApiKey;

    const sheetNames = ['Revenue by BU & products', 'Core by Geo', 'Tilia by Geo', 'Settings'];
    const sheets: Record<string, string> = {};
    let parseError = '';
    let reportPeriod = { month: '', year: '' };

    try {
      const resp = await fetch(`${apiUrl}/assets/${asset.id}/content`, { headers });
      if (!resp.ok) {
        parseError = `Failed to fetch file: ${resp.status}`;
      } else {
        const fileData = await resp.json();
        if (fileData.encoding !== 'base64') {
          parseError = 'Expected base64-encoded XLSX file';
        } else {
          try {
            const binary = Uint8Array.from(atob(fileData.content), c => c.charCodeAt(0));
            const workbook = XLSX.read(binary, { type: 'array' });

            for (const name of sheetNames) {
              const ws = workbook.Sheets[name];
              if (ws) {
                sheets[name] = XLSX.utils.sheet_to_csv(ws);
              }
            }

            // Parse Settings sheet for period info
            if (sheets['Settings']) {
              const settingsLines = sheets['Settings'].split('\n');
              for (const line of settingsLines) {
                const cols = line.split(',');
                if (cols[1]?.trim() === 'Current Month') reportPeriod.month = cols[2]?.trim() || '';
                if (cols[1]?.trim() === 'Current Year') reportPeriod.year = cols[2]?.trim() || '';
              }
            }

            if (!sheets['Revenue by BU & products']) {
              parseError = 'Sheet "Revenue by BU & products" not found in workbook. Available: ' + workbook.SheetNames.join(', ');
            }
          } catch (xlsErr: any) {
            parseError = `XLSX parse error: ${xlsErr.message}`;
          }
        }
      }
    } catch (err: any) {
      parseError = `Fetch error: ${err.message}`;
    }

    // 4. Fetch known products for entity matching
    const products = await supabaseGet('products?select=id,name&order=name');

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          date: reviewDate,
          asset_id: asset.id,
          file_name: asset.filename,
          report_period: reportPeriod,
          sheets: {
            revenue: sheets['Revenue by BU & products'] || null,
            core_geo: sheets['Core by Geo'] || null,
            tilia_geo: sheets['Tilia by Geo'] || null,
          },
          parse_error: parseError || undefined,
          system_prompt: prompt?.system_prompt || null,
          user_prompt_template: prompt?.user_prompt_template || null,
          known_products: products?.map((p: any) => ({ id: p.id, name: p.name })) || [],
        }, null, 2),
      }],
    };
  }
);

server.tool(
  'sales_report_write',
  'Write the structured results of a sales report analysis back to the database. Call this after processing sales_report_extract data.',
  {
    date: z.string().describe('Report date in YYYY-MM-DD format'),
    period: z.string().describe('Report period string, e.g. "2026-01"'),
    asset_id: z.string().optional().describe('UUID of the source sales report asset'),
    review_data: z.object({
      summary: z.string().optional().default(''),
      period_label: z.string().describe('Human-readable period, e.g. "January 2026"'),
      products: z.record(z.string(), z.object({
        name: z.string(),
        monthly: z.object({
          actual: z.number(),
          py: z.number(),
          growth_dollar: z.number(),
          growth_pct: z.number().nullable(),
          fc: z.number().nullable().optional(),
          fc_gap: z.number().nullable().optional(),
        }),
        revenue_mix: z.object({
          perpetual: z.number(),
          services: z.number(),
          saas: z.number(),
          maintenance: z.number(),
        }),
        recurring_pct: z.number().nullable(),
        ytd: z.object({
          actual: z.number(),
          py: z.number(),
          growth_pct: z.number().nullable(),
        }).optional(),
        observations: z.array(z.string()).optional().default([]),
      })).describe('Product data keyed by product code (e.g. PC3675)'),
      geo: z.object({
        core: z.record(z.string(), z.object({
          actual: z.number(),
          py: z.number().optional(),
          growth_pct: z.number().nullable().optional(),
        })).optional(),
        tilia: z.record(z.string(), z.object({
          actual: z.number(),
          py: z.number().optional(),
          growth_pct: z.number().nullable().optional(),
        })).optional(),
      }).optional(),
    }).describe('Structured sales report analysis'),
  },
  async ({ date, period, asset_id, review_data }) => {
    // 1. Fetch product entity map
    const products = await supabaseGet('products?select=id,name&order=name');
    const productMap: Record<string, string> = {};
    products.forEach((p: any) => { productMap[p.name.toLowerCase()] = p.id; });

    const sourceRef = { sales_report_date: date, period, asset_id };
    const results = { product_evidence: 0 };

    // 2. Build markdown body
    const fmtK = (v: number) => {
      if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(1)}m`;
      return `${Math.round(v)}`;
    };
    const fmtPct = (v: number | null) => v != null ? `${(v * 100).toFixed(1)}%` : 'N/A';
    const fmtGrowth = (v: number) => v >= 0 ? `+${fmtK(v)}` : `${fmtK(v)}`;

    let body = `# Sales Report — ${review_data.period_label}\n\n`;
    if (review_data.summary) body += `${review_data.summary}\n\n`;

    for (const [code, prod] of Object.entries(review_data.products)) {
      const m = prod.monthly;
      const mix = prod.revenue_mix;
      body += `## ${prod.name} (${code})\n\n`;
      body += `### Revenue Summary ($k)\n`;
      body += `| Metric | ${review_data.period_label} | Prior Year | Growth $ | YoY % |\n|---|---:|---:|---:|---:|\n`;
      body += `| **Total** | **${fmtK(m.actual)}** | **${fmtK(m.py)}** | **${fmtGrowth(m.growth_dollar)}** | **${fmtPct(m.growth_pct)}** |\n`;
      body += `| Perpetual Sales | ${fmtK(mix.perpetual)} | — | — | — |\n`;
      body += `| Non-Recurring Services | ${fmtK(mix.services)} | — | — | — |\n`;
      body += `| SaaS / Subscriptions | ${fmtK(mix.saas)} | — | — | — |\n`;
      body += `| Maintenance | ${fmtK(mix.maintenance)} | — | — | — |\n\n`;

      const recurring = mix.saas + mix.maintenance;
      const recurPct = m.actual > 0 ? (recurring / m.actual * 100).toFixed(1) : 'N/A';
      body += `**Recurring mix**: ${recurPct}%`;
      if (m.fc != null && m.fc_gap != null) {
        body += ` | **vs Prior FC**: ${fmtGrowth(m.fc_gap)}k (${fmtPct(m.fc_gap / m.fc)})`;
      }
      body += '\n\n';

      if (prod.observations?.length) {
        body += `### Key Observations\n`;
        body += prod.observations.map(o => `- ${o}`).join('\n');
        body += '\n\n';
      }
    }

    // Geo section
    if (review_data.geo) {
      body += `## Geographic Breakdown\n\n`;
      if (review_data.geo.core) {
        body += `### Core Software (AE proxy)\n`;
        body += `| Region | Actual ($k) | Prior Year | YoY % |\n|---|---:|---:|---:|\n`;
        for (const [region, data] of Object.entries(review_data.geo.core)) {
          body += `| ${region} | ${fmtK(data.actual)} | ${data.py != null ? fmtK(data.py) : '—'} | ${fmtPct(data.growth_pct ?? null)} |\n`;
        }
        body += '\n';
      }
      if (review_data.geo.tilia) {
        body += `### Tilia Software (Phoenix proxy)\n`;
        body += `| Region | Actual ($k) | Prior Year | YoY % |\n|---|---:|---:|---:|\n`;
        for (const [region, data] of Object.entries(review_data.geo.tilia)) {
          body += `| ${region} | ${fmtK(data.actual)} | ${data.py != null ? fmtK(data.py) : '—'} | ${fmtPct(data.growth_pct ?? null)} |\n`;
        }
        body += '\n';
      }
    }

    if (asset_id) body += `\n---\n*Source file: asset ${asset_id}*\n`;

    // 3. Create/update content record (type=summary with sales-report tag)
    const existing = await supabaseGet(`content?type=eq.summary&tags=cs.{sales-report}&metadata->>period=eq.${period}&limit=1`);

    const metadata = {
      report_type: 'sales-report',
      period,
      period_label: review_data.period_label,
      products: review_data.products,
      geo: review_data.geo || {},
      asset_id,
    };

    let contentId: string;
    if (existing.length) {
      contentId = existing[0].id;
      await supabasePatch(`content?id=eq.${contentId}`, {
        body,
        metadata,
        status: 'reviewed',
      });
    } else {
      const created = await supabasePost('content', {
        type: 'summary',
        title: `Sales Report — ${review_data.period_label}`,
        body,
        tags: ['sales-report', period],
        status: 'reviewed',
        metadata,
      }, true);
      contentId = created.data?.[0]?.id || 'unknown';
    }

    // 4. Write product evidence entries
    for (const [code, prod] of Object.entries(review_data.products)) {
      const productId = productMap[prod.name.toLowerCase()];
      if (!productId) continue;

      const m = prod.monthly;
      const mix = prod.revenue_mix;
      const recurring = mix.saas + mix.maintenance;
      const recurPct = m.actual > 0 ? (recurring / m.actual * 100).toFixed(1) : 'N/A';

      await supabasePost('product_evidence', {
        product_id: productId,
        note_date: date,
        evidence: `${review_data.period_label} revenue: $${fmtK(m.actual)}k (${fmtPct(m.growth_pct)} YoY). Recurring mix: ${recurPct}%. SaaS: $${fmtK(mix.saas)}k, Maintenance: $${fmtK(mix.maintenance)}k.`,
        evidence_type: 'sales_report',
        source_ref: sourceRef,
      });
      results.product_evidence++;
    }

    // 5. Create audit record
    await supabasePost('ai_reviews', {
      review_type: 'sales_report',
      source_date: date,
      status: 'completed',
      output_summary: review_data.summary || `Sales report for ${review_data.period_label}`,
      files_updated: { content_id: contentId, asset_id, period, ...results },
      completed_at: new Date().toISOString(),
    });

    // 6. Embed the content
    if (contentId && contentId !== 'unknown') {
      embedItem('content', contentId).catch(() => {});
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          ok: true,
          content_id: contentId,
          asset_id,
          period,
          writes: results,
          action: existing.length ? 'updated' : 'created',
        }, null, 2),
      }],
    };
  }
);

// ─── Revenue Import Tool ──────────────────────────────────────

server.tool(
  'import_revenue',
  'Import revenue data from a monthly Sales Report XLSX into the revenue table. Parses the "Revenue by BU & products" sheet for the 5 target products, reads month/year from the Settings sheet, and inserts rows for each product × revenue type. Idempotent — deletes existing rows for the same period before inserting.',
  {
    asset_id: z.string().describe('UUID of the uploaded sales report XLSX asset'),
  },
  async ({ asset_id }) => {
    // 1. Fetch asset
    const assets = await supabaseGet(`assets?id=eq.${asset_id}&select=id,filename,mime_type`);
    const asset = assets?.[0];
    if (!asset) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Asset not found' }) }] };

    // 2. Fetch and parse file
    const apiUrl = _misApiUrl || process.env.PAULLAND_API_URL || 'https://paulland.io/api';
    const internalApiKey = _misInternalApiKey || process.env.PAULLAND_INTERNAL_API_KEY;
    const headers: Record<string, string> = {};
    if (internalApiKey) headers['X-Internal-API-Key'] = internalApiKey;

    let parseError = '';
    let revenueSheet: any = null;
    let settingsSheet: any = null;

    try {
      const resp = await fetch(`${apiUrl}/assets/${asset_id}/content`, { headers });
      if (!resp.ok) { parseError = `Failed to fetch: ${resp.status}`; }
      else {
        const fileData = await resp.json();
        if (fileData.encoding !== 'base64') { parseError = 'Expected base64 XLSX'; }
        else {
          const binary = Uint8Array.from(atob(fileData.content), c => c.charCodeAt(0));
          const workbook = XLSX.read(binary, { type: 'array' });
          // Try all known sheet name variants
          revenueSheet = workbook.Sheets['Revenue by BU & products'] || workbook.Sheets['EskoTG Total'] || workbook.Sheets['Esko Total'];
          settingsSheet = workbook.Sheets['Settings'];
          if (!revenueSheet) parseError = 'Revenue sheet not found. Available: ' + workbook.SheetNames.join(', ');
        }
      }
    } catch (err: any) { parseError = `Parse error: ${err.message}`; }

    if (parseError) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: parseError }) }] };

    // 3. Read month/year from Settings
    let reportMonth = '';
    let reportYear = '';
    if (settingsSheet) {
      const settingsRows = XLSX.utils.sheet_to_json(settingsSheet, { header: 1 }) as any[];
      for (const row of settingsRows) {
        if (row[1] === 'Current Month') reportMonth = String(row[2] || '');
        if (row[1] === 'Current Year') reportYear = String(row[2] || '');
      }
    }

    // Map month names to numbers
    const monthMap: Record<string, number> = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
    const monthNum = monthMap[reportMonth] || parseInt(reportMonth) || 0;
    const yearNum = parseInt(reportYear) || 0;
    if (!monthNum || !yearNum) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Could not determine month/year from Settings: month=${reportMonth}, year=${reportYear}` }) }] };

    const period = `${yearNum}-${String(monthNum).padStart(2, '0')}`;

    // 4. Parse revenue data
    const rows = XLSX.utils.sheet_to_json(revenueSheet, { header: 1 }) as any[];

    const targetProducts: Record<string, string> = {
      PC3675: 'Automation Engine',
      PC3753: 'WebCenter Pack',
      PC3751: 'ECL Transactions',
      PC3752: 'ECL Storage',
      PC3360: 'Phoenix',
    };

    const ud2Map: Record<string, string> = {
      Top2: 'total',
      Sale_NR: 'perpetual',
      Serv_NR: 'services',
      Sale_Re: 'saas_subscriptions',
      Serv_Re: 'maintenance',
    };

    const revenueRows: any[] = [];

    // Auto-detect column layout by checking year labels in row 3
    // 2026 format: actual=9, PY=10, 2YB=11, growth$=12, growth%=13, FC=16, FCgap=17
    // 2025 format: actual=9, PY=13, 2YB=17, growth$=21, FC=25, FCgap=26
    const yearRow = rows[3] || [];
    const is2025Format = yearRow[13] && String(yearRow[13]).match(/^\d{4}$/) && !String(yearRow[10] || '').match(/^\d{4}$/);
    const colMap = is2025Format
      ? { actual: 9, py: 13, twoYB: 17, growthD: 21, growthP: -1, fc: 25, fcGap: 26 }
      : { actual: 9, py: 10, twoYB: 11, growthD: 12, growthP: 13, fc: 16, fcGap: 17 };

    for (const row of rows) {
      const ud1 = String(row[4] || '');
      const ud2 = String(row[5] || '');
      const productCode = ud1;
      const revenueType = ud2Map[ud2];

      if (!targetProducts[productCode] || !revenueType) continue;

      const actual = parseFloat(row[colMap.actual]) || 0;
      const py = parseFloat(row[colMap.py]) || 0;
      const twoYBack = parseFloat(row[colMap.twoYB]) || 0;
      const growthDollar = parseFloat(row[colMap.growthD]) || 0;
      const growthPct = colMap.growthP >= 0 && row[colMap.growthP] != null ? parseFloat(row[colMap.growthP]) || null : (py !== 0 ? (actual - py) / Math.abs(py) : null);
      const fc = row[colMap.fc] != null && !isNaN(parseFloat(row[colMap.fc])) ? parseFloat(row[colMap.fc]) : null;
      const fcGap = row[colMap.fcGap] != null && !isNaN(parseFloat(row[colMap.fcGap])) ? parseFloat(row[colMap.fcGap]) : null;

      revenueRows.push({
        period,
        year: yearNum,
        month: monthNum,
        product_code: productCode,
        product_name: targetProducts[productCode],
        revenue_type: revenueType,
        actual: Math.round(actual * 100) / 100,
        prior_year: Math.round(py * 100) / 100,
        two_year_back: Math.round(twoYBack * 100) / 100,
        growth_dollar: Math.round(growthDollar * 100) / 100,
        growth_pct: growthPct != null ? Math.round(growthPct * 10000) / 10000 : null,
        fc,
        fc_gap: fcGap,
        source_file: asset_id,
      });
    }

    if (!revenueRows.length) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'No matching product rows found in revenue sheet' }) }] };

    // 5. Delete existing rows for this period (idempotent)
    await supabaseDelete(`revenue?period=eq.${period}`);

    // 6. Insert
    const result = await supabasePost('revenue', revenueRows);

    const byProduct: Record<string, number> = {};
    revenueRows.forEach(r => { byProduct[r.product_code] = (byProduct[r.product_code] || 0) + 1; });

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          ok: true,
          asset_id,
          period,
          year: yearNum,
          month: monthNum,
          format: is2025Format ? '2025 (EskoTG Total)' : '2026 (Revenue by BU & products)',
          rows_inserted: revenueRows.length,
          by_product: byProduct,
        }, null, 2),
      }],
    };
  }
);

// ─── Bookings Import Tool ─────────────────────────────────────

server.tool(
  'import_bookings',
  'Import bookings data from an adapted pivot-table XLSX into the bookings table. The XLSX should have columns: Week, Order Number, End User, Order Name, Subsegment, Bookings, Purpose Code + Description, Region, Subregion, Country, Channel, Type, Sales Rep, SalesOrg_L3, 2024, 2025, 2026. Each row is one order-line for one product. Appends rows to the bookings table.',
  {
    asset_id: z.string().describe('UUID of the uploaded bookings XLSX asset'),
    replace_source: z.boolean().optional().default(false).describe('If true, deletes existing rows with same source_file before inserting. Use to re-import a corrected file.'),
  },
  async ({ asset_id, replace_source }) => {
    // 1. Fetch asset info
    const assets = await supabaseGet(`assets?id=eq.${asset_id}&select=id,filename,mime_type`);
    const asset = assets?.[0];
    if (!asset) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Asset not found' }) }] };
    }

    // 2. Fetch file content
    const apiUrl = _misApiUrl || process.env.PAULLAND_API_URL || 'https://paulland.io/api';
    const internalApiKey = _misInternalApiKey || process.env.PAULLAND_INTERNAL_API_KEY;
    const headers: Record<string, string> = {};
    if (internalApiKey) headers['X-Internal-API-Key'] = internalApiKey;

    let rows: any[] = [];
    let parseError = '';

    try {
      const resp = await fetch(`${apiUrl}/assets/${asset_id}/content`, { headers });
      if (!resp.ok) { parseError = `Failed to fetch: ${resp.status}`; }
      else {
        const fileData = await resp.json();
        if (fileData.encoding !== 'base64') { parseError = 'Expected base64 XLSX'; }
        else {
          const binary = Uint8Array.from(atob(fileData.content), c => c.charCodeAt(0));
          const workbook = XLSX.read(binary, { type: 'array' });
          const ws = workbook.Sheets[workbook.SheetNames[0]];
          if (!ws) { parseError = 'No sheets found'; }
          else {
            const jsonData = XLSX.utils.sheet_to_json(ws, { defval: 0 });
            rows = jsonData;
          }
        }
      }
    } catch (err: any) { parseError = `Parse error: ${err.message}`; }

    if (parseError) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: parseError }) }] };
    }

    // 3. If replace_source, delete existing rows for this asset
    if (replace_source) {
      await supabaseDelete(`bookings?source_file=eq.${asset_id}`);
    }

    // 4. Detect year columns dynamically (files may have 2023/2024/2025 or 2024/2025/2026)
    const sampleRow = rows[0] || {};
    const yearCols = ['2023', '2024', '2025', '2026'].filter(y => y in sampleRow);
    const sortedYears = yearCols.map(Number).sort();

    // 5. Map and insert rows
    const targetProducts = ['3675', '3753', '3751', '3752', '3360'];
    const results: Record<string, number> = {};
    let inserted = 0;
    let skipped = 0;

    const batch: any[] = [];
    for (const row of rows) {
      const productCode = row['Purpose Code + Description'] || '';
      const codePrefix = productCode.split(' ')[0];

      if (!targetProducts.includes(codePrefix) && !targetProducts.some(t => productCode.includes(t))) {
        if (targetProducts.length > 0 && !productCode) { skipped++; continue; }
      }

      const week = parseInt(row['Week']) || 0;
      const v2023 = parseFloat(row['2023']) || 0;
      const v2024 = parseFloat(row['2024']) || 0;
      const v2025 = parseFloat(row['2025']) || 0;
      const v2026 = parseFloat(row['2026']) || 0;

      // Determine primary year from the latest year column with data
      const year = v2026 ? 2026 : v2025 ? 2025 : v2024 ? 2024 : v2023 ? 2023 : (sortedYears[sortedYears.length - 1] || 2026);

      batch.push({
        week,
        year,
        order_number: String(row['Order Number'] || ''),
        end_user: String(row['End User'] || ''),
        customer_name: String(row['Order Name'] || ''),
        subsegment: String(row['Subsegment'] || ''),
        booking_type: String(row['Bookings'] || ''),
        product_code: productCode,
        region: String(row['Region'] || ''),
        subregion: String(row['Subregion'] || ''),
        country: String(row['Country'] || ''),
        channel: String(row['Channel'] || ''),
        order_type: String(row['Type'] || ''),
        sales_rep: String(row['Sales Rep'] || ''),
        sales_org: String(row['SalesOrg_L3'] || ''),
        value_2023: v2023,
        value_2024: v2024,
        value_2025: v2025,
        value_2026: v2026,
        source_file: asset_id,
      });

      results[codePrefix] = (results[codePrefix] || 0) + 1;

      // Insert in batches of 50
      if (batch.length >= 50) {
        const res = await supabasePost('bookings', batch);
        if (res.ok) inserted += batch.length;
        batch.length = 0;
      }
    }

    // Insert remaining
    if (batch.length > 0) {
      const res = await supabasePost('bookings', batch);
      if (res.ok) inserted += batch.length;
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          ok: true,
          asset_id,
          year_columns_detected: yearCols,
          total_rows: rows.length,
          inserted,
          skipped,
          by_product: results,
        }, null, 2),
      }],
    };
  }
);

// ─── Bookings Report Tools (Extract / Write) ─────────────────

server.tool(
  'bookings_report_extract',
  'Fetch a bookings report XLSB/XLSX from the asset library and return parsed sheet data plus the prompt template so Claude can analyse bookings in-context. Returns CSV data for four sheets: Product analysis, Source Qview, Segment analysis, Source Weekly Tracker.',
  {
    asset_id: z.string().optional().describe('UUID of the uploaded bookings report asset. If omitted, uses the most recent asset tagged "bookings-report"'),
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
      const rows = await supabaseGet('assets?tags=cs.{bookings-report}&order=uploaded_at.desc&limit=1&select=id,filename,mime_type,r2_key,tags');
      asset = rows?.[0];
    }
    if (!asset) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'No bookings report asset found. Upload a bookings report file to the asset library and tag it "bookings-report".' }) }] };
    }

    // 2. Fetch prompt template
    const prompts = await supabaseGet('prompts?slug=eq.bookings-report&select=system_prompt,user_prompt_template');
    const prompt = prompts?.[0];

    // 3. Fetch file content via API
    const apiUrl = _misApiUrl || process.env.PAULLAND_API_URL || 'https://paulland.io/api';
    const internalApiKey = _misInternalApiKey || process.env.PAULLAND_INTERNAL_API_KEY;
    const headers: Record<string, string> = {};
    if (internalApiKey) headers['X-Internal-API-Key'] = internalApiKey;

    const targetSheets = ['Product analysis', 'Source Qview', 'Segment analysis', 'Source Weekly Tracker', 'Source Tilia'];
    const sheets: Record<string, string> = {};
    let parseError = '';
    let reportContext = { year: '', month: '', week: '' };

    try {
      const resp = await fetch(`${apiUrl}/assets/${asset.id}/content`, { headers });
      if (!resp.ok) {
        parseError = `Failed to fetch file: ${resp.status}`;
      } else {
        const fileData = await resp.json();
        if (fileData.encoding !== 'base64') {
          parseError = 'Expected base64-encoded file';
        } else {
          try {
            const binary = Uint8Array.from(atob(fileData.content), c => c.charCodeAt(0));
            const workbook = XLSX.read(binary, { type: 'array' });

            for (const name of targetSheets) {
              const ws = workbook.Sheets[name];
              if (ws) {
                sheets[name] = XLSX.utils.sheet_to_csv(ws);
              }
            }

            // Parse Source Qview for report context (Year/Month at top)
            if (sheets['Source Qview']) {
              const lines = sheets['Source Qview'].split('\n');
              for (const line of lines) {
                const cols = line.split(',');
                const key = cols[0]?.trim();
                const val = cols[1]?.trim();
                if (key === 'Year') reportContext.year = val || '';
                if (key === 'Month') reportContext.month = val || '';
              }
            }

            // Try to get week from filename (e.g. "week 02")
            const weekMatch = asset.filename?.match(/week\s*(\d+)/i);
            if (weekMatch) reportContext.week = weekMatch[1];

            if (!sheets['Product analysis'] && !sheets['Source Qview']) {
              parseError = 'Key sheets not found. Available: ' + workbook.SheetNames.join(', ');
            }
          } catch (xlsErr: any) {
            parseError = `Parse error: ${xlsErr.message}`;
          }
        }
      }
    } catch (err: any) {
      parseError = `Fetch error: ${err.message}`;
    }

    // 4. Fetch known products
    const products = await supabaseGet('products?select=id,name&order=name');

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          date: reviewDate,
          asset_id: asset.id,
          file_name: asset.filename,
          report_context: reportContext,
          sheets: {
            product_analysis: sheets['Product analysis'] || null,
            source_qview: sheets['Source Qview'] || null,
            segment_analysis: sheets['Segment analysis'] || null,
            weekly_tracker: sheets['Source Weekly Tracker'] || null,
            source_tilia: sheets['Source Tilia'] || null,
          },
          parse_error: parseError || undefined,
          system_prompt: prompt?.system_prompt || null,
          user_prompt_template: prompt?.user_prompt_template || null,
          known_products: products?.map((p: any) => ({ id: p.id, name: p.name })) || [],
        }, null, 2),
      }],
    };
  }
);

server.tool(
  'bookings_report_write',
  'Write the structured results of a bookings report analysis back to the database. Call this after processing bookings_report_extract data.',
  {
    date: z.string().describe('Report date in YYYY-MM-DD format'),
    period: z.string().describe('Report period string, e.g. "2026-W02"'),
    asset_id: z.string().optional().describe('UUID of the source bookings report asset'),
    review_data: z.object({
      summary: z.string().optional().default(''),
      period_label: z.string().describe('Human-readable period, e.g. "Week 2, January 2026"'),
      products: z.record(z.string(), z.object({
        name: z.string(),
        ytd_bookings: z.object({
          y2024: z.number().optional(),
          y2025: z.number().optional(),
          y2026: z.number(),
          growth_dollar: z.number(),
          growth_pct: z.number().nullable(),
        }),
        by_type: z.object({
          license: z.number().optional().default(0),
          services: z.number().optional().default(0),
        }).optional(),
        by_country: z.array(z.object({
          country: z.string(),
          value: z.number(),
        })).optional().default([]),
      })).describe('Product bookings data keyed by product code'),
      weekly_tracker: z.array(z.object({
        week: z.number(),
        europe: z.number().optional().default(0),
        na: z.number().optional().default(0),
        latam: z.number().optional().default(0),
        apac: z.number().optional().default(0),
        total: z.number(),
      })).optional().default([]),
      segments: z.array(z.object({
        name: z.string(),
        y2026: z.number(),
        py: z.number().optional(),
        growth_pct: z.number().nullable().optional(),
      })).optional().default([]),
    }).describe('Structured bookings report analysis'),
  },
  async ({ date, period, asset_id, review_data }) => {
    // 1. Fetch product entity map
    const products = await supabaseGet('products?select=id,name&order=name');
    const productMap: Record<string, string> = {};
    products.forEach((p: any) => { productMap[p.name.toLowerCase()] = p.id; });

    const sourceRef = { bookings_report_date: date, period, asset_id };
    const results = { product_evidence: 0 };

    // 2. Build markdown body
    const fmtK = (v: number) => {
      if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(1)}m`;
      return `${Math.round(v)}`;
    };
    const fmtPct = (v: number | null) => v != null ? `${(v * 100).toFixed(1)}%` : 'N/A';

    let body = `# Bookings Report — ${review_data.period_label}\n\n`;
    if (review_data.summary) body += `${review_data.summary}\n\n`;

    for (const [code, prod] of Object.entries(review_data.products)) {
      const b = prod.ytd_bookings;
      body += `## ${prod.name} (${code})\n\n`;
      body += `| Year | YTD Bookings ($k) | Growth $ | Growth % |\n|---|---:|---:|---:|\n`;
      if (b.y2024) body += `| 2024 | ${fmtK(b.y2024)} | — | — |\n`;
      if (b.y2025) body += `| 2025 | ${fmtK(b.y2025)} | — | — |\n`;
      body += `| **2026** | **${fmtK(b.y2026)}** | **${b.growth_dollar >= 0 ? '+' : ''}${fmtK(b.growth_dollar)}** | **${fmtPct(b.growth_pct)}** |\n\n`;

      if (prod.by_type && (prod.by_type.license || prod.by_type.services)) {
        body += `**Booking type**: License $${fmtK(prod.by_type.license)}k | Services $${fmtK(prod.by_type.services)}k\n\n`;
      }

      if (prod.by_country.length) {
        body += `### Top Countries\n`;
        body += `| Country | Bookings ($k) |\n|---|---:|\n`;
        const sorted = [...prod.by_country].sort((a, b) => b.value - a.value).slice(0, 10);
        for (const c of sorted) {
          body += `| ${c.country} | ${fmtK(c.value)} |\n`;
        }
        body += '\n';
      }
    }

    if (review_data.segments.length) {
      body += `## Bookings by Segment\n`;
      body += `| Segment | 2026 YTD ($k) | Prior Year | Growth % |\n|---|---:|---:|---:|\n`;
      const sorted = [...review_data.segments].sort((a, b) => b.y2026 - a.y2026);
      for (const s of sorted.slice(0, 15)) {
        body += `| ${s.name} | ${fmtK(s.y2026)} | ${s.py != null ? fmtK(s.py) : '—'} | ${fmtPct(s.growth_pct ?? null)} |\n`;
      }
      body += '\n';
    }

    if (asset_id) body += `\n---\n*Source file: asset ${asset_id}*\n`;

    // 3. Create/update content record
    const existing = await supabaseGet(`content?type=eq.summary&tags=cs.{bookings-report}&metadata->>period=eq.${period}&limit=1`);

    const metadata = {
      report_type: 'bookings-report',
      period,
      period_label: review_data.period_label,
      products: review_data.products,
      weekly_tracker: review_data.weekly_tracker,
      segments: review_data.segments,
      asset_id,
    };

    let contentId: string;
    if (existing.length) {
      contentId = existing[0].id;
      await supabasePatch(`content?id=eq.${contentId}`, {
        body,
        metadata,
        status: 'reviewed',
      });
    } else {
      const created = await supabasePost('content', {
        type: 'summary',
        title: `Bookings Report — ${review_data.period_label}`,
        body,
        tags: ['bookings-report', period],
        status: 'reviewed',
        metadata,
      }, true);
      contentId = created.data?.[0]?.id || 'unknown';
    }

    // 4. Write product evidence
    for (const [code, prod] of Object.entries(review_data.products)) {
      const productId = productMap[prod.name.toLowerCase()];
      if (!productId) continue;

      const b = prod.ytd_bookings;
      await supabasePost('product_evidence', {
        product_id: productId,
        note_date: date,
        evidence: `${review_data.period_label} bookings: $${fmtK(b.y2026)}k YTD (${fmtPct(b.growth_pct)} YoY). License: $${fmtK(prod.by_type?.license || 0)}k, Services: $${fmtK(prod.by_type?.services || 0)}k.`,
        evidence_type: 'bookings_report',
        source_ref: sourceRef,
      });
      results.product_evidence++;
    }

    // 5. Audit record
    await supabasePost('ai_reviews', {
      review_type: 'bookings_report',
      source_date: date,
      status: 'completed',
      output_summary: review_data.summary || `Bookings report for ${review_data.period_label}`,
      files_updated: { content_id: contentId, asset_id, period, ...results },
      completed_at: new Date().toISOString(),
    });

    // 6. Embed
    if (contentId && contentId !== 'unknown') {
      embedItem('content', contentId).catch(() => {});
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          ok: true,
          content_id: contentId,
          asset_id,
          period,
          writes: results,
          action: existing.length ? 'updated' : 'created',
        }, null, 2),
      }],
    };
  }
);

// ─── WCR Pack Opportunities Tools (Extract / Write) ──────────

// Parse "USD 18.499,26" (European format) → 18499.26. "-" or "" → null.
function parseEuroUsd(v: any): number | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s === '-') return null;
  const clean = s.replace(/^USD\s*/, '').replace(/\./g, '').replace(/,/g, '.').trim();
  const n = parseFloat(clean);
  return isNaN(n) ? null : n;
}

// Normalise an Excel cell that may already be a JS Date, an Excel serial number,
// or a string to a YYYY-MM-DD string (or null).
function toIsoDate(v: any): string | null {
  if (v == null || v === '' || v === '-') return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') {
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const eu = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (eu) return `${eu[3]}-${eu[2].padStart(2, '0')}-${eu[1].padStart(2, '0')}`;
  return null;
}

interface WcrPackOpportunity {
  opportunity_id: string | null;
  opportunity_name: string | null;
  account_name: string | null;
  regional_division: string | null;
  region: string | null;
  opportunity_owner: string | null;
  software: string | null;
  main_products: string[];
  amount_usd: number | null;
  amount_software_usd: number | null;
  stage: string | null;
  close_date: string | null;
  close_reason: string | null;
  close_reason_detail: string | null;
  close_comment: string | null;
  next_action: string | null;
  created_date: string | null;
  marketing_generated: boolean | null;
}

interface ParsedWcrPackXlsx {
  opportunities: WcrPackOpportunity[];
  grandTotalParsed: number;
  grandTotalPrinted: number | null;
  runAt: string | null;
  parseError: string;
}

// Shared parser: fetch an asset from R2, parse the Salesforce WCR Pack XLSX,
// and return structured rows plus the grand-total validation numbers.
// Used by both wcr_pack_opps_extract (for AI context) and wcr_pack_opps_write
// (to re-derive rows server-side rather than round-tripping them through the AI).
async function parseWcrPackXlsx(assetId: string): Promise<ParsedWcrPackXlsx> {
  const apiUrl = _misApiUrl || process.env.PAULLAND_API_URL || 'https://paulland.io/api';
  const internalApiKey = _misInternalApiKey || process.env.PAULLAND_INTERNAL_API_KEY;
  const headers: Record<string, string> = {};
  if (internalApiKey) headers['X-Internal-API-Key'] = internalApiKey;

  const opportunities: WcrPackOpportunity[] = [];
  let grandTotalPrinted: number | null = null;
  let grandTotalParsed = 0;
  let runAt: string | null = null;
  let parseError = '';

  try {
    const resp = await fetch(`${apiUrl}/assets/${assetId}/content`, { headers });
    if (!resp.ok) return { opportunities, grandTotalParsed, grandTotalPrinted, runAt, parseError: `Failed to fetch file: ${resp.status}` };
    const fileData = await resp.json();
    if (fileData.encoding !== 'base64') return { opportunities, grandTotalParsed, grandTotalPrinted, runAt, parseError: 'Expected base64-encoded XLSX' };

    const binary = Uint8Array.from(atob(fileData.content), c => c.charCodeAt(0));
    const workbook = XLSX.read(binary, { type: 'array', cellDates: true });
    const ws = workbook.Sheets[workbook.SheetNames[0]];
    if (!ws) return { opportunities, grandTotalParsed, grandTotalPrinted, runAt, parseError: 'No sheets in workbook' };

    const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, blankrows: true });

    let headerIdx = -1;
    for (let i = 0; i < rows.length; i++) {
      const v0 = rows[i]?.[0];
      if (v0 && String(v0).trim().startsWith('Account Regional')) {
        headerIdx = i;
        break;
      }
      if (v0 && String(v0).startsWith('Run at:')) {
        const m = String(v0).match(/(\d{1,2}\/\d{1,2}\/\d{4})/);
        if (m) runAt = toIsoDate(m[1]);
      }
    }
    if (headerIdx < 0) return { opportunities, grandTotalParsed, grandTotalPrinted, runAt, parseError: 'Could not locate header row ("Account Regional Division")' };

    const parseGroupCloseDate = (label: string): string | null => {
      const m = label.match(/Close Date:\s*([A-Za-z]+)\s+(?:FY\s*)?(\d{4})/);
      if (!m) return null;
      const monthNames = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec',
        'january','february','march','april','june','july','august','september','october','november','december'];
      const monIdx = monthNames.indexOf(m[1].toLowerCase()) % 12;
      const year = parseInt(m[2]);
      if (monIdx < 0 || year < 2000) return null;
      const last = new Date(Date.UTC(year, monIdx + 1, 0));
      return last.toISOString().slice(0, 10);
    };
    const cleanDash = (v: any): string | null => {
      if (v == null) return null;
      const s = String(v).trim();
      return (!s || s === '-') ? null : s;
    };

    let currentGroupCloseDate: string | null = null;

    for (let i = headerIdx + 1; i < rows.length; i++) {
      const r = rows[i] || [];
      const c0 = r[0] == null ? '' : String(r[0]).trim();

      if (c0.startsWith('Close Date:')) {
        currentGroupCloseDate = parseGroupCloseDate(c0);
        continue;
      }
      if (c0.startsWith('Grand Totals')) {
        const raw = r[7] ?? rows[i + 1]?.[7];
        grandTotalPrinted = parseEuroUsd(raw);
        continue;
      }
      if (!c0) continue;
      if (r[4] == null || String(r[4]).trim() === '') continue;

      const software = r[5] == null ? '' : String(r[5]);
      const amountUsd = parseEuroUsd(r[6]);
      const amountSoftwareUsd = parseEuroUsd(r[7]);
      if (amountSoftwareUsd != null) grandTotalParsed += amountSoftwareUsd;

      opportunities.push({
        opportunity_id: cleanDash(r[4]),
        opportunity_name: cleanDash(r[4]),
        account_name: cleanDash(r[3]),
        regional_division: cleanDash(r[0]),
        region: cleanDash(r[1]),
        opportunity_owner: cleanDash(r[2]),
        software: cleanDash(r[5]),
        main_products: software ? software.split(/[;,]/).map(s => s.trim()).filter(Boolean) : [],
        amount_usd: amountUsd,
        amount_software_usd: amountSoftwareUsd,
        stage: cleanDash(r[10]),
        close_date: currentGroupCloseDate,
        close_reason: cleanDash(r[11]),
        close_reason_detail: cleanDash(r[12]),
        close_comment: cleanDash(r[13]),
        next_action: cleanDash(r[8]),
        created_date: toIsoDate(r[9]),
        marketing_generated: r[14] == null ? null : String(r[14]).trim() === '1',
      });
    }
  } catch (err: any) {
    parseError = `XLSX parse error: ${err.message}`;
  }

  return { opportunities, grandTotalParsed, grandTotalPrinted, runAt, parseError };
}

// Server-side aggregation helper: given parsed opportunities, compute the metrics
// and slices Claude needs for the weekly summary, plus the numeric slices the
// admin dashboard renders (by_owner, cycle_length_days, bundle_analysis,
// by_stage_value). Keeps Claude's job to thematic analysis (close-comment
// clustering), not number-crunching on 257 rows — and keeps the admin view fast.
function aggregateWcrPackMetrics(ops: WcrPackOpportunity[]) {
  const isClosedWon = (s: string | null) => s === 'Closed Won';
  const isClosedLost = (s: string | null) => s === 'Closed Lost';
  const isLive = (s: string | null) => !!s && !isClosedWon(s) && !isClosedLost(s);

  const tally = (arr: WcrPackOpportunity[]) => ({
    count: arr.length,
    value_usd: arr.reduce((t, o) => t + (o.amount_software_usd || 0), 0),
  });

  const won = tally(ops.filter(o => isClosedWon(o.stage)));
  const lost = tally(ops.filter(o => isClosedLost(o.stage)));
  const live = tally(ops.filter(o => isLive(o.stage)));

  const byStage: Record<string, number> = {};
  const byStageValue: Record<string, number> = {};
  const byRegion: Record<string, number> = {};
  const byCloseReasonDetail: Record<string, number> = {};
  for (const o of ops) {
    if (o.stage) {
      byStage[o.stage] = (byStage[o.stage] || 0) + 1;
      byStageValue[o.stage] = Math.round(((byStageValue[o.stage] || 0) + (o.amount_software_usd || 0)) * 100) / 100;
    }
    if (o.region) byRegion[o.region] = (byRegion[o.region] || 0) + 1;
    if (isClosedLost(o.stage) && o.close_reason_detail) {
      byCloseReasonDetail[o.close_reason_detail] = (byCloseReasonDetail[o.close_reason_detail] || 0) + 1;
    }
  }

  // MGO effectiveness split — two parallel buckets with win/lost/reason breakdown
  const mgoBucket = (filter: (o: WcrPackOpportunity) => boolean) => {
    const subset = ops.filter(filter);
    const w = subset.filter(o => isClosedWon(o.stage)).length;
    const l = subset.filter(o => isClosedLost(o.stage)).length;
    const closed = w + l;
    const lostByReason: Record<string, number> = {};
    subset.filter(o => isClosedLost(o.stage) && o.close_reason_detail).forEach(o => {
      lostByReason[o.close_reason_detail!] = (lostByReason[o.close_reason_detail!] || 0) + 1;
    });
    return {
      total: subset.length,
      closed_won: w,
      closed_lost: l,
      win_rate: closed > 0 ? Math.round((w / closed) * 1000) / 1000 : null,
      lost_by_reason_detail: lostByReason,
    };
  };

  // Per-rep rollup for the "Opps by rep" chart
  const byOwner: Record<string, { total: number; won: number; lost: number; live: number; value_usd: number; win_rate: number | null }> = {};
  for (const o of ops) {
    if (!o.opportunity_owner) continue;
    if (!byOwner[o.opportunity_owner]) {
      byOwner[o.opportunity_owner] = { total: 0, won: 0, lost: 0, live: 0, value_usd: 0, win_rate: null };
    }
    const b = byOwner[o.opportunity_owner];
    b.total++;
    if (isClosedWon(o.stage)) b.won++;
    else if (isClosedLost(o.stage)) b.lost++;
    else if (isLive(o.stage)) b.live++;
    b.value_usd = Math.round((b.value_usd + (o.amount_software_usd || 0)) * 100) / 100;
  }
  for (const owner of Object.keys(byOwner)) {
    const b = byOwner[owner];
    const closed = b.won + b.lost;
    b.win_rate = closed > 0 ? Math.round((b.won / closed) * 1000) / 1000 : null;
  }

  // Cycle length: days from created_date to close_date. close_date is the last
  // day of the close-date group-header month, so absolute days are fuzzy by up
  // to ~30 days — but directionally fine for medians and relative comparison.
  const median = (nums: number[]): number | null => {
    if (!nums.length) return null;
    const sorted = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  };
  const daysBetween = (from: string | null, to: string | null): number | null => {
    if (!from || !to) return null;
    const a = new Date(from).getTime();
    const b = new Date(to).getTime();
    if (isNaN(a) || isNaN(b) || b < a) return null;
    return Math.round((b - a) / (1000 * 60 * 60 * 24));
  };
  const wonCycles: number[] = [];
  const lostCycles: number[] = [];
  for (const o of ops) {
    const d = daysBetween(o.created_date, o.close_date);
    if (d == null) continue;
    if (isClosedWon(o.stage)) wonCycles.push(d);
    else if (isClosedLost(o.stage)) lostCycles.push(d);
  }

  // Bundle analysis: a deal is "solo" if WCR Pack is the only named product
  // (or the software column is empty). "Bundled" if WCR Pack ships alongside
  // other products in the same opp. Surfaces the top co-products — which
  // other products WCR Pack most often travels with.
  const isWcrPack = (name: string) => /webcenter\s*pack/i.test(name);
  // Filter junk entries: single-char punctuation like "-" sometimes leaks in
  // when the Software column itself is empty but a previous row's split left
  // a stray dash. Keep only alpha-containing names.
  const isRealProduct = (name: string) => /[a-z]/i.test(name);
  const classifyBundle = (o: WcrPackOpportunity): 'solo' | 'bundled' | 'unknown' => {
    const products = (o.main_products || []).filter(isRealProduct);
    if (products.length === 0) return 'unknown';
    const nonWcr = products.filter(p => !isWcrPack(p));
    return nonWcr.length === 0 ? 'solo' : 'bundled';
  };
  const bundleBucket = (filter: (o: WcrPackOpportunity) => boolean) => {
    const subset = ops.filter(filter);
    const w = subset.filter(o => isClosedWon(o.stage)).length;
    const l = subset.filter(o => isClosedLost(o.stage)).length;
    const closed = w + l;
    const cycles: number[] = [];
    for (const o of subset) {
      const d = daysBetween(o.created_date, o.close_date);
      if (d != null && (isClosedWon(o.stage) || isClosedLost(o.stage))) cycles.push(d);
    }
    return {
      count: subset.length,
      value_usd: Math.round(subset.reduce((t, o) => t + (o.amount_software_usd || 0), 0) * 100) / 100,
      won: w,
      lost: l,
      win_rate: closed > 0 ? Math.round((w / closed) * 1000) / 1000 : null,
      median_cycle_days: median(cycles),
    };
  };
  // Count frequencies of the non-WCR products in bundled deals
  const coProductCounts: Record<string, number> = {};
  for (const o of ops) {
    if (classifyBundle(o) !== 'bundled') continue;
    for (const p of o.main_products || []) {
      if (isWcrPack(p) || !isRealProduct(p)) continue;
      coProductCounts[p] = (coProductCounts[p] || 0) + 1;
    }
  }
  const topCoProducts = Object.entries(coProductCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, count]) => ({ name, count }));

  return {
    total_records: ops.length,
    total_value_usd: Math.round(ops.reduce((t, o) => t + (o.amount_software_usd || 0), 0) * 100) / 100,
    closed_won_count: won.count,
    closed_won_value_usd: Math.round(won.value_usd * 100) / 100,
    closed_lost_count: lost.count,
    closed_lost_value_usd: Math.round(lost.value_usd * 100) / 100,
    live_pipeline_count: live.count,
    live_pipeline_value_usd: Math.round(live.value_usd * 100) / 100,
    win_rate: (won.count + lost.count) > 0
      ? Math.round((won.count / (won.count + lost.count)) * 1000) / 1000
      : null,
    by_stage: byStage,
    by_stage_value: byStageValue,
    by_region: byRegion,
    by_owner: byOwner,
    by_close_reason_detail: byCloseReasonDetail,
    cycle_length_days: {
      won_median: median(wonCycles),
      lost_median: median(lostCycles),
      overall_median: median([...wonCycles, ...lostCycles]),
      won_count_measurable: wonCycles.length,
      lost_count_measurable: lostCycles.length,
    },
    bundle_analysis: {
      solo: bundleBucket(o => classifyBundle(o) === 'solo'),
      bundled: bundleBucket(o => classifyBundle(o) === 'bundled'),
      unknown: bundleBucket(o => classifyBundle(o) === 'unknown'),
      top_co_products: topCoProducts,
    },
    mgo_effectiveness: {
      marketing_generated: mgoBucket(o => o.marketing_generated === true),
      sales_generated: mgoBucket(o => o.marketing_generated === false),
    },
  };
}

server.tool(
  'wcr_pack_opps_extract',
  'Parse the weekly WCR Pack opportunities XLSX (Salesforce export) and return server-computed metrics plus closed-lost detail, open-pipeline summary, prior snapshots, existing signals, known competitors, and the analysis prompt. Aggregations are pre-computed server-side — Claude focuses on thematic clustering, not row counting. Claude then calls wcr_pack_opps_write which re-parses the same asset; the opportunity rows are NOT round-tripped through the AI.',
  {
    asset_id: z.string().optional().describe('UUID of the uploaded WCR Pack opps XLSX asset. If omitted, uses the most recent asset tagged "wcr-pack-opps".'),
    report_date: z.string().optional().describe('Report date in YYYY-MM-DD format. Defaults to today.'),
  },
  async ({ asset_id, report_date }) => {
    const reportDate = report_date || new Date().toISOString().split('T')[0];

    // 1. Find the asset
    let asset: any;
    if (asset_id) {
      const rows = await supabaseGet(`assets?id=eq.${asset_id}&select=id,filename,mime_type,r2_key,tags`);
      asset = rows?.[0];
    } else {
      const rows = await supabaseGet('assets?tags=cs.{wcr-pack-opps}&order=uploaded_at.desc&limit=1&select=id,filename,mime_type,r2_key,tags');
      asset = rows?.[0];
    }
    if (!asset) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'No WCR Pack opps asset found. Upload the weekly Salesforce XLSX and tag it "wcr-pack-opps".' }) }] };
    }

    // 2. Parse XLSX via shared helper
    const { opportunities, grandTotalParsed, grandTotalPrinted, runAt, parseError } = await parseWcrPackXlsx(asset.id);

    // 3. Pre-compute metrics server-side so the AI doesn't have to count rows
    const metrics = aggregateWcrPackMetrics(opportunities);

    // 4. Fetch prompt + prior snapshots + existing signals + competitors in parallel
    const [prompts, priorSnapshots, existingSignals, competitors] = await Promise.all([
      supabaseGet('prompts?slug=eq.wcr-pack-opps-report&select=system_prompt,user_prompt_template'),
      supabaseGet(`wcr_pack_opportunities?report_date=lt.${reportDate}&order=report_date.desc&limit=2000&select=report_date,opportunity_id,stage,amount_software_usd,close_date,close_reason_detail`),
      supabaseGet(`content?type=eq.signal&metadata->>product_area=eq.${encodeURIComponent('WCR Pack')}&status=neq.archived&select=id,title,metadata&order=created_at.desc&limit=100`),
      supabaseGet('companies?type=eq.competitor&select=id,name&order=name'),
    ]);
    const prompt = prompts?.[0];

    // Group prior snapshots by report_date → keep last 4
    const byDate: Record<string, any[]> = {};
    for (const row of priorSnapshots || []) {
      if (!byDate[row.report_date]) byDate[row.report_date] = [];
      byDate[row.report_date].push(row);
    }
    const lastDates = Object.keys(byDate).sort().reverse().slice(0, 4);

    // 5. Compute week-over-week deltas vs most-recent prior snapshot
    let weeklyDeltas: any = null;
    if (lastDates.length > 0) {
      const prev = byDate[lastDates[0]];
      const prevById = new Map<string, any>(prev.map(p => [p.opportunity_id, p]));
      const currentIds = new Set(opportunities.map(o => o.opportunity_id).filter(Boolean) as string[]);
      const prevIds = new Set(prev.map(p => p.opportunity_id));

      weeklyDeltas = {
        prior_report_date: lastDates[0],
        newly_created_count: [...currentIds].filter(id => !prevIds.has(id)).length,
        newly_won: opportunities
          .filter(o => o.stage === 'Closed Won' && o.opportunity_id && prevById.get(o.opportunity_id)?.stage !== 'Closed Won')
          .map(o => ({ opportunity_id: o.opportunity_id, account_name: o.account_name, value_usd: o.amount_software_usd })),
        newly_lost: opportunities
          .filter(o => o.stage === 'Closed Lost' && o.opportunity_id && prevById.get(o.opportunity_id)?.stage !== 'Closed Lost')
          .map(o => ({ opportunity_id: o.opportunity_id, account_name: o.account_name, close_reason_detail: o.close_reason_detail })),
        pipeline_value_delta_usd: Math.round((metrics.live_pipeline_value_usd - prev.filter(p => !['Closed Won', 'Closed Lost'].includes(p.stage)).reduce((t, p) => t + (p.amount_software_usd || 0), 0)) * 100) / 100,
      };
    }

    // 6. Stalled deals — opps in the same stage across all available prior snapshots (last 4)
    const stalledDeals: any[] = [];
    if (lastDates.length >= 2) {
      for (const o of opportunities) {
        if (!o.opportunity_id || o.stage === 'Closed Won' || o.stage === 'Closed Lost') continue;
        const stagesPerSnapshot = lastDates.map(d => byDate[d].find(p => p.opportunity_id === o.opportunity_id)?.stage).filter(Boolean);
        if (stagesPerSnapshot.length >= Math.min(2, lastDates.length) && stagesPerSnapshot.every(s => s === o.stage)) {
          stalledDeals.push({
            opportunity_id: o.opportunity_id,
            account_name: o.account_name,
            stage: o.stage,
            value_usd: o.amount_software_usd,
            snapshots_in_stage: stagesPerSnapshot.length + 1,
          });
        }
      }
    }

    // 7. Trim payload: only send CLOSED-LOST rows in full detail (theme clustering needs close_comments);
    // send open pipeline + won as brief for context/drill-down. This is the big token saving.
    const closedLostDetail = opportunities
      .filter(o => o.stage === 'Closed Lost')
      .map(o => ({
        opportunity_id: o.opportunity_id,
        account_name: o.account_name,
        regional_division: o.regional_division,
        region: o.region,
        opportunity_owner: o.opportunity_owner,
        value_usd: o.amount_software_usd,
        close_date: o.close_date,
        close_reason: o.close_reason,
        close_reason_detail: o.close_reason_detail,
        close_comment: o.close_comment,
        marketing_generated: o.marketing_generated,
      }));

    const openPipelineBrief = opportunities
      .filter(o => o.stage !== 'Closed Lost' && o.stage !== 'Closed Won')
      .map(o => ({
        opportunity_id: o.opportunity_id,
        account_name: o.account_name,
        region: o.region,
        stage: o.stage,
        value_usd: o.amount_software_usd,
        close_date: o.close_date,
        marketing_generated: o.marketing_generated,
      }));

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          report_date: reportDate,
          asset_id: asset.id,
          file_name: asset.filename,
          run_at: runAt,
          validation: {
            row_count: opportunities.length,
            grand_total_parsed: Math.round(grandTotalParsed * 100) / 100,
            grand_total_printed: grandTotalPrinted,
            discrepancy: grandTotalPrinted != null
              ? Math.round(Math.abs(grandTotalParsed - grandTotalPrinted) * 100) / 100
              : null,
          },
          metrics,
          weekly_deltas: weeklyDeltas,
          stalled_deals: stalledDeals,
          closed_lost_detail: closedLostDetail,
          open_pipeline_brief: openPipelineBrief,
          prior_snapshot_dates: lastDates,
          existing_signals: (existingSignals || []).map((s: any) => ({
            id: s.id,
            title: s.title,
            theme_slug: s.metadata?.theme_slug || null,
            occurrence_count: s.metadata?.occurrence_count || 0,
            first_seen_report: s.metadata?.first_seen_report || null,
            last_seen_report: s.metadata?.last_seen_report || null,
          })),
          known_competitors: (competitors || []).map((c: any) => ({ id: c.id, name: c.name })),
          parse_error: parseError || undefined,
          system_prompt: prompt?.system_prompt || null,
          user_prompt_template: prompt?.user_prompt_template || null,
        }, null, 2),
      }],
    };
  }
);

server.tool(
  'wcr_pack_opps_write',
  'Persist the weekly WCR Pack snapshot. Re-parses the XLSX from asset_id server-side (rows are NOT passed through the AI), bulk-inserts all opportunity rows in one call, upserts the weekly summary, deduplicates signals by id (preferred) or theme_slug, links signals to summary, and upserts competitors by id (preferred) or name. Idempotent by report_date.',
  {
    report_date: z.string().describe('Report date in YYYY-MM-DD format'),
    asset_id: z.string().describe('UUID of the source XLSX asset (required — the write tool re-parses it server-side)'),
    period_label: z.string().describe('Human-readable label, e.g. "17 April 2026"'),
    summary: z.object({
      title: z.string().describe('Weekly summary title, e.g. "WCR Pack pipeline — 17 April 2026"'),
      body: z.string().describe('Markdown body — pipeline snapshot, themes, competitors, stalled list, velocity, MGO, top actionable findings'),
    }).describe('Summary content. Metrics are computed server-side from the XLSX and attached automatically — do not send them.'),
    signals: z.array(z.object({
      id: z.string().optional().describe('Existing signal UUID (from extract\'s existing_signals). If provided, the tool skips the theme_slug lookup and PATCHes this signal directly — saves a subrequest.'),
      theme_slug: z.string().describe('Stable kebab-case slug, WCR-prefixed (e.g. "wcr-sna-parity-gap"). Used for dedup when id not provided.'),
      title: z.string(),
      description: z.string().describe('One-line description of the theme'),
      evidence_block: z.string().describe('Markdown evidence block appended to the signal body — deals/quotes observed in this report'),
      severity: z.enum(['high', 'medium', 'low']).optional().default('medium'),
    })).optional().default([]),
    competitors: z.array(z.object({
      id: z.string().optional().describe('Existing company UUID (from extract\'s known_competitors). If provided, skips the name lookup — saves a subrequest.'),
      name: z.string().describe('Competitor name (e.g. "Hybrid", "Kodak Insight")'),
      lost_deal_count: z.number().optional().default(0),
      notes: z.string().optional(),
    })).optional().default([]),
  },
  async ({ report_date, asset_id, period_label, summary, signals, competitors }) => {
    const results = {
      opportunities_inserted: 0,
      opportunities_replaced: 0,
      signals_created: 0,
      signals_updated: 0,
      competitors_upserted: 0,
      links_created: 0,
    };

    // 1. Re-parse the XLSX — rows are NOT round-tripped through the AI
    const parsed = await parseWcrPackXlsx(asset_id);
    if (parsed.parseError) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: parsed.parseError }) }] };
    }
    const opportunities = parsed.opportunities;
    const metrics = aggregateWcrPackMetrics(opportunities);

    // 2. Idempotent: delete existing snapshot for this report_date before re-insert
    const existingOppRows = await supabaseGet(`wcr_pack_opportunities?report_date=eq.${report_date}&select=id`);
    if (existingOppRows && existingOppRows.length > 0) {
      await supabaseDelete(`wcr_pack_opportunities?report_date=eq.${report_date}`);
      results.opportunities_replaced = existingOppRows.length;
    }

    // 3. Bulk insert — ALL rows in one POST (was 6 batches of 50)
    if (opportunities.length > 0) {
      const payload = opportunities.map(o => ({
        report_date,
        opportunity_id: o.opportunity_id,
        opportunity_name: o.opportunity_name,
        account_name: o.account_name,
        regional_division: o.regional_division,
        region: o.region,
        opportunity_owner: o.opportunity_owner,
        software: o.software,
        main_products: o.main_products,
        amount_usd: o.amount_usd,
        amount_software_usd: o.amount_software_usd,
        stage: o.stage,
        close_date: o.close_date,
        close_reason: o.close_reason,
        close_reason_detail: o.close_reason_detail,
        close_comment: o.close_comment,
        next_action: o.next_action,
        created_date: o.created_date,
        marketing_generated: o.marketing_generated,
        source_file: asset_id,
      }));
      const res = await supabasePost('wcr_pack_opportunities', payload);
      if (res.ok) results.opportunities_inserted = payload.length;
    }

    // 4. Create or update the weekly summary content item
    const summaryMetadata = {
      report_type: 'wcr-pack-opps',
      report_date,
      period_label,
      asset_id,
      metrics,
      validation: {
        row_count: opportunities.length,
        grand_total_parsed: Math.round(parsed.grandTotalParsed * 100) / 100,
        grand_total_printed: parsed.grandTotalPrinted,
      },
    };

    const existingSummary = await supabaseGet(
      `content?type=eq.summary&tags=cs.{wcr-pack-opps}&metadata->>report_date=eq.${report_date}&limit=1&select=id`
    );

    let summaryId: string;
    if (existingSummary && existingSummary.length > 0) {
      summaryId = existingSummary[0].id;
      await supabasePatch(`content?id=eq.${summaryId}`, {
        title: summary.title,
        body: summary.body,
        tags: ['wcr-pack-opps', 'pipeline', report_date],
        status: 'reviewed',
        metadata: summaryMetadata,
      });
    } else {
      const created = await supabasePost('content', {
        type: 'summary',
        title: summary.title,
        body: summary.body,
        tags: ['wcr-pack-opps', 'pipeline', report_date],
        status: 'reviewed',
        metadata: summaryMetadata,
      }, true);
      summaryId = created.data?.[0]?.id || '';
    }

    // 5. Signals — use id if AI provided one (from existing_signals), else theme_slug lookup.
    // Skip per-signal embedding; the batch_embed cron will pick them up.
    for (const sig of signals) {
      const evidenceEntry = `\n\n### ${report_date} — ${period_label}\n\n${sig.evidence_block}\n`;
      let existingId = sig.id;
      let existingBody = '';
      let existingMeta: any = {};

      if (existingId) {
        const rows = await supabaseGet(`content?id=eq.${existingId}&select=id,body,metadata`);
        if (rows && rows.length > 0) {
          existingBody = rows[0].body || '';
          existingMeta = rows[0].metadata || {};
        } else {
          existingId = undefined; // stale id; fall through to create
        }
      } else {
        // Honour user-archived signals: skip them so we don't silently un-archive.
        // If the AI re-invents an archived slug, treat it as "no match" and create
        // a new signal (user can re-archive if they want).
        const rows = await supabaseGet(
          `content?type=eq.signal&metadata->>theme_slug=eq.${encodeURIComponent(sig.theme_slug)}&status=neq.archived&limit=1&select=id,body,metadata`
        );
        if (rows && rows.length > 0) {
          existingId = rows[0].id;
          existingBody = rows[0].body || '';
          existingMeta = rows[0].metadata || {};
        }
      }

      if (existingId) {
        // Don't force status='active' — preserves whatever the user set deliberately.
        await supabasePatch(`content?id=eq.${existingId}`, {
          body: `${evidenceEntry}\n---\n${existingBody}`,
          metadata: {
            ...existingMeta,
            last_seen_report: report_date,
            occurrence_count: (existingMeta.occurrence_count || 1) + 1,
            severity: sig.severity,
          },
        });
        results.signals_updated++;
      } else {
        const created = await supabasePost('content', {
          type: 'signal',
          title: sig.title,
          body: `${sig.description}\n${evidenceEntry}`,
          tags: ['wcr-pack-opps', 'signal', sig.theme_slug],
          status: 'active',
          metadata: {
            theme_slug: sig.theme_slug,
            product_area: 'WCR Pack',
            first_seen_report: report_date,
            last_seen_report: report_date,
            occurrence_count: 1,
            severity: sig.severity,
          },
        }, true);
        existingId = created.data?.[0]?.id;
        if (existingId) results.signals_created++;
      }

      if (existingId && summaryId) {
        await supabasePost('content_links', {
          source_id: existingId,
          target_id: summaryId,
          link_type: 'evidence',
          context: `Evidence surfaced in WCR Pack report ${report_date}`,
        });
        results.links_created++;
      }
    }

    // 6. Competitors — id-first lookup, else name match.
    // Name lookup tries exact case-insensitive first, then wildcard partial.
    // The partial fallback is important because the AI often writes a short form
    // (e.g. "Hybrid") while the canonical company name is longer ("Hybrid Software").
    // Note: companies uses a `type` column ('customer' | 'competitor' | 'internal'),
    // NOT a boolean `is_competitor` column — earlier versions of this code assumed
    // the latter and silently failed on every operation (PostgREST 400 on unknown
    // column). Results accumulates any company upsert errors so failures surface.
    const companyErrors: string[] = [];
    for (const comp of competitors) {
      let companyId = comp.id;
      if (!companyId) {
        // Exact case-insensitive match first
        let existingCo = await supabaseGet(
          `companies?name=ilike.${encodeURIComponent(comp.name)}&limit=1&select=id,name,type`
        );
        // Fallback: partial wildcard match — resolves "Hybrid" → "Hybrid Software"
        if (!existingCo || existingCo.length === 0) {
          existingCo = await supabaseGet(
            `companies?name=ilike.*${encodeURIComponent(comp.name)}*&limit=1&select=id,name,type&order=name.asc`
          );
        }
        if (existingCo && existingCo.length > 0) {
          companyId = existingCo[0].id;
          if (existingCo[0].type !== 'competitor') {
            await supabasePatch(`companies?id=eq.${companyId}`, { type: 'competitor' });
          }
        } else {
          const created = await supabasePost('companies', {
            name: comp.name,
            type: 'competitor',
            notes: comp.notes || `Surfaced from WCR Pack closed-lost analysis (${report_date})`,
          }, true);
          if (!created.ok) {
            companyErrors.push(`Create "${comp.name}": ${created.error?.slice(0, 200)}`);
            continue; // skip this competitor, don't increment counter
          }
          companyId = created.data?.[0]?.id || '';
        }
      }
      if (companyId && summaryId) {
        const linkRes = await supabasePost('company_content', {
          company_id: companyId,
          content_id: summaryId,
        });
        if (linkRes.ok) {
          results.competitors_upserted++;
        } else {
          companyErrors.push(`Link "${comp.name}": ${linkRes.error?.slice(0, 200)}`);
        }
      }
    }

    // 7. Audit
    await supabasePost('ai_reviews', {
      review_type: 'wcr_pack_opps',
      source_date: report_date,
      status: 'completed',
      output_summary: `${opportunities.length} opps, ${signals.length} signals, ${competitors.length} competitors`,
      files_updated: { content_id: summaryId, asset_id, ...results },
      completed_at: new Date().toISOString(),
    });

    // 8. Embed the summary only (signals picked up by batch_embed cron)
    if (summaryId) embedItem('content', summaryId).catch(() => {});

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          ok: true,
          report_date,
          content_id: summaryId,
          ...results,
          ...(companyErrors.length ? { company_errors: companyErrors } : {}),
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
      'mis_connections?select=id,name,type,is_active,cluster,ecan,repo_id,server_url,api_version,base_url,created_at&order=created_at.desc'
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
    const connSelect = 'id,name,type,cluster,ecan,repo_id,server_url,api_version,base_url';
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
    const isS2 = connection?.api_version === 's2';

    // Auto-generate job_id (sequential, no customer code to avoid exposing internal IDs)
    const existing = await supabaseGet(
      `mis_jobs?job_id=like.MIS-%25&select=job_id&order=created_at.desc&limit=1`
    );
    let seq = 1;
    if (existing.length && existing[0].job_id) {
      const match = existing[0].job_id.match(/MIS-(\d+)/);
      if (match) seq = parseInt(match[1], 10) + 1;
    }
    const job_id = `MIS-${String(seq).padStart(4, '0')}`;

    // Build payload — different structure for AE vs S2 vs legacy WCP
    let payload: any;
    if (isAe) {
      payload = {
        jobName: job_name,
        jobId: job_id,
        jobPartId: job_part_id || `${job_id}-01`,
        customerCode: customer_code || '',
        description: description || '',
        category: category || 'Production',
        customField1: custom_field_1 || '',
      };
    } else if (isS2) {
      // S2 Create Project payload
      const properties: any = {
        MISId: 'MyMIS',
        jobId: job_id,
        projectName: job_name,
        status: { type: 'ProjectStatus', status: 'Created' },
      };
      if (description) properties.description = description;
      if (job_part_id) properties.jobPartId = job_part_id;
      if (due_date) properties.dueDate = due_date;
      else properties.dueDate = new Date(Date.now() + 7 * 86400000).toISOString();
      if (customer_code) {
        properties.customers = [{ ref: customer_code, type: 'Reference' }];
      }
      payload = { properties };
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

    // For S2: submit directly to S2 API (no draft step needed)
    if (isS2 && connection?.id) {
      const result = await callMisProxy('POST', 'projects', connection.id, payload);
      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Failed to create S2 project: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      // Store job record with S2 project node ID
      const jobRecord = {
        job_id,
        job_name,
        customer_code: customer_code || null,
        customer_name: customer_name || null,
        status: 'Created',
        phase: 'Created',
        due_date: payload.properties?.dueDate || null,
        description: description || null,
        connection_id: connection.id,
        connection_name: connection.name || null,
        solution: 's2',
        cluster: connection.cluster || null,
        payload,
        wcp_response: result.data,
        project_node_id: result.data?.id || null,
      };

      await supabasePost('mis_jobs', jobRecord, true);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            job_id,
            job_name,
            status: 'Created',
            type: 's2',
            project_node_id: result.data?.id || null,
            connection: connection.name || 'none',
            note: 'Project created in S2. Use list_projects or get_project_info to check status. Use launch_workflow to start a workflow.',
          }, null, 2),
        }],
      };
    }

    // Legacy: Insert job record as Draft
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

    // Check for AE-specific errors (AE returns HTTP 200 even when parameters fail)
    if (result.data?.ae_success === false && result.data?.ae_errors?.length) {
      // Save response but mark as Error instead of Created
      await supabasePatch(`mis_jobs?id=eq.${job_id}`, {
        status: 'Error',
        wcp_response: result.data,
      });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            error: 'AE returned workflow parameter errors. The job was not created on Automation Engine.',
            ae_errors: result.data.ae_errors,
            job_id: job.job_id,
            hint: 'Check that the AE workflow public parameter names match what the API sends (Job ID, Name, Customer ID, Job Part ID, Category).',
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
    searchValue: z.string().optional().describe('Search by partnerName or partnerID (wildcard, case-insensitive)'),
  },
  async ({ connection_id, searchValue }) => {
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

    const qs = searchValue ? `?searchValue=${encodeURIComponent(searchValue)}` : '';
    const result = await callMisProxy('GET', `customers${qs}`, conn.id);
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
    searchValue: z.string().optional().describe('Search by template name (wildcard, case-insensitive). S2 connections only.'),
  },
  async ({ connection_id, searchValue }) => {
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

    const qs = searchValue ? `?searchValue=${encodeURIComponent(searchValue)}` : '';
    const result = await callMisProxy('GET', `task-templates${qs}`, conn.id);
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

// ─── S2 MIS API Tools ────────────────────────────────────────

server.tool(
  'list_projects',
  'List projects (jobs) from S2. Returns paginated list with project names, IDs, and modification dates. Requires an S2 connection.',
  {
    connection_id: z.string().optional().describe('MIS connection UUID (uses active connection if omitted)'),
    from: z.number().optional().describe('Zero-based start index for pagination (default: 0)'),
    pageSize: z.number().optional().describe('Max items to return (default: 20)'),
    searchValue: z.string().optional().describe('Search by name, jobID, generalIDs.Project or PrintBuyerReference (wildcard, case-insensitive)'),
  },
  async ({ connection_id, from, pageSize, searchValue }) => {
    const conn = await resolveConnectionId(connection_id);
    if (!conn) return { content: [{ type: 'text' as const, text: 'No MIS connection found.' }], isError: true };

    const params = new URLSearchParams();
    if (from !== undefined) params.set('from', String(from));
    if (pageSize !== undefined) params.set('pageSize', String(pageSize));
    if (searchValue) params.set('searchValue', searchValue);
    const qs = params.toString() ? `?${params.toString()}` : '';

    const result = await callMisProxy('GET', `projects${qs}`, conn.id);
    if (!result.ok) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Failed to list projects (HTTP ${result.status})`, detail: result.data }, null, 2) }], isError: true };
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
  }
);

server.tool(
  'get_project_info',
  'Get full details of a project (job) by its node ID. Works with S2 connections to retrieve project status, attributes, linked products, and assets.',
  {
    project_node_id: z.string().describe('S2 node ID of the project'),
    connection_id: z.string().optional().describe('MIS connection UUID (uses active connection if omitted)'),
  },
  async ({ project_node_id, connection_id }) => {
    const conn = await resolveConnectionId(connection_id);
    if (!conn) return { content: [{ type: 'text' as const, text: 'No MIS connection found.' }], isError: true };

    const result = await callMisProxy('GET', `projects/${project_node_id}`, conn.id);
    if (!result.ok) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Failed to get project (HTTP ${result.status})`, detail: result.data }, null, 2) }], isError: true };
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
  }
);

server.tool(
  'update_project_status',
  'Update the status of a project (e.g. Created → Active). Requires an S2 connection.',
  {
    project_node_id: z.string().describe('S2 node ID of the project'),
    status: z.string().describe('New status value (e.g. "Active", "Created", "Completed")'),
    connection_id: z.string().optional().describe('MIS connection UUID (uses active connection if omitted)'),
  },
  async ({ project_node_id, status, connection_id }) => {
    const conn = await resolveConnectionId(connection_id);
    if (!conn) return { content: [{ type: 'text' as const, text: 'No MIS connection found.' }], isError: true };

    const result = await callMisProxy('POST', `projects/${project_node_id}/status?status=${encodeURIComponent(status)}`, conn.id);
    if (!result.ok) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Failed to update project status (HTTP ${result.status})`, detail: result.data }, null, 2) }], isError: true };
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, project_node_id, new_status: status }, null, 2) }] };
  }
);

server.tool(
  'list_project_assets',
  'List assets (files) for an S2 project. Returns asset IDs, names, and metadata. Use asset IDs with the thumbnail/content proxy routes.',
  {
    project_node_id: z.string().describe('S2 node ID of the project'),
    connection_id: z.string().optional().describe('MIS connection UUID (uses active connection if omitted)'),
  },
  async ({ project_node_id, connection_id }) => {
    const conn = await resolveConnectionId(connection_id);
    if (!conn) return { content: [{ type: 'text' as const, text: 'No MIS connection found.' }], isError: true };

    const result = await callMisProxy('GET', `projects/${project_node_id}/assets`, conn.id);
    if (!result.ok) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Failed to list project assets (HTTP ${result.status})`, detail: result.data }, null, 2) }], isError: true };
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
  }
);

// ─── 3-Step Asset Upload Helper ─────────────────────────────
// S2 file uploads require: (1) create placeholder → (2) PUT binary to pre-signed URL → (3) finalize

async function s2UploadAsset(
  connectionId: string,
  createPath: string,
  relURL: string,
  fileContentBase64: string,
  mimeType: string
): Promise<{ ok: boolean; data?: any; error?: string }> {
  // Step 1: Create asset placeholder — returns { id, contentUri, contentId, version }
  const step1 = await callMisProxy('POST', createPath, connectionId, { relURL });
  if (!step1.ok) {
    return { ok: false, error: `Step 1 failed (create placeholder): HTTP ${step1.status} — ${JSON.stringify(step1.data)}` };
  }

  const { id: assetId, contentUri, contentId, version } = step1.data;
  if (!contentUri || !contentId) {
    return { ok: false, error: `Step 1 returned incomplete data — missing contentUri or contentId. Response: ${JSON.stringify(step1.data)}` };
  }

  // Step 2: Upload binary content directly to the pre-signed URL (no auth headers)
  const fileBuffer = Buffer.from(fileContentBase64, 'base64');
  const uploadResp = await fetch(contentUri, {
    method: 'PUT',
    headers: { 'Content-Type': mimeType || 'application/octet-stream' },
    body: fileBuffer,
  });
  if (!uploadResp.ok) {
    const errText = await uploadResp.text().catch(() => '');
    return { ok: false, error: `Step 2 failed (upload to pre-signed URL): HTTP ${uploadResp.status} — ${errText.slice(0, 300)}` };
  }

  // Step 3: Finalize upload
  const qs = `contentId=${encodeURIComponent(contentId)}&version=${encodeURIComponent(version)}&status=completed`;
  const step3 = await callMisProxy('POST', `assets/${assetId}/contentUploadStatus?${qs}`, connectionId);
  if (!step3.ok) {
    return { ok: false, error: `Step 3 failed (finalize): HTTP ${step3.status} — ${JSON.stringify(step3.data)}` };
  }

  return { ok: true, data: { asset_id: assetId, contentId, version, step1_response: step1.data, step3_response: step3.data } };
}

server.tool(
  'upload_project_asset',
  'Upload a file to an S2 project using the 3-step flow (create placeholder, upload binary, finalize). Returns the asset ID. Requires an S2 connection.',
  {
    project_node_id: z.string().describe('S2 node ID of the project'),
    file_name: z.string().describe('File name with extension (e.g. "design.pdf", "artwork.ai")'),
    file_content: z.string().describe('Base64-encoded file content'),
    folder: z.string().optional().describe('Subfolder path within the project (default: "Input")'),
    mime_type: z.string().optional().describe('MIME type of the file (default: auto-detect from extension)'),
    connection_id: z.string().optional().describe('MIS connection UUID (uses active connection if omitted)'),
  },
  async ({ project_node_id, file_name, file_content, folder, mime_type, connection_id }) => {
    const conn = await resolveConnectionId(connection_id);
    if (!conn) return { content: [{ type: 'text' as const, text: 'No MIS connection found.' }], isError: true };

    const dir = folder || 'Input';
    const relURL = `${dir}/${encodeURIComponent(file_name)}`;
    const mimeType = mime_type || guessMimeType(file_name);

    const result = await s2UploadAsset(conn.id, `projects/${project_node_id}/assets`, relURL, file_content, mimeType);
    if (!result.ok) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: result.error }, null, 2) }], isError: true };
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
  }
);

server.tool(
  'upload_product_asset',
  'Upload a graphic or shape file to an S2 product using the 3-step flow. Returns the asset ID. Requires an S2 connection.',
  {
    product_node_id: z.string().describe('S2 node ID of the product'),
    file_name: z.string().describe('File name with extension (e.g. "artwork.pdf", "die-line.ard")'),
    file_content: z.string().describe('Base64-encoded file content'),
    asset_type: z.enum(['graphic', 'shape']).describe('"graphic" for graphic assets (PDF, AI, etc.) or "shape" for shape/CAD assets (ARD, etc.)'),
    folder: z.string().optional().describe('Subfolder path (default: "Graphic files" for graphic, "CAD files" for shape)'),
    mime_type: z.string().optional().describe('MIME type of the file (default: auto-detect from extension)'),
    connection_id: z.string().optional().describe('MIS connection UUID (uses active connection if omitted)'),
  },
  async ({ product_node_id, file_name, file_content, asset_type, folder, mime_type, connection_id }) => {
    const conn = await resolveConnectionId(connection_id);
    if (!conn) return { content: [{ type: 'text' as const, text: 'No MIS connection found.' }], isError: true };

    const defaultFolder = asset_type === 'shape' ? 'CAD files' : 'Graphic files';
    const dir = folder || defaultFolder;
    const relURL = `${dir}/${encodeURIComponent(file_name)}`;
    const mimeType = mime_type || guessMimeType(file_name);
    const endpoint = asset_type === 'shape'
      ? `products/${product_node_id}/shapeAsset`
      : `products/${product_node_id}/graphicAssets`;

    const result = await s2UploadAsset(conn.id, endpoint, relURL, file_content, mimeType);
    if (!result.ok) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: result.error }, null, 2) }], isError: true };
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
  }
);

server.tool(
  'launch_workflow',
  'Launch a workflow template against a project with input assets. Returns the workflow instance ID for monitoring. Requires an S2 connection.',
  {
    template_id: z.string().describe('Workflow template node ID (from list_task_templates)'),
    project_node_id: z.string().describe('S2 node ID of the project (job) to run the workflow on'),
    input_asset_ids: z.array(z.string()).optional().describe('Array of asset node IDs to use as workflow inputs'),
    connection_id: z.string().optional().describe('MIS connection UUID (uses active connection if omitted)'),
  },
  async ({ template_id, project_node_id, input_asset_ids, connection_id }) => {
    const conn = await resolveConnectionId(connection_id);
    if (!conn) return { content: [{ type: 'text' as const, text: 'No MIS connection found.' }], isError: true };

    const body = {
      jobId: project_node_id,
      inputs: input_asset_ids || [],
    };

    const result = await callMisProxy('POST', `workflow-templates/${template_id}/launch`, conn.id, body);
    if (!result.ok) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Failed to launch workflow (HTTP ${result.status})`, detail: result.data }, null, 2) }], isError: true };
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
  }
);

server.tool(
  'list_workflow_instances',
  'List running and completed workflow instances. Useful for monitoring workflow progress. Requires an S2 connection.',
  {
    connection_id: z.string().optional().describe('MIS connection UUID (uses active connection if omitted)'),
    from: z.number().optional().describe('Zero-based start index for pagination (default: 0)'),
    pageSize: z.number().optional().describe('Max items to return (default: 20)'),
    searchValue: z.string().optional().describe('Search by name, workflow template name or project name (wildcard, case-insensitive)'),
  },
  async ({ connection_id, from, pageSize, searchValue }) => {
    const conn = await resolveConnectionId(connection_id);
    if (!conn) return { content: [{ type: 'text' as const, text: 'No MIS connection found.' }], isError: true };

    const params = new URLSearchParams();
    if (from !== undefined) params.set('from', String(from));
    if (pageSize !== undefined) params.set('pageSize', String(pageSize));
    if (searchValue) params.set('searchValue', searchValue);
    const qs = params.toString() ? `?${params.toString()}` : '';

    const result = await callMisProxy('GET', `workflow-instances${qs}`, conn.id);
    if (!result.ok) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Failed to list workflow instances (HTTP ${result.status})`, detail: result.data }, null, 2) }], isError: true };
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
  }
);

server.tool(
  'get_workflow_instance',
  'Get the status and details of a specific workflow instance. Use after launch_workflow to monitor progress.',
  {
    instance_id: z.string().describe('Workflow instance node ID'),
    connection_id: z.string().optional().describe('MIS connection UUID (uses active connection if omitted)'),
  },
  async ({ instance_id, connection_id }) => {
    const conn = await resolveConnectionId(connection_id);
    if (!conn) return { content: [{ type: 'text' as const, text: 'No MIS connection found.' }], isError: true };

    const result = await callMisProxy('GET', `workflow-instances/${instance_id}`, conn.id);
    if (!result.ok) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Failed to get workflow instance (HTTP ${result.status})`, detail: result.data }, null, 2) }], isError: true };
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
  }
);

server.tool(
  'cancel_workflow',
  'Cancel a running workflow instance. Use with caution — this cannot be undone.',
  {
    instance_id: z.string().describe('Workflow instance node ID to cancel'),
    connection_id: z.string().optional().describe('MIS connection UUID (uses active connection if omitted)'),
  },
  async ({ instance_id, connection_id }) => {
    const conn = await resolveConnectionId(connection_id);
    if (!conn) return { content: [{ type: 'text' as const, text: 'No MIS connection found.' }], isError: true };

    const result = await callMisProxy('POST', `workflow-instances/${instance_id}/cancel`, conn.id);
    if (!result.ok) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Failed to cancel workflow (HTTP ${result.status})`, detail: result.data }, null, 2) }], isError: true };
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, instance_id, status: 'cancelled' }, null, 2) }] };
  }
);

server.tool(
  'list_products',
  'List products from S2. Returns paginated list with product names, types, and node IDs. Requires an S2 connection.',
  {
    connection_id: z.string().optional().describe('MIS connection UUID (uses active connection if omitted)'),
    from: z.number().optional().describe('Zero-based start index for pagination (default: 0)'),
    pageSize: z.number().optional().describe('Max items to return (default: 20)'),
    searchValue: z.string().optional().describe('Search by name, generalIDs.ConverterMIS or GTIN (wildcard, case-insensitive)'),
  },
  async ({ connection_id, from, pageSize, searchValue }) => {
    const conn = await resolveConnectionId(connection_id);
    if (!conn) return { content: [{ type: 'text' as const, text: 'No MIS connection found.' }], isError: true };

    const params = new URLSearchParams();
    if (from !== undefined) params.set('from', String(from));
    if (pageSize !== undefined) params.set('pageSize', String(pageSize));
    if (searchValue) params.set('searchValue', searchValue);
    const qs = params.toString() ? `?${params.toString()}` : '';

    const result = await callMisProxy('GET', `products${qs}`, conn.id);
    if (!result.ok) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Failed to list products (HTTP ${result.status})`, detail: result.data }, null, 2) }], isError: true };
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
  }
);

server.tool(
  'create_product',
  'Create a new product in S2 with specifications (type, parts, printing intents, media references). Requires an S2 connection.',
  {
    name: z.string().describe('Product name (unique identifier)'),
    properties: z.record(z.any()).describe('Product properties object including descriptiveName, productType, parts[], customers[], etc.'),
    connection_id: z.string().optional().describe('MIS connection UUID (uses active connection if omitted)'),
  },
  async ({ name, properties, connection_id }) => {
    const conn = await resolveConnectionId(connection_id);
    if (!conn) return { content: [{ type: 'text' as const, text: 'No MIS connection found.' }], isError: true };

    const result = await callMisProxy('POST', 'products', conn.id, { name, properties });
    if (!result.ok) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Failed to create product (HTTP ${result.status})`, detail: result.data }, null, 2) }], isError: true };
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
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

// ─── Group 13: Personas & Research ────────────────────────

server.tool(
  'list_personas',
  'List all personas (reference content items tagged as personas). Returns name, segments, business tiers, and tags.',
  {
    segment: z.string().optional().describe('Filter by segment (e.g. "Labels", "Folding Carton")'),
    search: z.string().optional().describe('Search by name'),
    limit: z.number().optional().default(50).describe('Max items to return'),
  },
  async ({ segment, search, limit }) => {
    let path = `content?type=eq.reference&metadata->>reference_type=eq.persona&select=id,title,body,tags,status,metadata,updated_at&order=title&limit=${limit}`;
    if (search) path += `&title=ilike.*${encodeURIComponent(search)}*`;
    const rows = await supabaseGet(path);

    // Filter by segment if specified (segments are in the body or metadata)
    let filtered = rows;
    if (segment) {
      filtered = rows.filter((r: any) => {
        const segs = r.metadata?.segments || [];
        if (segs.length && segs.some((s: string) => s.toLowerCase().includes(segment.toLowerCase()))) return true;
        // Fallback: check body text for segment mention
        return r.body?.toLowerCase().includes(segment.toLowerCase());
      });
    }

    // Return summary info (strip body for list view)
    const items = filtered.map((r: any) => ({
      id: r.id,
      name: r.title?.replace(/^Persona\s*[-–—]\s*/i, '') || r.title,
      title: r.title,
      segments: r.metadata?.segments || [],
      business_tiers: r.metadata?.business_tiers || [],
      tags: r.tags || [],
      updated_at: r.updated_at,
    }));

    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ count: items.length, items }, null, 2) }],
    };
  }
);

server.tool(
  'get_persona',
  'Get full persona detail including body, metadata, and recent update log entries.',
  {
    id: z.string().describe('Persona content item UUID'),
  },
  async ({ id }) => {
    const rows = await supabaseGet(`content?id=eq.${id}&select=id,type,title,body,tags,status,metadata,url,source,captured_at,updated_at&limit=1`);
    if (!rows.length) {
      return { content: [{ type: 'text' as const, text: 'Persona not found' }], isError: true };
    }
    const persona = rows[0];

    // Fetch recent log entries
    const logEntries = await supabaseGet(
      `persona_log?content_id=eq.${id}&select=id,log_date,entry,source,section_updated,created_at&order=created_at.desc&limit=20`
    );

    // Fetch linked content
    const links = await supabaseGet(
      `content_links?or=(source_id.eq.${id},target_id.eq.${id})&select=id,source_id,target_id,link_type,context&limit=20`
    );

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          ...persona,
          name: persona.title?.replace(/^Persona\s*[-–—]\s*/i, '') || persona.title,
          recent_updates: logEntries,
          linked_content: links,
        }, null, 2),
      }],
    };
  }
);

server.tool(
  'update_persona_section',
  'Append new evidence or observations to a specific section of a persona. Creates a persona_log entry tracking the update.',
  {
    persona_id: z.string().describe('UUID of the persona content item'),
    section: z.enum(['pain_points', 'discovery_questions', 'goals', 'workflow_stages', 'tools_systems', 'segment_variations', 'profile', 'buying_influence'])
      .describe('Which section to update'),
    addition: z.string().describe('Text to append to the section'),
    source: z.string().optional().default('manual').describe('Source of update (e.g. daily_review, voc_session, support_review, admin_edit)'),
    source_ref: z.record(z.any()).optional().default({}).describe('Reference back to source content'),
  },
  async ({ persona_id, section, addition, source, source_ref }) => {
    // Fetch current persona
    const rows = await supabaseGet(`content?id=eq.${persona_id}&select=id,title,body&limit=1`);
    if (!rows.length) {
      return { content: [{ type: 'text' as const, text: 'Persona not found' }], isError: true };
    }
    const persona = rows[0];
    let body = persona.body || '';

    // Map section names to markdown headers
    const sectionHeaders: Record<string, string> = {
      pain_points: '## Pain Points',
      discovery_questions: '## Discovery Questions',
      goals: '## Goals & Motivations',
      workflow_stages: '## Workflow Stages',
      tools_systems: '## Tools & Systems Used',
      segment_variations: '## Segment Variations',
      profile: '## Profile',
      buying_influence: '## Buying Influence',
    };

    const header = sectionHeaders[section];
    const today = new Date().toISOString().split('T')[0];
    const updateBlock = `\n\n> **Update ${today}** (${source}): ${addition}`;

    // Find the section and append after it (before the next ## header)
    const headerIdx = body.indexOf(header);
    if (headerIdx === -1) {
      // Section doesn't exist — append it at the end
      body += `\n\n${header}\n${updateBlock}`;
    } else {
      // Find the next ## header after this section
      const afterHeader = body.indexOf('\n## ', headerIdx + header.length);
      if (afterHeader === -1) {
        // No next section — append at end of body
        body += updateBlock;
      } else {
        // Insert before the next section
        body = body.slice(0, afterHeader) + updateBlock + body.slice(afterHeader);
      }
    }

    // Update the content item
    await supabasePatch(`content?id=eq.${persona_id}`, {
      body,
      updated_at: new Date().toISOString(),
    });

    // Create persona_log entry
    await supabasePost('persona_log', {
      content_id: persona_id,
      log_date: today,
      entry: addition,
      source,
      source_ref: source_ref || {},
      section_updated: section,
    });

    // Re-embed
    embedItem('content', persona_id).catch(() => {});

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          ok: true,
          persona: persona.title,
          section,
          source,
          log_created: true,
        }, null, 2),
      }],
    };
  }
);

server.tool(
  'update_research',
  'Append new evidence or observations to a research content item. Creates a research_log entry tracking the update.',
  {
    content_id: z.string().describe('UUID of the research content item'),
    addition: z.string().describe('Text to append'),
    section: z.string().optional().describe('Which part of the research was updated'),
    source: z.string().optional().default('manual').describe('Source of update (e.g. daily_review, voc_session, support_review, admin_edit)'),
    source_ref: z.record(z.any()).optional().default({}).describe('Reference back to source content'),
  },
  async ({ content_id, addition, section, source, source_ref }) => {
    const rows = await supabaseGet(`content?id=eq.${content_id}&select=id,title,body,type&limit=1`);
    if (!rows.length) {
      return { content: [{ type: 'text' as const, text: 'Content not found' }], isError: true };
    }
    const item = rows[0];
    const today = new Date().toISOString().split('T')[0];
    const updateBlock = `\n\n---\n### Update ${today} (${source})${section ? ` — ${section}` : ''}\n${addition}`;

    await supabasePatch(`content?id=eq.${content_id}`, {
      body: (item.body || '') + updateBlock,
      updated_at: new Date().toISOString(),
    });

    // Create research_log entry
    await supabasePost('research_log', {
      content_id,
      log_date: today,
      entry: addition,
      source,
      source_ref: source_ref || {},
      section_updated: section || null,
    });

    // Re-embed
    embedItem('content', content_id).catch(() => {});

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          ok: true,
          content: item.title,
          section: section || 'general',
          source,
          log_created: true,
        }, null, 2),
      }],
    };
  }
);

// ─── Group 14: Tasks ──────────────────────────────────────

server.tool(
  'list_tasks',
  'List tasks with filters. Defaults to open (not done). Filter by status, due window (today/week/overdue), source, tag, or priority. Returns count + task rows.',
  {
    status: z
      .enum(['open', 'todo', 'doing', 'done', 'blocked', 'all'])
      .optional()
      .default('open')
      .describe('"open" = not done; others filter to that status; "all" = no filter'),
    due: z
      .enum(['today', 'week', 'overdue', 'anytime'])
      .optional()
      .describe('Date window: today, current ISO week, overdue (< today & not done), or anytime'),
    priority: z.enum(['high', 'medium', 'low']).optional(),
    source_table: z.string().optional().describe('Filter to tasks linked to a source table'),
    source_id: z.string().optional().describe('Filter to tasks linked to a specific source row'),
    tag: z.string().optional(),
    client_date: z
      .string()
      .optional()
      .describe('YYYY-MM-DD reference date for due-window math; defaults to UTC today'),
    limit: z.number().optional().default(100),
  },
  async ({ status, due, priority, source_table, source_id, tag, client_date, limit }) => {
    const today = /^\d{4}-\d{2}-\d{2}$/.test(client_date || '')
      ? client_date
      : new Date().toISOString().slice(0, 10);
    const filters: string[] = [];
    if (status === 'open') filters.push('status=neq.done');
    else if (status && status !== 'all') filters.push(`status=eq.${status}`);
    if (priority) filters.push(`priority=eq.${priority}`);
    if (source_table) filters.push(`source_table=eq.${encodeURIComponent(source_table)}`);
    if (source_id) filters.push(`source_id=eq.${encodeURIComponent(source_id)}`);
    if (tag) filters.push(`tags=cs.{${encodeURIComponent(tag)}}`);
    if (due === 'today') filters.push(`due_date=eq.${today}`);
    else if (due === 'overdue') {
      filters.push(`due_date=lt.${today}`);
      filters.push('status=neq.done');
    } else if (due === 'week') {
      const d = new Date(today + 'T00:00:00Z');
      const dow = d.getUTCDay();
      const toMon = dow === 0 ? -6 : 1 - dow;
      const monday = new Date(d.getTime() + toMon * 86400000).toISOString().slice(0, 10);
      const sunday = new Date(d.getTime() + (toMon + 6) * 86400000).toISOString().slice(0, 10);
      filters.push(`due_date=gte.${monday}`);
      filters.push(`due_date=lte.${sunday}`);
    }
    const cap = Math.min(limit || 100, 500);
    const query = `tasks?${filters.join('&')}${filters.length ? '&' : ''}order=due_date.asc.nullslast,priority.asc.nullslast,created_at.desc&limit=${cap}`;
    const rows = await supabaseGet(query);
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify({ count: rows.length, tasks: rows }, null, 2) },
      ],
    };
  }
);

server.tool(
  'get_task',
  'Get a single task by id',
  { id: z.string().describe('Task UUID') },
  async ({ id }) => {
    const rows = await supabaseGet(`tasks?id=eq.${id}&limit=1`);
    if (!rows.length) {
      return { content: [{ type: 'text' as const, text: 'Task not found' }] };
    }
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(rows[0], null, 2) }],
    };
  }
);

server.tool(
  'create_task',
  'Create a new task. Optionally link to a source (source_table + source_id) such as a daily_note, content item, project, or problem.',
  {
    title: z.string().describe('Task title — required'),
    description: z.string().optional(),
    status: z.enum(['todo', 'doing', 'done', 'blocked']).optional().default('todo'),
    priority: z.enum(['high', 'medium', 'low']).optional(),
    due_date: z.string().optional().describe('YYYY-MM-DD'),
    source_table: z.string().optional(),
    source_id: z.string().optional(),
    source_ref: z.string().optional().describe('Free-form back-ref like "Stand-up 2026-04-20"'),
    tags: z.array(z.string()).optional(),
  },
  async (args) => {
    const row: Record<string, any> = { ...args };
    if (!row.status) row.status = 'todo';
    const result = await supabasePost('tasks', row, true);
    if (!result.ok) {
      return { content: [{ type: 'text' as const, text: `Failed: ${result.error}` }] };
    }
    const task = Array.isArray(result.data) ? result.data[0] : result.data;
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(task, null, 2) }],
    };
  }
);

server.tool(
  'update_task',
  'Update fields on a task. Setting status to "done" also sets completed_at automatically.',
  {
    id: z.string().describe('Task UUID'),
    title: z.string().optional(),
    description: z.string().optional(),
    status: z.enum(['todo', 'doing', 'done', 'blocked']).optional(),
    priority: z.enum(['high', 'medium', 'low']).optional(),
    due_date: z.string().optional().describe('YYYY-MM-DD; pass empty string to clear'),
    source_table: z.string().optional(),
    source_id: z.string().optional(),
    source_ref: z.string().optional(),
    tags: z.array(z.string()).optional(),
  },
  async ({ id, ...patch }) => {
    // Allow explicit null clearing via "" on optional fields
    if (patch.due_date === '') (patch as any).due_date = null;
    const result = await supabasePatch(`tasks?id=eq.${id}`, patch);
    if (!result.ok) {
      return { content: [{ type: 'text' as const, text: `Failed: ${result.error}` }] };
    }
    return { content: [{ type: 'text' as const, text: 'OK' }] };
  }
);

server.tool(
  'complete_task',
  'Mark a task done (sets status=done, completed_at=now).',
  { id: z.string().describe('Task UUID') },
  async ({ id }) => {
    const result = await supabasePatch(`tasks?id=eq.${id}`, { status: 'done' });
    if (!result.ok) {
      return { content: [{ type: 'text' as const, text: `Failed: ${result.error}` }] };
    }
    return { content: [{ type: 'text' as const, text: 'Completed' }] };
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
