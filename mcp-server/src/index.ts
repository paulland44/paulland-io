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

// ─── Server Setup ────────────────────────────────────────────

const server = new McpServer({
  name: 'paulland-kb',
  version: '1.0.0',
});

// ─── Tool & Resource Registration ───────────────────────────
// Wrapped in functions so the Worker can create fresh instances per request.

function registerTools(server: McpServer) {

// ─── Group 1: Content Access (Read) ─────────────────────────

server.tool(
  'list_content',
  'List content items (articles, thoughts, signals, reflections) with optional filters',
  {
    type: z
      .enum(['article', 'thought', 'signal', 'reflection', 'summary'])
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
  'Create a new content item (article, thought, signal, reflection)',
  {
    type: z
      .enum(['article', 'thought', 'signal', 'reflection'])
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

    // Fetch entity context
    const [people, products, projects] = await Promise.all([
      supabaseGet('people?select=id,name,role,organization&order=name'),
      supabaseGet('products?select=id,name&order=name'),
      supabaseGet('projects?select=id,name,product_id&order=name'),
    ]);

    const peopleNames = people.map((p: any) => p.name);
    const productNames = products.map((p: any) => p.name);
    const projectNames = projects.map((p: any) => p.name);

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
              user_prompt: userPrompt,
              instructions:
                'Process this daily note and extract: people_entries, product_evidence, product_decisions, project_updates, reflections, migrated_tasks, context_notes, and review_summary. Return as JSON. Then call daily_review_write with the results.',
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
  'Create a draft MIS job record in the simulator. The job can be submitted to WCP via the MIS Simulator web UI.',
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
    })).optional().describe('Job tasks'),
  },
  async ({ job_name, customer_code, customer_name, description, due_date, connection_id, tasks }) => {
    // Resolve connection
    let connection: any = null;
    if (connection_id) {
      const rows = await supabaseGet(
        `mis_connections?id=eq.${connection_id}&select=id,name,type,cluster,ecan,repo_id&limit=1`
      );
      if (rows.length) connection = rows[0];
    } else {
      const rows = await supabaseGet(
        'mis_connections?is_active=eq.true&select=id,name,type,cluster,ecan,repo_id&limit=1'
      );
      if (rows.length) connection = rows[0];
    }

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

    // Build WCP-compatible payload
    const payload: any = {
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

    // Insert job record
    const jobRecord = {
      job_id,
      job_name,
      customer_code: customer_code || null,
      customer_name: customer_name || null,
      status: 'Draft',
      phase: 'Draft',
      due_date: payload.dueDate,
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
          connection: connection?.name || 'none',
          note: 'Job record created as Draft. Submit to WCP via the MIS Simulator web UI to activate.',
        }, null, 2),
      }],
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
