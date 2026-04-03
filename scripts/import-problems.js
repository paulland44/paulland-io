/**
 * Import problem definition files from the Obsidian knowledge base
 * into Supabase content table.
 *
 * Usage:
 *   source mcp-server/.env && node scripts/import-problems.js
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

// Priority and category mappings (extracted from Problems Index)
const PRIORITY_MAP = {
  'P1': 'High', 'P2': 'High', 'P3': 'High', 'P4': 'High',
  'P5': 'High', 'P6': 'High', 'P7': 'High', 'P8': 'High',
  'P9': 'High',
  'P10': 'Medium-High', 'P11': 'Medium-High', 'P12': 'Medium-High', 'P13': 'Medium-High',
  'P14': 'Medium', 'P15': 'Medium', 'P16': 'Medium', 'P17': 'Medium',
  'P18': 'Lower',
};

const CATEGORY_MAP = {
  'P1': 'Operational Efficiency', 'P2': 'Operational Efficiency',
  'P3': 'Operational Efficiency', 'P4': 'Operational Efficiency',
  'P5': 'Operational Efficiency', 'P6': 'Operational Efficiency',
  'P7': 'Operational Efficiency', 'P8': 'Operational Efficiency',
  'P9': 'Strategic/Competitive',
  'P10': 'Compliance & Risk',
  'P11': 'Foundational/Enabler', 'P12': 'Foundational/Enabler',
  'P13': 'Operational Efficiency', 'P14': 'Operational Efficiency',
  'P15': 'Operational Efficiency',
  'P16': 'Strategic/Competitive', 'P17': 'Strategic/Competitive',
  'P18': 'Compliance & Risk',
};

// ─── Helpers ─────────────────────────────────────────────────

function parseFrontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: text };
  const meta = {};
  const lines = match[1].split('\n');
  let currentKey = null;
  let inArray = false;

  for (const line of lines) {
    // Simple key: value
    const kv = line.match(/^(\w[\w-]*):\s*(.+)$/);
    if (kv) {
      const val = kv[2].replace(/^['"]|['"]$/g, '');
      meta[kv[1]] = val;
      currentKey = kv[1];
      inArray = false;
      continue;
    }
    // Key with empty value (start of array or object)
    const keyOnly = line.match(/^(\w[\w-]*):\s*$/);
    if (keyOnly) {
      currentKey = keyOnly[1];
      meta[currentKey] = [];
      inArray = true;
      continue;
    }
    // Array item
    if (inArray && currentKey && line.match(/^- /)) {
      const val = line.replace(/^- /, '').replace(/^['"]|['"]$/g, '').trim();
      if (!Array.isArray(meta[currentKey])) meta[currentKey] = [];
      meta[currentKey].push(val);
    }
  }
  return { meta, body: match[2] };
}

function cleanObsidianLinks(text) {
  // [[link|display]] → display
  text = text.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2');
  // [[link]] → link (strip path prefixes)
  text = text.replace(/\[\[(?:[^/\]]+\/)*([^\]]+)\]\]/g, '$1');
  return text;
}

function extractProblemId(meta, filename) {
  // From frontmatter id field
  if (meta.id) return meta.id;
  // From aliases array
  if (Array.isArray(meta.aliases)) {
    const pid = meta.aliases.find(a => /^P{1,2}\d+$/.test(a));
    if (pid) return pid;
  }
  // From filename
  const m = filename.match(/^(PP?\d+)/);
  if (m) return m[1];
  return null;
}

function extractRelatedProblems(body) {
  const related = [];
  // Look for "Related Problems" section
  const section = body.match(/## Related Problems[\s\S]*?(?=\n## |\n---|\n$)/i);
  if (section) {
    const matches = section[0].matchAll(/\b(PP?\d+)\b/g);
    for (const m of matches) {
      if (!related.includes(m[1])) related.push(m[1]);
    }
  }
  return related;
}

function extractAffectedPersonas(body) {
  const personas = [];
  const section = body.match(/## Affected Personas[\s\S]*?(?=\n## |\n---|\n$)/i);
  if (section) {
    const matches = section[0].matchAll(/[-*]\s+\*?\*?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/g);
    for (const m of matches) {
      if (!personas.includes(m[1])) personas.push(m[1]);
    }
  }
  return personas;
}

async function supabaseUpsert(record) {
  // Try to find existing record by title
  const existing = await fetch(
    `${SUPABASE_URL}/rest/v1/content?title=eq.${encodeURIComponent(record.title)}&type=eq.problem&select=id&limit=1`,
    {
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      },
    }
  );
  const rows = await existing.json();

  if (rows.length) {
    // Update existing
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
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Update failed ${res.status}: ${text}`);
    }
    return { id: rows[0].id, action: 'updated' };
  }

  // Insert new
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
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Insert failed ${res.status}: ${text}`);
  }
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
      body: JSON.stringify({
        source_id: sourceId,
        target_id: targetId,
        link_type: linkType,
        context,
      }),
    }
  );
  // Ignore unique constraint violations (already linked)
  if (!res.ok && res.status !== 409) {
    const text = await res.text();
    console.warn(`    Link warning: ${text.substring(0, 100)}`);
  }
}

// ─── Import ─────────────────────────────────────────────────

async function importProblemFile(filePath, domain) {
  const filename = basename(filePath, '.md');
  const raw = readFileSync(filePath, 'utf-8');
  const { meta, body } = parseFrontmatter(raw);
  const content = cleanObsidianLinks(body.trim());

  const problemId = extractProblemId(meta, filename);
  const isIndex = filename.includes('Index') || filename.includes('00_');
  const isStack = meta.type === 'problem-stack';

  const relatedProblems = extractRelatedProblems(content);
  const affectedPersonas = extractAffectedPersonas(content);

  // Build tags
  const tags = ['problem', 'discovery'];
  if (domain === 'phoenix') tags.push('phoenix');
  if (isStack) tags.push('webcenter-pack', 'converter-voice');
  if (Array.isArray(meta.tags)) {
    for (const t of meta.tags) {
      if (t && !tags.includes(t.toLowerCase())) tags.push(t.toLowerCase());
    }
  }

  // Determine problem_domain
  let problemDomain = domain;
  if (isIndex) problemDomain = 'index';
  if (isStack) problemDomain = 'stack';

  const record = {
    type: 'problem',
    title: meta.title || filename,
    body: content,
    tags,
    status: 'active',
    source_path: filePath.replace(KB + '/', ''),
    metadata: {
      problem_id: problemId,
      problem_domain: problemDomain,
      priority: PRIORITY_MAP[problemId] || (domain === 'phoenix' ? 'Medium' : null),
      category: CATEGORY_MAP[problemId] || null,
      related_problems: relatedProblems,
      affected_personas: affectedPersonas,
      is_index: isIndex,
      migrated_from: filePath.replace(KB + '/', ''),
      migrated: meta.migrated || new Date().toISOString(),
    },
  };

  try {
    const result = await supabaseUpsert(record);
    const label = problemId ? problemId.padEnd(5) : '     ';
    console.log(`  ${result.action === 'created' ? 'NEW' : 'UPD'}  ${label} ${record.title}`);
    return { ...result, problemId, relatedProblems, title: record.title };
  } catch (err) {
    console.error(`  ERR  ${filename}: ${err.message}`);
    return null;
  }
}

async function main() {
  const results = [];

  // Domain problems (P1-P18 + index)
  console.log('\n── Domain Problems ──');
  const domainDir = join(KB, 'brain/discovery/problems');
  const domainFiles = readdirSync(domainDir)
    .filter(f => f.endsWith('.md'))
    .sort();
  for (const f of domainFiles) {
    const result = await importProblemFile(join(domainDir, f), 'domain');
    if (result) results.push(result);
  }

  // Phoenix problems (PP1-PP10 + index)
  console.log('\n── Phoenix Problems ──');
  const phoenixDir = join(domainDir, 'phoenix');
  if (existsSync(phoenixDir)) {
    const phoenixFiles = readdirSync(phoenixDir)
      .filter(f => f.endsWith('.md'))
      .sort();
    for (const f of phoenixFiles) {
      const result = await importProblemFile(join(phoenixDir, f), 'phoenix');
      if (result) results.push(result);
    }
  }

  // Problem Stack
  console.log('\n── Problem Stack ──');
  const stackFile = join(KB, 'brain/reference/research/WCP_Discovery_Feb2026/Problem_Stack_Feb2026.md');
  if (existsSync(stackFile)) {
    const result = await importProblemFile(stackFile, 'domain');
    if (result) results.push(result);
  }

  // Create content_links for related problems
  console.log('\n── Creating Problem Cross-Links ──');
  const idToUuid = {};
  for (const r of results) {
    if (r.problemId) idToUuid[r.problemId] = r.id;
  }

  let linksCreated = 0;
  for (const r of results) {
    if (r.relatedProblems?.length && r.id) {
      for (const related of r.relatedProblems) {
        if (idToUuid[related] && idToUuid[related] !== r.id) {
          await createContentLink(r.id, idToUuid[related], 'related',
            `${r.problemId || r.title} relates to ${related}`);
          linksCreated++;
        }
      }
    }
  }
  console.log(`  Created ${linksCreated} cross-links`);

  const created = results.filter(r => r?.action === 'created').length;
  const updated = results.filter(r => r?.action === 'updated').length;
  console.log(`\nDone. Created: ${created}, Updated: ${updated}, Links: ${linksCreated}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
