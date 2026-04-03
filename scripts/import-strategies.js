/**
 * Import strategy files from the Obsidian knowledge base
 * into Supabase content table as type='strategy'.
 *
 * Usage:
 *   source mcp-server/.env && node scripts/import-strategies.js
 *
 * No dependencies needed — uses native fetch and fs.
 */

const { readFileSync, readdirSync, existsSync } = require('fs');
const { join, basename } = require('path');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_KEY env vars');
  process.exit(1);
}

const KB = '/Users/pala/Documents/knowledge-base';

// Files to skip
const SKIP_FILES = new Set([
  'DECK_VISUAL_INSPECTION_REPORT.md',
  'WCP Agent-Ready Strategy.md',
  'ellis-mcp-roadmap.md',
]);

// ─── Helpers ─────────────────────────────────────────────────

function parseFrontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: text };
  const meta = {};
  const lines = match[1].split('\n');
  let currentKey = null;
  let inArray = false;

  for (const line of lines) {
    const kv = line.match(/^(\w[\w-]*):\s*(.+)$/);
    if (kv) {
      const val = kv[2].replace(/^['"]|['"]$/g, '');
      meta[kv[1]] = val;
      currentKey = kv[1];
      inArray = false;
      continue;
    }
    const keyOnly = line.match(/^(\w[\w-]*):\s*$/);
    if (keyOnly) {
      currentKey = keyOnly[1];
      meta[currentKey] = [];
      inArray = true;
      continue;
    }
    if (inArray && currentKey && line.match(/^- /)) {
      const val = line.replace(/^- /, '').replace(/^['"]|['"]$/g, '').trim();
      if (!Array.isArray(meta[currentKey])) meta[currentKey] = [];
      meta[currentKey].push(val);
    }
  }
  return { meta, body: match[2] };
}

function cleanObsidianLinks(text) {
  text = text.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2');
  text = text.replace(/\[\[(?:[^/\]]+\/)*([^\]]+)\]\]/g, '$1');
  return text;
}

function classifyStrategyType(meta, filename, isInFeedbackDir) {
  const title = (meta.title || filename).toLowerCase();
  const fmType = (meta.type || '').toLowerCase();

  if (isInFeedbackDir || title.includes('voc') || title.includes('bug list') ||
      title.includes('feedback') || title === 'customer insights') {
    return 'customer-feedback';
  }
  if (fmType === 'ost' || title.includes('opportunity solution tree')) return 'ost';
  if (title === 'pjl domain strategy') return 'core-strategy';
  if (title.includes('product strategy')) return 'product-strategy';
  if (title.includes('goals') || title.includes('goal descriptions')) return 'goals';
  if (title.includes('roadmap') && !title.includes('validation') && !title.includes('mcp')) return 'roadmap';
  if (title.includes('ai transformation') || title.includes('solving packaging')) return 'thought-leadership';
  if (title.includes('supporting evidence')) return 'thought-leadership';
  if (title.includes('ellis') || title.includes('mcp validation') || title.includes('mcp strategic')) return 'architecture';
  if (['domain-health-tracker', 'decisions', 'show-and-tell', 'ideas'].includes(filename.replace('.md', ''))) return 'operational';
  if (fmType === 'collection') return 'operational';
  return 'reference';
}

function detectProductArea(meta, body) {
  const tagsStr = Array.isArray(meta.tags) ? meta.tags.join(' ') : (meta.tags || '');
  const text = ((meta.title || '') + ' ' + tagsStr + ' ' + body.substring(0, 500)).toLowerCase();
  const areas = [];
  if (text.includes('webcenter pack') || text.includes('wcp') || text.includes('wcrpack')) areas.push('WCP');
  if (text.includes('automation engine') || /\bae\b/.test(text)) areas.push('AE');
  if (text.includes('phoenix') || text.includes('tilia')) areas.push('Phoenix');
  if (areas.length === 0) return 'Domain';
  if (areas.length >= 3) return 'Domain'; // covers all = domain-level
  return areas.join(',');
}

function extractVersion(meta, body) {
  if (meta.version) return meta.version;
  const m = (meta.status || '').match(/v[\d.]+/i) || body.match(/Version:\s*(v[\d.]+)/i);
  return m ? m[0] : null;
}

function extractDocStatus(meta) {
  const s = (meta.status || '').toLowerCase();
  if (s.includes('superseded')) return 'superseded';
  if (s.includes('active')) return 'active';
  if (s.includes('draft') || s.includes('working')) return 'draft';
  return 'active';
}

function extractOwner(meta) {
  const owner = meta.owner || meta['domain-lead'] || '';
  return owner.replace(/\[\[/g, '').replace(/\]\]/g, '').trim() || null;
}

function extractProblemRefs(body) {
  const refs = new Set();
  const matches = body.matchAll(/\b(PP?\d{1,2})\b/g);
  for (const m of matches) {
    const id = m[1];
    // Filter out false positives (SP1, SP2, SP3 etc won't match PP? pattern)
    if (/^P\d{1,2}$/.test(id) || /^PP\d{1,2}$/.test(id)) {
      refs.add(id);
    }
  }
  return [...refs];
}

function extractRelatedTitles(meta) {
  const related = meta.related;
  if (!related) return [];
  const items = Array.isArray(related) ? related : [related];
  return items.map(r => r.replace(/\[\[/g, '').replace(/\]\]/g, '').trim()).filter(Boolean);
}

async function supabaseUpsert(record) {
  const existing = await fetch(
    `${SUPABASE_URL}/rest/v1/content?title=eq.${encodeURIComponent(record.title)}&type=eq.strategy&select=id&limit=1`,
    {
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      },
    }
  );
  const rows = await existing.json();

  if (rows.length) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/content?id=eq.${rows[0].id}`,
      {
        method: 'PATCH',
        headers: {
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify({
          body: record.body,
          tags: record.tags,
          status: record.status,
          metadata: record.metadata,
          updated_at: new Date().toISOString(),
        }),
      }
    );
    if (!res.ok) throw new Error(`Update failed ${res.status}: ${await res.text()}`);
    return { id: rows[0].id, action: 'updated' };
  }

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/content`,
    {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: JSON.stringify(record),
    }
  );
  if (!res.ok) throw new Error(`Insert failed ${res.status}: ${await res.text()}`);
  const created = await res.json();
  return { id: created[0]?.id, action: 'created' };
}

async function createContentLink(sourceId, targetId, linkType, context) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/content_links`,
    {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({ source_id: sourceId, target_id: targetId, link_type: linkType, context }),
    }
  );
  if (!res.ok && res.status !== 409) {
    console.warn(`    Link warning: ${(await res.text()).substring(0, 100)}`);
  }
  return res.ok || res.status === 409;
}

// ─── Import ─────────────────────────────────────────────────

async function importFile(filePath, isInFeedbackDir) {
  const filename = basename(filePath);
  if (SKIP_FILES.has(filename)) {
    console.log(`  SKIP ${filename} (excluded)`);
    return null;
  }

  const raw = readFileSync(filePath, 'utf-8');
  const { meta, body } = parseFrontmatter(raw);
  const content = cleanObsidianLinks(body.trim());

  const strategyType = classifyStrategyType(meta, filename.replace('.md', ''), isInFeedbackDir);
  const productArea = detectProductArea(meta, content);
  const version = extractVersion(meta, content);
  const docStatus = extractDocStatus(meta);
  const owner = extractOwner(meta);
  const problemRefs = extractProblemRefs(content);
  const relatedTitles = extractRelatedTitles(meta);

  const tags = ['strategy', strategyType];
  if (productArea && productArea !== 'Domain') {
    productArea.split(',').forEach(a => tags.push(a.toLowerCase()));
  }
  const fmTags = Array.isArray(meta.tags) ? meta.tags : (meta.tags ? [meta.tags] : []);
  for (const t of fmTags) {
    const clean = String(t).toLowerCase().trim();
    if (clean && !tags.includes(clean)) tags.push(clean);
  }

  const record = {
    type: 'strategy',
    title: meta.title || filename.replace('.md', ''),
    body: content,
    tags: [...new Set(tags)],
    status: 'active',
    source_path: filePath.replace(KB + '/', ''),
    metadata: {
      strategy_type: strategyType,
      product_area: productArea,
      owner,
      version,
      doc_status: docStatus,
      problem_refs: problemRefs,
      related_titles: relatedTitles,
      migrated_from: filePath.replace(KB + '/', ''),
      migrated: meta.migrated || new Date().toISOString(),
    },
  };

  try {
    const result = await supabaseUpsert(record);
    const label = strategyType.padEnd(20);
    console.log(`  ${result.action === 'created' ? 'NEW' : 'UPD'}  ${label} ${record.title}`);
    return { ...result, title: record.title, problemRefs, relatedTitles, strategyType };
  } catch (err) {
    console.error(`  ERR  ${filename}: ${err.message}`);
    return null;
  }
}

async function main() {
  const results = [];

  // Root strategy files
  console.log('\n── Strategy Files ──');
  const strategyDir = join(KB, 'brain/strategy');
  const rootFiles = readdirSync(strategyDir)
    .filter(f => f.endsWith('.md'))
    .sort();
  for (const f of rootFiles) {
    const result = await importFile(join(strategyDir, f), false);
    if (result) results.push(result);
  }

  // Feedback subdirectory
  console.log('\n── Feedback Files ──');
  const feedbackDir = join(strategyDir, 'Feedback');
  if (existsSync(feedbackDir)) {
    const feedbackFiles = readdirSync(feedbackDir)
      .filter(f => f.endsWith('.md'))
      .sort();
    for (const f of feedbackFiles) {
      const result = await importFile(join(feedbackDir, f), true);
      if (result) results.push(result);
    }
  }

  // OST file
  console.log('\n── Opportunity Solution Tree ──');
  const ostFile = join(KB, 'brain/discovery/opportunities/Opportunity Solution Tree.md');
  if (existsSync(ostFile)) {
    const result = await importFile(ostFile, false);
    if (result) results.push(result);
  }

  // Fetch existing problems for linking
  console.log('\n── Creating Strategy → Problem Links ──');
  const problemsRes = await fetch(
    `${SUPABASE_URL}/rest/v1/content?type=eq.problem&select=id,metadata&limit=100`,
    {
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      },
    }
  );
  const problems = await problemsRes.json();
  const problemIdToUuid = {};
  problems.forEach(p => {
    if (p.metadata?.problem_id) problemIdToUuid[p.metadata.problem_id] = p.id;
  });

  let problemLinksCreated = 0;
  for (const r of results) {
    if (r.problemRefs?.length && r.id) {
      for (const pid of r.problemRefs) {
        if (problemIdToUuid[pid]) {
          const ok = await createContentLink(r.id, problemIdToUuid[pid], 'related',
            `Strategy "${r.title}" references ${pid}`);
          if (ok) problemLinksCreated++;
        }
      }
    }
  }
  console.log(`  Created ${problemLinksCreated} strategy→problem links`);

  // Strategy → Strategy links
  console.log('\n── Creating Strategy → Strategy Links ──');
  const titleToUuid = {};
  results.forEach(r => { titleToUuid[r.title.toLowerCase()] = r.id; });

  let strategyLinksCreated = 0;
  for (const r of results) {
    if (r.relatedTitles?.length && r.id) {
      for (const relTitle of r.relatedTitles) {
        const targetId = titleToUuid[relTitle.toLowerCase()];
        if (targetId && targetId !== r.id) {
          const ok = await createContentLink(r.id, targetId, 'related',
            `${r.title} relates to ${relTitle}`);
          if (ok) strategyLinksCreated++;
        }
      }
    }
  }
  console.log(`  Created ${strategyLinksCreated} strategy→strategy links`);

  const created = results.filter(r => r?.action === 'created').length;
  const updated = results.filter(r => r?.action === 'updated').length;
  console.log(`\nDone. Created: ${created}, Updated: ${updated}`);
  console.log(`Problem links: ${problemLinksCreated}, Strategy links: ${strategyLinksCreated}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
