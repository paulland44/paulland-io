/**
 * Readwise Reader sync — ported from capture-bot/src/reader/sync.py
 *
 * Optimised for Cloudflare Workers with limited subrequests (50 on Bundled plan):
 * - Batch URL lookups into single Supabase queries using `in.(...)` operator
 * - Batch inserts for feed items
 * - Process one page at a time, stop when budget is exhausted
 */

import type { Env } from './supabase';
import { supabaseGet, supabasePost, supabasePatch, supabaseUpsert } from './supabase';
import { htmlToMarkdown } from './html-to-md';

const READER_API_URL = 'https://readwise.io/api/v3/list/';
const READER_UPDATE_URL = 'https://readwise.io/api/v3/update/';

const SYNC_CATEGORIES = new Set(['article', 'rss', 'pdf', 'video', 'tweet']);

interface SyncStats {
  synced: number;
  skipped: number;
  updated: number;
  errors: number;
}

export async function syncReader(env: Env): Promise<SyncStats> {
  const token = env.READWISE_TOKEN;
  if (!token) {
    console.log('READWISE_TOKEN not set — Reader sync skipped');
    return { synced: 0, skipped: 0, updated: 0, errors: 0 };
  }

  const { SUPABASE_URL: url, SUPABASE_SERVICE_KEY: key } = env;
  const readerHeaders = { Authorization: `Token ${token}` };

  // Ensure a "Readwise Reader" feed entry exists
  const readerFeedId = await ensureReaderFeed(url, key);

  // Get last sync timestamp
  let updatedAfter: string | null = null;
  const stateRows = await supabaseGet(
    url, key,
    'sync_state?key=eq.reader_last_sync&select=value&limit=1'
  );
  if (stateRows.length > 0) {
    updatedAfter = stateRows[0].value;
    console.log(`Reader incremental sync from ${updatedAfter}`);
  } else {
    updatedAfter = new Date().toISOString().slice(0, 10) + 'T00:00:00Z';
    console.log(`Reader first sync — starting from today: ${updatedAfter}`);
  }

  const stats: SyncStats = { synced: 0, skipped: 0, updated: 0, errors: 0 };
  const syncedReaderIds: string[] = [];
  let hitLimit = false;

  // Process one page per location. On Bundled plan (~50 subrequests),
  // we can do: 3 setup + 1 API + ~20 batch-processed articles + 1 API + ~10 batch feed items
  // = ~15 subrequests per page with batching.
  for (const location of ['new', 'later', 'feed'] as const) {
    if (hitLimit) break;

    const params = new URLSearchParams({
      page_size: '20',
      location,
    });
    if (location !== 'feed') {
      params.set('withHtmlContent', 'true');
    }
    if (updatedAfter) {
      params.set('updatedAfter', updatedAfter);
    }

    let data: any;
    try {
      const resp = await fetch(`${READER_API_URL}?${params}`, {
        headers: readerHeaders,
        signal: AbortSignal.timeout(60_000),
      });
      if (!resp.ok) {
        console.error(`Reader API ${location}: ${resp.status}`);
        stats.errors++;
        continue;
      }
      data = await resp.json();
    } catch (e) {
      console.error(`Reader API request failed (${location}):`, e);
      stats.errors++;
      continue;
    }

    const results: any[] = data.results || [];
    if (results.length === 0) continue;

    console.log(`Reader sync [${location}]: ${results.length} documents`);

    try {
      if (location === 'feed') {
        const feedStats = await batchProcessFeedDocuments(url, key, results, readerFeedId);
        stats.synced += feedStats.synced;
        stats.skipped += feedStats.skipped;
      } else {
        const articleStats = await batchProcessDocuments(url, key, results);
        stats.synced += articleStats.synced;
        stats.skipped += articleStats.skipped;
        stats.updated += articleStats.updated;
        syncedReaderIds.push(...articleStats.syncedIds);
      }
    } catch (e) {
      console.error(`Batch processing failed (${location}):`, e);
      stats.errors++;
      hitLimit = true;
    }
  }

  // Archive synced documents in Reader (batch, max 10 to stay under limit)
  if (syncedReaderIds.length > 0) {
    const toArchive = syncedReaderIds.slice(0, 10);
    const archived = await archiveInReader(readerHeaders, toArchive);
    console.log(`Archived ${archived}/${syncedReaderIds.length} documents in Reader`);
  }

  // Only update sync cursor if we processed everything
  if (!hitLimit) {
    await supabaseUpsert(url, key, 'sync_state', {
      key: 'reader_last_sync',
      value: new Date().toISOString(),
    }, 'key');
  } else {
    console.log('Sync cursor NOT updated — will continue on next cron run');
  }

  console.log(
    `Reader sync complete: ${stats.synced} synced, ${stats.updated} updated, ${stats.skipped} skipped, ${stats.errors} errors${hitLimit ? ' (limit reached)' : ''}`
  );
  return stats;
}

async function ensureReaderFeed(url: string, key: string): Promise<string> {
  const existing = await supabaseGet(
    url, key,
    `feeds?url=eq.${encodeURIComponent('https://readwise.io/reader/feed')}&select=id&limit=1`
  );
  if (existing.length > 0) return existing[0].id;

  const result = await supabasePost(url, key, 'feeds', {
    url: 'https://readwise.io/reader/feed',
    name: 'Readwise Reader',
    mode: 'digest',
    active: true,
  }, true);
  return result.data?.[0]?.id || '';
}

/**
 * Batch process content documents (new/later).
 * Uses a single Supabase query to check all URLs at once.
 */
async function batchProcessDocuments(
  url: string,
  key: string,
  docs: any[]
): Promise<{ synced: number; skipped: number; updated: number; syncedIds: string[] }> {
  const result = { synced: 0, skipped: 0, updated: 0, syncedIds: [] as string[] };

  // Filter to sync-eligible docs
  const eligible = docs.filter((d) => {
    const cat = d.category || '';
    const sourceUrl = d.source_url || d.url || '';
    const title = (d.title || '').trim();
    return SYNC_CATEGORIES.has(cat) && sourceUrl && title;
  });
  if (eligible.length === 0) return result;

  // Batch check existing URLs in one query
  const urls = eligible.map((d) => d.source_url || d.url);
  const urlList = urls.map((u: string) => `"${u.replace(/"/g, '\\"')}"`).join(',');
  const existing = await supabaseGet(
    url, key,
    `content?url=in.(${urlList})&select=id,url,body,title,tags,metadata,author`
  );
  const existingByUrl = new Map(existing.map((e: any) => [e.url, e]));

  // Process each doc
  const newDocs: any[] = [];
  for (const doc of eligible) {
    const sourceUrl = doc.source_url || doc.url || '';
    const ex = existingByUrl.get(sourceUrl);

    if (ex) {
      // Check if we should update
      const body = convertBody(doc);
      const existingBody = ex.body || '';
      const isStub = existingBody.startsWith('*Article content could not be extracted');
      if (isStub || body.length > existingBody.length + 100) {
        // Update existing — costs 1 subrequest
        const updates = buildUpdates(doc, ex, body);
        await supabasePatch(url, key, `content?id=eq.${ex.id}`, updates);
        result.updated++;
        result.syncedIds.push(doc.id);
      } else {
        result.skipped++;
      }
    } else {
      newDocs.push(doc);
    }
  }

  // Batch insert new documents (single subrequest for all)
  if (newDocs.length > 0) {
    const rows = newDocs.map((doc) => {
      const body = convertBody(doc);
      const readerTags = extractTags(doc);
      const contentType = mapCategory(doc.category, readerTags);

      const row: any = {
        type: contentType,
        title: (doc.title || '').trim(),
        body,
        url: doc.source_url || doc.url || '',
        source: doc.site_name || doc.source || '',
        author: doc.author || null,
        tags: readerTags,
        status: 'new',
        metadata: buildMetadata(doc),
      };
      const capturedAt = doc.saved_at || doc.created_at;
      if (capturedAt) row.captured_at = capturedAt;
      return row;
    });

    const insertResult = await supabasePost(url, key, 'content', rows);
    if (insertResult.ok) {
      result.synced += newDocs.length;
      result.syncedIds.push(...newDocs.map((d) => d.id));
    } else {
      console.error(`Batch content insert failed: ${insertResult.error}`);
    }
  }

  return result;
}

/**
 * Batch process feed documents.
 * Uses batch URL lookups and batch inserts.
 */
async function batchProcessFeedDocuments(
  url: string,
  key: string,
  docs: any[],
  readerFeedId: string
): Promise<{ synced: number; skipped: number }> {
  const result = { synced: 0, skipped: 0 };

  const eligible = docs.filter((d) => {
    const sourceUrl = d.source_url || d.url || '';
    const title = (d.title || '').trim();
    return sourceUrl && title;
  });
  if (eligible.length === 0) return result;

  // Batch check which URLs already exist in feed_items
  const urls = eligible.map((d) => d.source_url || d.url);
  const urlList = urls.map((u: string) => `"${u.replace(/"/g, '\\"')}"`).join(',');
  const seenFeedItems = await supabaseGet(
    url, key,
    `feed_items?item_url=in.(${urlList})&select=item_url`
  );
  const seenUrls = new Set(seenFeedItems.map((f: any) => f.item_url));

  // Batch check which URLs already exist in content
  const seenContent = await supabaseGet(
    url, key,
    `content?url=in.(${urlList})&select=id,url`
  );
  const contentByUrl = new Map(seenContent.map((c: any) => [c.url, c.id]));

  // Build new feed items to insert
  const newItems: any[] = [];
  for (const doc of eligible) {
    const sourceUrl = doc.source_url || doc.url || '';
    if (seenUrls.has(sourceUrl)) {
      result.skipped++;
      continue;
    }

    const contentId = contentByUrl.get(sourceUrl);
    newItems.push({
      feed_id: readerFeedId,
      item_url: sourceUrl,
      item_title: (doc.title || '').trim(),
      item_summary: (doc.summary || '').slice(0, 500),
      captured: !!contentId,
      content_id: contentId || null,
    });
  }

  // Batch insert all new feed items (single subrequest)
  if (newItems.length > 0) {
    const insertResult = await supabasePost(url, key, 'feed_items', newItems);
    if (insertResult.ok) {
      result.synced += newItems.filter((i) => !i.captured).length;
      result.skipped += newItems.filter((i) => i.captured).length;
    } else {
      console.error(`Batch feed_items insert failed: ${insertResult.error}`);
    }
  }

  return result;
}

function convertBody(doc: any): string {
  const html = doc.html_content || '';
  if (html) return htmlToMarkdown(html);
  const summary = doc.summary || '';
  return summary || `*No content available. View in Reader: ${doc.url || doc.source_url}*`;
}

function extractTags(doc: any): string[] {
  const tags: string[] = [];
  const tagsData = doc.tags;
  if (tagsData && typeof tagsData === 'object') {
    for (const [k, t] of Object.entries(tagsData)) {
      if (t && typeof t === 'object' && 'name' in t) {
        tags.push((t as any).name || k);
      }
    }
  }
  return tags;
}

function mapCategory(category: string, tags: string[]): string {
  if (category === 'video') {
    if (!tags.includes('video')) tags.push('video');
    return 'article';
  }
  if (category === 'pdf') {
    if (!tags.includes('pdf')) tags.push('pdf');
    return 'article';
  }
  if (category === 'tweet') return 'thought';
  return 'article';
}

function buildMetadata(doc: any): Record<string, any> {
  return {
    published_date: doc.published_date,
    description: doc.summary,
    image_url: doc.image_url,
    reader_id: doc.id,
    reader_url: doc.url,
    word_count: doc.word_count,
    reading_time: doc.reading_time,
    source_app: 'reader',
  };
}

function buildUpdates(doc: any, existing: any, body: string): Record<string, any> {
  const updates: Record<string, any> = {
    body,
    metadata: { ...(existing.metadata || {}), ...buildMetadata(doc) },
  };
  const existingTitle = existing.title || '';
  if (/^\d+$/.test(existingTitle.trim()) || existingTitle.length < 5) {
    updates.title = (doc.title || '').trim();
  }
  const existingTags: string[] = existing.tags || [];
  const readerTags = extractTags(doc);
  updates.tags = [...new Set([...existingTags, ...readerTags])];
  if (!existing.author && doc.author) {
    updates.author = doc.author;
  }
  return updates;
}

async function archiveInReader(
  headers: Record<string, string>,
  readerIds: string[]
): Promise<number> {
  let archived = 0;
  for (const readerId of readerIds) {
    try {
      const resp = await fetch(READER_UPDATE_URL + readerId, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ location: 'archive' }),
        signal: AbortSignal.timeout(15_000),
      });
      if (resp.ok) archived++;
      else console.warn(`Failed to archive Reader doc ${readerId}: ${resp.status}`);
    } catch {
      console.warn(`Error archiving Reader doc ${readerId}`);
    }
  }
  return archived;
}
