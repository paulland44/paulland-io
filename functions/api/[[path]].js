/**
 * Cloudflare Pages Function — API proxy for admin dashboard.
 *
 * Validates the Cloudflare Access JWT, then handles requests.
 * Writes go to Supabase via the service role key.
 * Calendar reads fetch from Outlook ICS feed.
 *
 * Routes:
 *   POST /api/content/tags     — Update tags on a content item
 *   POST /api/daily-notes      — Create or update a daily note (upsert by date)
 *   POST /api/daily-review     — AI end-of-day review (extract & distribute content)
 *   GET  /api/calendar-events  — Fetch calendar events for a date from ICS feed
 *   POST /api/entity-update    — Update any entity (people, products, projects)
 *   POST /api/entity-log       — Add a log entry (people_log, project_updates)
 *   POST /api/generate-summary — AI weekly/monthly summary generation
 *   POST /api/assets/upload    — Upload file to R2 + create metadata in Supabase
 *   GET  /api/assets/file/:key — Serve file from R2
 *   DELETE /api/assets/:id     — Delete asset from R2 + Supabase
 */

export async function onRequest(context) {
  const { request, env } = context;

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: corsHeaders(),
    });
  }

  // Validate Cloudflare Access JWT
  const authResult = await validateAccessJWT(request, env);
  if (!authResult.valid) {
    return json({ error: 'Unauthorized', detail: authResult.reason }, 401);
  }

  // Route to handler
  const url = new URL(request.url);
  const path = url.pathname.replace('/api/', '');

  // List R2 bucket objects — GET /api/assets/r2-list
  if (request.method === 'GET' && path === 'assets/r2-list') {
    return handleR2List(env);
  }

  // Asset file serving — GET /api/assets/file/...
  if (request.method === 'GET' && path.startsWith('assets/file/')) {
    const r2Key = path.replace('assets/file/', '');
    return handleAssetServe(r2Key, env);
  }

  // Asset deletion — DELETE /api/assets/:id
  if (request.method === 'DELETE' && path.startsWith('assets/')) {
    const assetId = path.replace('assets/', '');
    return handleAssetDelete(assetId, env);
  }

  if (request.method === 'GET') {
    switch (path) {
      case 'calendar-events':
        return handleCalendarEvents(request, env);
      default:
        return json({ error: 'Not found' }, 404);
    }
  }

  if (request.method === 'POST') {
    switch (path) {
      case 'content/tags':
        return handleUpdateTags(request, env);
      case 'daily-notes':
        return handleUpsertDailyNote(request, env);
      case 'daily-review':
        return handleDailyReview(request, env);
      case 'entity-update':
        return handleEntityUpdate(request, env);
      case 'entity-log':
        return handleEntityLog(request, env);
      case 'generate-summary':
        return handleGenerateSummary(request, env);
      case 'assets/upload':
        return handleAssetUpload(request, env);
      default:
        return json({ error: 'Not found' }, 404);
    }
  }

  return json({ error: 'Method not allowed' }, 405);
}

// ─── Handlers ────────────────────────────────────────────────

async function handleUpdateTags(request, env) {
  const { id, tags } = await request.json();

  if (!id || !Array.isArray(tags)) {
    return json({ error: 'Missing id or tags array' }, 400);
  }

  // Sanitise tags
  const cleanTags = tags
    .map(t => String(t).trim().toLowerCase())
    .filter(t => t.length > 0);

  const supabaseUrl = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !serviceKey) {
    return json({ error: 'Server misconfigured' }, 500);
  }

  // Update via Supabase REST API
  const res = await fetch(
    `${supabaseUrl}/rest/v1/content?id=eq.${id}`,
    {
      method: 'PATCH',
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({ tags: cleanTags }),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    return json({ error: 'Supabase error', detail: text }, res.status);
  }

  return json({ ok: true, tags: cleanTags });
}

async function handleEntityUpdate(request, env) {
  const { table, id, updates } = await request.json();

  const allowedTables = ['people', 'products', 'projects', 'summaries', 'assets', 'companies'];
  if (!table || !allowedTables.includes(table)) {
    return json({ error: 'Invalid table. Must be one of: ' + allowedTables.join(', ') }, 400);
  }
  if (!id) {
    return json({ error: 'Missing id' }, 400);
  }
  if (!updates || typeof updates !== 'object') {
    return json({ error: 'Missing updates object' }, 400);
  }

  const supabaseUrl = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !serviceKey) {
    return json({ error: 'Server misconfigured' }, 500);
  }

  const res = await fetch(
    `${supabaseUrl}/rest/v1/${table}?id=eq.${id}`,
    {
      method: 'PATCH',
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify(updates),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    return json({ error: 'Supabase error', detail: text }, res.status);
  }

  return json({ ok: true });
}

async function handleEntityLog(request, env) {
  const { table, data } = await request.json();

  const allowedTables = ['people_log', 'project_updates', 'companies'];
  if (!table || !allowedTables.includes(table)) {
    return json({ error: 'Invalid table. Must be one of: ' + allowedTables.join(', ') }, 400);
  }
  if (!data || typeof data !== 'object') {
    return json({ error: 'Missing data object' }, 400);
  }

  const supabaseUrl = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !serviceKey) {
    return json({ error: 'Server misconfigured' }, 500);
  }

  const res = await fetch(
    `${supabaseUrl}/rest/v1/${table}`,
    {
      method: 'POST',
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify(data),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    return json({ error: 'Supabase error', detail: text }, res.status);
  }

  return json({ ok: true });
}

async function handleUpsertDailyNote(request, env) {
  const { note_date, tasks, notes, meetings, metadata } = await request.json();

  if (!note_date || !/^\d{4}-\d{2}-\d{2}$/.test(note_date)) {
    return json({ error: 'Invalid or missing note_date (YYYY-MM-DD)' }, 400);
  }

  const supabaseUrl = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !serviceKey) {
    return json({ error: 'Server misconfigured' }, 500);
  }

  const body = {
    note_date,
    tasks: tasks ?? '',
    notes: notes ?? '',
    meetings: meetings ?? '',
  };

  // Merge metadata if provided (preserves existing keys)
  if (metadata && typeof metadata === 'object') {
    body.metadata = metadata;
  }

  // Upsert via PostgREST — merge-duplicates resolves on the unique note_date constraint
  const res = await fetch(
    `${supabaseUrl}/rest/v1/daily_notes?on_conflict=note_date`,
    {
      method: 'POST',
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=representation',
      },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    return json({ error: 'Supabase error', detail: text }, res.status);
  }

  const data = await res.json();
  return json({ ok: true, daily_note: data[0] });
}

// ─── AI Summary Generation ───────────────────────────────────

async function handleGenerateSummary(request, env) {
  const { type, period_start, period_end, context_data } = await request.json();

  if (!type || !['weekly', 'monthly'].includes(type)) {
    return json({ error: 'type must be "weekly" or "monthly"' }, 400);
  }
  if (!period_start || !period_end) {
    return json({ error: 'Missing period_start or period_end' }, 400);
  }
  if (!context_data || typeof context_data !== 'string' || context_data.length < 50) {
    return json({ error: 'context_data must be a substantial text string' }, 400);
  }

  const supabaseUrl = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_KEY;
  const anthropicKey = env.ANTHROPIC_API_KEY;

  if (!supabaseUrl || !serviceKey) {
    return json({ error: 'Server misconfigured (Supabase)' }, 500);
  }
  if (!anthropicKey) {
    return json({ error: 'ANTHROPIC_API_KEY not configured' }, 500);
  }

  const systemPrompt = type === 'weekly'
    ? buildWeeklySummaryPrompt()
    : buildMonthlySummaryPrompt();

  // Call Claude API
  let summaryContent;
  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 8000,
        system: systemPrompt,
        messages: [{ role: 'user', content: context_data }],
      }),
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      return json({ error: 'Claude API error', status: claudeRes.status, detail: errText }, 502);
    }

    const claudeData = await claudeRes.json();
    summaryContent = claudeData.content?.[0]?.text || '';

    if (!summaryContent) {
      return json({ error: 'Empty response from Claude' }, 500);
    }
  } catch (err) {
    return json({ error: 'AI processing failed', detail: err.message }, 500);
  }

  // Upsert to summaries table
  const summaryData = {
    type,
    period_start,
    period_end,
    content: summaryContent,
    metadata: {
      generated_at: new Date().toISOString(),
      model: 'claude-sonnet-4-20250514',
      context_length: context_data.length,
    },
  };

  const upsertRes = await fetch(
    `${supabaseUrl}/rest/v1/summaries?on_conflict=type,period_start`,
    {
      method: 'POST',
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=representation',
      },
      body: JSON.stringify(summaryData),
    }
  );

  if (!upsertRes.ok) {
    const errText = await upsertRes.text();
    return json({ error: 'Failed to save summary', detail: errText }, 500);
  }

  const saved = await upsertRes.json();

  // Create audit record (best-effort, don't fail the request)
  try {
    await supabasePost(supabaseUrl, serviceKey, 'ai_reviews', {
      review_type: type,
      source_date: period_start,
      status: 'completed',
      input_snapshot: { period_start, period_end, context_length: context_data.length },
      output_summary: summaryContent.substring(0, 500),
      completed_at: new Date().toISOString(),
    });
  } catch (e) { /* audit is non-critical */ }

  return json({ ok: true, summary: saved[0] || summaryData });
}

function buildWeeklySummaryPrompt() {
  return `You are Paul Land's weekly review assistant. Paul is a Domain Lead (Packaging Job Lifecycle) and Product Manager (WebCenter Pack) at Esko.

Your job is to synthesise his week's daily notes, entity data, and AI daily review summaries into a comprehensive weekly summary written in **markdown**.

Write the summary as a coach and peer — direct but fair, acknowledging what worked, challenging assumptions, and asking coaching questions where appropriate.

## Output Sections (use these exact headings)

### Highlights
3-4 key accomplishments or significant events of the week. Bold the most impactful.

### Meetings & Interactions
Organised by day (Monday through Friday). For each day, list key meetings with attendees and outcomes. Include a **Customer Interactions** subsection if relevant.

### Domain Work (Packaging Job Lifecycle)
Strategic and operational progress on the domain. Include health indicators where evident.

### Product Work (WebCenter Pack)
Product delivery, decisions, customer feedback, and roadmap progress.

### Decisions Made
A markdown table with columns: Date | Decision | Context | Impact

### Blockers & Risks
Current blockers and emerging risks. Flag anything unresolved from previous weeks.

### Learnings
Key things learned this week — technical, strategic, or interpersonal.

### Tasks Completed
Summary of completed tasks. Group by theme if many.

### Leadership & Development
- **Reflection Summary**: Themes from daily reflections
- **Team Coaching**: Observations about direct reports and team dynamics
- **Coach's Check-in**: 2-3 coaching questions for Paul to consider

### Carry Forward
Open tasks and commitments that need attention next week.

### Next Week Focus
1-3 priorities for the coming week based on this week's outcomes.

## Guidelines
- Write in third person ("Paul" not "you") for the factual sections
- Use second person ("you") only in the Coach's Check-in
- Be concise but thorough — this replaces reading all the daily notes
- Include specific names, dates, and outcomes where available
- If data is sparse for a section, note it briefly rather than padding
- Output ONLY the markdown content — no preamble or wrapper`;
}

function buildMonthlySummaryPrompt() {
  return `You are Paul Land's monthly review assistant. Paul is a Domain Lead (Packaging Job Lifecycle) and Product Manager (WebCenter Pack) at Esko.

Your job is to synthesise weekly summaries (or daily notes if weeklies aren't available) into a strategic monthly review written in **markdown**.

Write with a coaching lens — direct, fair, and forward-looking.

## Output Sections (use these exact headings)

### Month at a Glance
4-5 bullet narrative of the month's key themes. Bold the most significant. This should read as an executive summary.

### Strategic Progress
Split into **Domain (Packaging Job Lifecycle)** and **Product (WebCenter Pack)** subsections. Include:
- Health status and trends (improving/stable/declining)
- Key milestones reached
- Strategic decisions and their implications

### Key Decisions
A markdown table with columns: Date | Decision | Impact | Stakeholders

### Patterns & Observations
Recurring themes, blockers that persisted across weeks, learning patterns, and behaviour trends.

### Customer & Stakeholder Pulse
Customer interactions, feedback themes, escalations, and relationship health.

### Team & People
Development focus for direct reports, team dynamics, delegation progress, and coaching observations.

### Leadership Development Review
- **Reflection Themes**: Patterns from weekly reflections
- **Experiments**: What was tried differently this month
- **Coaching Perspective**: 3-4 strategic coaching questions for the month ahead

### Next Month Focus
Top priorities and strategic intentions for the coming month.

## Guidelines
- Write in third person ("Paul") for factual sections
- Use second person ("you") only in Coaching Perspective
- Synthesise and elevate — don't just concatenate weekly summaries
- Highlight trends and patterns over individual events
- Be honest about gaps or areas lacking progress
- Output ONLY the markdown content — no preamble or wrapper`;
}

// ─── AI Daily Review ─────────────────────────────────────────

async function handleDailyReview(request, env) {
  const { note_date } = await request.json();

  if (!note_date || !/^\d{4}-\d{2}-\d{2}$/.test(note_date)) {
    return json({ error: 'Invalid or missing note_date' }, 400);
  }

  const supabaseUrl = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_KEY;
  const anthropicKey = env.ANTHROPIC_API_KEY;

  if (!supabaseUrl || !serviceKey) {
    return json({ error: 'Server misconfigured (Supabase)' }, 500);
  }
  if (!anthropicKey) {
    return json({ error: 'ANTHROPIC_API_KEY not configured' }, 500);
  }

  // 1. Fetch the daily note
  const noteRes = await supabaseGet(supabaseUrl, serviceKey,
    `daily_notes?note_date=eq.${note_date}&limit=1`);
  if (!noteRes.length) {
    return json({ error: 'No daily note found for this date' }, 404);
  }
  const dailyNote = noteRes[0];

  // 2. Fetch context: people, products, projects
  const [peopleRes, productsRes, projectsRes] = await Promise.all([
    supabaseGet(supabaseUrl, serviceKey, 'people?select=id,name,role,organization&order=name'),
    supabaseGet(supabaseUrl, serviceKey, 'products?select=id,name&order=name'),
    supabaseGet(supabaseUrl, serviceKey, 'projects?select=id,name,product_id&order=name'),
  ]);

  const peopleNames = peopleRes.map(p => p.name);
  const productNames = productsRes.map(p => p.name);
  const projectNames = projectsRes.map(p => p.name);

  // 3. Build the prompt
  const systemPrompt = buildReviewSystemPrompt(peopleNames, productNames, projectNames);
  const userPrompt = buildReviewUserPrompt(dailyNote, note_date);

  // 4. Call Claude API
  let aiResult;
  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 8000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      return json({ error: 'Claude API error', status: claudeRes.status, detail: errText }, 502);
    }

    const claudeData = await claudeRes.json();
    const responseText = claudeData.content?.[0]?.text || '';

    // Extract JSON from response (may be wrapped in ```json blocks)
    const jsonMatch = responseText.match(/```json\s*([\s\S]*?)```/) ||
                      responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return json({ error: 'Could not parse AI response', raw: responseText.substring(0, 2000) }, 500);
    }

    aiResult = JSON.parse(jsonMatch[1] || jsonMatch[0]);
  } catch (err) {
    return json({ error: 'AI processing failed', detail: err.message }, 500);
  }

  // 5. Write results to Supabase
  const writeResults = await writeReviewResults(supabaseUrl, serviceKey, note_date, dailyNote, aiResult, peopleRes, productsRes, projectsRes);

  // 6. Create audit record
  await supabasePost(supabaseUrl, serviceKey, 'ai_reviews', {
    review_type: 'daily',
    source_date: note_date,
    status: 'completed',
    input_snapshot: { tasks: dailyNote.tasks, notes: dailyNote.notes, meetings: dailyNote.meetings },
    output_summary: aiResult.review_summary || '',
    files_updated: writeResults,
    completed_at: new Date().toISOString(),
  });

  // 7. Update daily note metadata with review results (store full review for persistence)
  const existingMeta = dailyNote.metadata || {};
  await supabasePatch(supabaseUrl, serviceKey,
    `daily_notes?note_date=eq.${note_date}`, {
      metadata: {
        ...existingMeta,
        last_reviewed: new Date().toISOString(),
        review_summary: aiResult.review_summary || '',
        migrated_tasks: aiResult.migrated_tasks || [],
        context_notes: aiResult.context_notes || [],
        review_data: aiResult,
        review_writes: writeResults,
      },
    });

  // 8. Migrate tasks to next day
  let tasksMigrated = 0;
  const migratedTasks = aiResult.migrated_tasks || [];
  if (migratedTasks.length > 0) {
    // Calculate next day
    const d = new Date(note_date + 'T12:00:00Z');
    d.setDate(d.getDate() + 1);
    const nextDate = d.toISOString().split('T')[0];

    // Fetch existing next-day note (if any)
    const nextNotes = await supabaseGet(supabaseUrl, serviceKey,
      `daily_notes?note_date=eq.${nextDate}&limit=1`);
    const nextNote = nextNotes.length ? nextNotes[0] : null;

    // Build migrated tasks markdown
    const migratedMd = migratedTasks.map(t => `- [ ] ${t}`).join('\n');
    const header = `## Tasks (migrated from ${note_date})\n`;

    let newTasks = '';
    if (nextNote && nextNote.tasks && nextNote.tasks.trim()) {
      // Append migrated tasks to existing tasks (avoid duplicates)
      const existingLower = nextNote.tasks.toLowerCase();
      const uniqueTasks = migratedTasks.filter(t =>
        !existingLower.includes(t.toLowerCase().substring(0, 30))
      );
      if (uniqueTasks.length > 0) {
        const uniqueMd = uniqueTasks.map(t => `- [ ] ${t}`).join('\n');
        newTasks = nextNote.tasks + '\n\n' + header + uniqueMd;
        tasksMigrated = uniqueTasks.length;
      }
    } else {
      // Create new tasks section
      newTasks = header + migratedMd;
      tasksMigrated = migratedTasks.length;
    }

    if (tasksMigrated > 0) {
      // Upsert next day's note with migrated tasks
      const upsertBody = {
        note_date: nextDate,
        tasks: newTasks,
        notes: nextNote?.notes || '',
        meetings: nextNote?.meetings || '',
      };

      await fetch(
        `${supabaseUrl}/rest/v1/daily_notes?on_conflict=note_date`,
        {
          method: 'POST',
          headers: {
            'apikey': serviceKey,
            'Authorization': `Bearer ${serviceKey}`,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates,return=minimal',
          },
          body: JSON.stringify(upsertBody),
        }
      );
    }

    // 9. Mark migrated tasks as [>] on the source day
    let updatedTasks = dailyNote.tasks || '';
    for (const task of migratedTasks) {
      // Find the task line with [ ] and change to [>]
      // Match on the first 40 chars of the task text to handle slight variations
      const searchText = task.substring(0, Math.min(40, task.length)).toLowerCase();
      const lines = updatedTasks.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes('- [ ]') && line.toLowerCase().includes(searchText)) {
          lines[i] = line.replace('- [ ]', '- [>]');
          break;
        }
      }
      updatedTasks = lines.join('\n');
    }

    // Update the source day's tasks
    if (updatedTasks !== dailyNote.tasks) {
      await supabasePatch(supabaseUrl, serviceKey,
        `daily_notes?note_date=eq.${note_date}`, {
          tasks: updatedTasks,
        });
    }
  }

  return json({
    ok: true,
    review: aiResult,
    writes: { ...writeResults, tasks_migrated: tasksMigrated },
  });
}

function buildReviewSystemPrompt(peopleNames, productNames, projectNames) {
  return `You are Paul Land's end-of-day review assistant. Paul is a Domain Lead (Packaging Job Lifecycle) and Product Manager (WebCenter Pack) at Esko.

Your job is to process his daily note and extract structured information into a JSON response. You must identify:

1. **People entries**: Notes about specific people from meetings and notes sections ONLY. Do NOT extract people entries from tasks — tasks are action items, not observations. Only extract people entries when there is a genuine observation, decision, or insight about that person from a meeting or note.
2. **Product evidence**: Evidence, learnings, or feedback about specific products.
3. **Product decisions**: Decisions made about products (strategic, not tactical).
4. **Project updates**: Updates about specific projects.
5. **Reflections**: Leadership observations, coaching insights, self-awareness moments.
6. **Migrated tasks**: Tasks marked [>] or still open [ ] that should carry forward to tomorrow.
7. **Context notes**: Key context from today that would help prepare for tomorrow's meetings.

## Known People
${peopleNames.join(', ')}

## Known Products
${productNames.join(', ')}

## Known Projects
${projectNames.join(', ')}

## Task Notation
- \`[ ]\` = open (not done)
- \`[x]\` = done
- \`[>]\` = migrated (carry forward)
- \`[-]\` = cancelled

## Reflection Detection
Look for reflective language: "I noticed", "I should have", "lesson learned", "in hindsight", "next time", coaching observations about team members, leadership moments, and self-awareness. Paul writes naturally without tags — you must identify reflective content by reading comprehension.

For each reflection, write a brief coach's perspective: validate what worked, challenge assumptions, and ask 1-2 coaching questions. Be direct but fair — a peer-level coach, not a critic.

## Output Format
Respond with ONLY a JSON object (no markdown wrapping, no explanation) with this structure:

{
  "people_entries": [
    { "person_name": "Exact Name", "entry": "What was discussed/observed about this person" }
  ],
  "product_evidence": [
    { "product_name": "Exact Product", "evidence": "The evidence/learning", "evidence_type": "customer_feedback|metric|decision|observation" }
  ],
  "product_decisions": [
    { "product_name": "Exact Product", "decision": "The decision", "context": "Why/how it was decided" }
  ],
  "project_updates": [
    { "project_name": "Exact Project", "update": "What happened with this project today" }
  ],
  "reflections": [
    { "observation": "The reflection/insight", "coach_perspective": "Brief coaching response", "category": "leadership|coaching|personal" }
  ],
  "migrated_tasks": [
    "Task text to carry forward"
  ],
  "context_notes": [
    { "meeting_title": "Meeting name", "context": "Key context for tomorrow" }
  ],
  "review_summary": "2-3 sentence summary of the day's key outcomes and themes"
}

IMPORTANT:
- Only include entries where there is genuine content to extract. Empty arrays are fine.
- Match person/product/project names EXACTLY to the known lists above. If unsure, use the closest match.
- For people entries, focus on actionable notes: decisions, action items, observations about the person's work.
- Keep entries concise but complete. Each entry should stand on its own without needing the daily note for context.
- The review_summary should capture the day's themes, not list every meeting.
- CRITICAL: Do NOT create people entries from tasks. Tasks like "Follow up with X" or "Speak to Y about Z" are action items, not observations. People entries should ONLY come from actual meeting notes, conversations, or written observations.`;
}

function buildReviewUserPrompt(dailyNote, noteDate) {
  let prompt = `## Daily Note for ${noteDate}\n\n`;

  if (dailyNote.tasks) {
    prompt += `### Tasks\n${dailyNote.tasks}\n\n`;
  }
  if (dailyNote.notes) {
    prompt += `### Notes & Thoughts\n${dailyNote.notes}\n\n`;
  }
  if (dailyNote.meetings) {
    prompt += `### Meetings & Conversations\n${dailyNote.meetings}\n\n`;
  }

  // Include structured meeting data if available
  const structured = dailyNote.metadata?.meetings_structured;
  if (structured && structured.length > 0) {
    prompt += `### Meeting Details (structured)\n`;
    for (const m of structured) {
      prompt += `#### ${m.title || 'Untitled Meeting'}${m.time ? ` (${m.time})` : ''}\n`;
      prompt += `${m.notes || '(no notes)'}\n\n`;
    }
  }

  // Include stoic challenge if present
  const stoic = dailyNote.metadata?.stoic_challenge;
  if (stoic && (stoic.frustration || stoic.reframe || stoic.opportunity)) {
    prompt += `### Stoic Challenge\n`;
    if (stoic.frustration) prompt += `**Frustration:** ${stoic.frustration}\n`;
    if (stoic.reframe) prompt += `**Reframe:** ${stoic.reframe}\n`;
    if (stoic.opportunity) prompt += `**Opportunity:** ${stoic.opportunity}\n`;
    prompt += '\n';
  }

  prompt += `\nPlease process this daily note and extract all relevant information into the JSON format specified in your instructions.`;
  return prompt;
}

async function writeReviewResults(supabaseUrl, serviceKey, noteDate, dailyNote, aiResult, people, products, projects) {
  const results = { people_log: 0, product_evidence: 0, product_decisions: 0, project_updates: 0, reflections: 0 };

  // Build lookup maps
  const peopleMap = {};
  people.forEach(p => { peopleMap[p.name.toLowerCase()] = p.id; });
  const productMap = {};
  products.forEach(p => { productMap[p.name.toLowerCase()] = p.id; });
  const projectMap = {};
  projects.forEach(p => { projectMap[p.name.toLowerCase()] = p.id; });

  const sourceRef = { daily_note_date: noteDate };

  // Write people log entries
  for (const entry of (aiResult.people_entries || [])) {
    const personId = peopleMap[entry.person_name?.toLowerCase()];
    if (!personId || !entry.entry) continue;
    await supabasePost(supabaseUrl, serviceKey, 'people_log', {
      person_id: personId,
      note_date: noteDate,
      entry: entry.entry,
      source: 'daily_review',
      source_ref: sourceRef,
    });
    results.people_log++;
  }

  // Write product evidence
  for (const entry of (aiResult.product_evidence || [])) {
    const productId = productMap[entry.product_name?.toLowerCase()];
    if (!productId || !entry.evidence) continue;
    await supabasePost(supabaseUrl, serviceKey, 'product_evidence', {
      product_id: productId,
      note_date: noteDate,
      evidence: entry.evidence,
      evidence_type: entry.evidence_type || 'observation',
      source_ref: sourceRef,
    });
    results.product_evidence++;
  }

  // Write product decisions
  for (const entry of (aiResult.product_decisions || [])) {
    const productId = productMap[entry.product_name?.toLowerCase()];
    if (!entry.decision) continue;
    await supabasePost(supabaseUrl, serviceKey, 'product_decisions', {
      product_id: productId || null,
      note_date: noteDate,
      decision: entry.decision,
      context: entry.context || '',
      source_ref: sourceRef,
    });
    results.product_decisions++;
  }

  // Write project updates
  for (const entry of (aiResult.project_updates || [])) {
    const projectId = projectMap[entry.project_name?.toLowerCase()];
    if (!projectId || !entry.update) continue;
    await supabasePost(supabaseUrl, serviceKey, 'project_updates', {
      project_id: projectId,
      note_date: noteDate,
      update_text: entry.update,
      source_ref: sourceRef,
    });
    results.project_updates++;
  }

  // Write reflections
  for (const entry of (aiResult.reflections || [])) {
    if (!entry.observation) continue;
    // Try to match a person if the reflection is about someone
    let personId = null;
    if (entry.category === 'coaching') {
      for (const [name, id] of Object.entries(peopleMap)) {
        if (entry.observation.toLowerCase().includes(name)) {
          personId = id;
          break;
        }
      }
    }
    await supabasePost(supabaseUrl, serviceKey, 'reflections_log', {
      note_date: noteDate,
      observation: entry.observation,
      coach_perspective: entry.coach_perspective || '',
      category: entry.category || 'leadership',
      person_id: personId,
      source_ref: sourceRef,
    });
    results.reflections++;
  }

  return results;
}

// ─── Asset Management (R2 + Supabase) ────────────────────────

async function handleR2List(env) {
  const bucket = env.ASSETS_BUCKET;
  if (!bucket) return json({ error: 'R2 bucket not configured' }, 500);

  const listed = await bucket.list({ limit: 500 });
  const objects = (listed.objects || []).map(obj => ({
    key: obj.key,
    size: obj.size,
    uploaded: obj.uploaded,
    httpMetadata: obj.httpMetadata,
    customMetadata: obj.customMetadata,
  }));

  return json({ ok: true, objects, truncated: listed.truncated });
}

async function handleAssetUpload(request, env) {
  const bucket = env.ASSETS_BUCKET;
  if (!bucket) return json({ error: 'R2 bucket not configured' }, 500);

  const supabaseUrl = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_KEY;

  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('multipart/form-data')) {
    return json({ error: 'Expected multipart/form-data' }, 400);
  }

  const formData = await request.formData();
  const file = formData.get('file');
  if (!file || !(file instanceof File)) {
    return json({ error: 'No file provided' }, 400);
  }

  const tags = formData.get('tags') || '';
  const description = formData.get('description') || '';

  // Generate a unique R2 key: YYYY/MM/uuid-filename
  const now = new Date();
  const prefix = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}`;
  const uuid = crypto.randomUUID();
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const r2Key = `${prefix}/${uuid}-${safeName}`;

  // Upload to R2
  const arrayBuffer = await file.arrayBuffer();
  await bucket.put(r2Key, arrayBuffer, {
    httpMetadata: { contentType: file.type },
    customMetadata: { originalName: file.name },
  });

  // Store metadata in Supabase
  const tagArray = tags ? tags.split(',').map(t => t.trim()).filter(Boolean) : [];
  const assetData = {
    filename: file.name,
    r2_key: r2Key,
    mime_type: file.type || 'application/octet-stream',
    file_size: file.size,
    tags: tagArray,
    description: description,
    uploaded_at: now.toISOString(),
    metadata: {},
  };

  const insertRes = await fetch(`${supabaseUrl}/rest/v1/assets`, {
    method: 'POST',
    headers: {
      'apikey': serviceKey,
      'Authorization': `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    },
    body: JSON.stringify(assetData),
  });

  if (!insertRes.ok) {
    const err = await insertRes.text();
    // Clean up R2 on metadata failure
    await bucket.delete(r2Key);
    return json({ error: 'Failed to save asset metadata', detail: err }, 500);
  }

  const saved = await insertRes.json();
  return json({ ok: true, asset: saved[0] });
}

async function handleAssetServe(r2Key, env) {
  const bucket = env.ASSETS_BUCKET;
  if (!bucket) return json({ error: 'R2 bucket not configured' }, 500);

  const object = await bucket.get(r2Key);
  if (!object) return json({ error: 'File not found' }, 404);

  const headers = new Headers();
  headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
  headers.set('Content-Length', object.size);
  headers.set('Cache-Control', 'private, max-age=3600');

  // For images and PDFs, display inline; others download
  const ct = object.httpMetadata?.contentType || '';
  if (ct.startsWith('image/') || ct === 'application/pdf') {
    headers.set('Content-Disposition', 'inline');
  } else {
    const name = object.customMetadata?.originalName || r2Key.split('/').pop();
    headers.set('Content-Disposition', `attachment; filename="${name}"`);
  }

  return new Response(object.body, { headers });
}

async function handleAssetDelete(assetId, env) {
  const bucket = env.ASSETS_BUCKET;
  if (!bucket) return json({ error: 'R2 bucket not configured' }, 500);

  const supabaseUrl = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_KEY;

  // Fetch the asset to get the R2 key
  const assets = await supabaseGet(supabaseUrl, serviceKey, `assets?id=eq.${assetId}&select=id,r2_key`);
  if (!assets.length) return json({ error: 'Asset not found' }, 404);

  const r2Key = assets[0].r2_key;

  // Delete from R2
  await bucket.delete(r2Key);

  // Delete from Supabase
  await fetch(`${supabaseUrl}/rest/v1/assets?id=eq.${assetId}`, {
    method: 'DELETE',
    headers: {
      'apikey': serviceKey,
      'Authorization': `Bearer ${serviceKey}`,
    },
  });

  return json({ ok: true });
}

// ─── Supabase helpers ────────────────────────────────────────

async function supabaseGet(url, key, path) {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
    },
  });
  if (!res.ok) return [];
  return res.json();
}

async function supabasePost(url, key, table, data) {
  return fetch(`${url}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(data),
  });
}

async function supabasePatch(url, key, path, data) {
  return fetch(`${url}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(data),
  });
}

// ─── Calendar events ─────────────────────────────────────────

async function handleCalendarEvents(request, env) {
  const icsUrl = env.OUTLOOK_ICS_URL;
  if (!icsUrl) {
    return json({ error: 'Calendar not configured' }, 500);
  }

  const url = new URL(request.url);
  const dateStr = url.searchParams.get('date');
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return json({ error: 'Missing or invalid date parameter (YYYY-MM-DD)' }, 400);
  }

  try {
    // Fetch the ICS feed — minimal headers to avoid Outlook/Exchange blocks
    const icsRes = await fetch(icsUrl);

    if (!icsRes.ok) {
      const body = await icsRes.text().catch(() => '');
      return json({
        error: 'Failed to fetch calendar',
        status: icsRes.status,
        statusText: icsRes.statusText,
        detail: body.substring(0, 500),
        url_configured: !!icsUrl,
      }, 502);
    }

    const icsText = await icsRes.text();
    const events = parseICSForDate(icsText, dateStr);

    return json({ ok: true, date: dateStr, events });
  } catch (err) {
    return json({ error: 'Calendar fetch failed', detail: err.message }, 500);
  }
}

/**
 * Parse ICS text and return events for a specific date.
 * Handles DTSTART/DTEND in various formats, SUMMARY, LOCATION, ATTENDEE, ORGANIZER.
 */
function parseICSForDate(icsText, dateStr) {
  const events = [];
  const targetDate = dateStr.replace(/-/g, ''); // '20260318'

  // Split into VEVENT blocks
  const eventBlocks = icsText.split('BEGIN:VEVENT');

  for (let i = 1; i < eventBlocks.length; i++) {
    const block = eventBlocks[i].split('END:VEVENT')[0];
    if (!block) continue;

    // Unfold long lines (RFC 5545: lines starting with space/tab are continuations)
    const unfolded = block.replace(/\r?\n[ \t]/g, '');

    const lines = unfolded.split(/\r?\n/);
    const props = {};
    const attendees = [];

    for (const line of lines) {
      // Handle DTSTART and DTEND (may have params like TZID)
      if (line.startsWith('DTSTART')) {
        props.dtstart = extractDateTimeValue(line);
      } else if (line.startsWith('DTEND')) {
        props.dtend = extractDateTimeValue(line);
      } else if (line.startsWith('SUMMARY:')) {
        props.summary = line.substring(8).trim();
      } else if (line.startsWith('LOCATION:')) {
        props.location = line.substring(9).trim();
      } else if (line.startsWith('ORGANIZER')) {
        const cn = extractParam(line, 'CN');
        const email = extractMailto(line);
        props.organizer = cn || email || '';
      } else if (line.startsWith('ATTENDEE')) {
        const cn = extractParam(line, 'CN');
        const email = extractMailto(line);
        if (cn || email) attendees.push(cn || email);
      } else if (line.startsWith('STATUS:')) {
        props.status = line.substring(7).trim();
      } else if (line.startsWith('UID:')) {
        props.uid = line.substring(4).trim();
      } else if (line.startsWith('RECURRENCE-ID')) {
        props.recurrenceId = extractDateTimeValue(line);
      } else if (line.startsWith('RRULE:')) {
        props.rrule = line.substring(6).trim();
      }
    }

    // Skip cancelled events
    if (props.status === 'CANCELLED') continue;

    // Check if event falls on target date
    if (!props.dtstart) continue;

    const startDate = props.dtstart.dateOnly; // YYYYMMDD
    const endDate = props.dtend?.dateOnly || startDate;

    // Handle all-day events (no time component)
    const isAllDay = props.dtstart.allDay;

    // Check date match — event starts on target date, or spans across it
    let matches = false;
    if (startDate === targetDate) {
      matches = true;
    } else if (startDate < targetDate && endDate > targetDate) {
      matches = true; // Multi-day event spanning this date
    }

    // Handle recurring events (basic daily/weekly/monthly)
    if (!matches && props.rrule) {
      matches = checkRecurrence(props.rrule, startDate, targetDate);
    }

    if (!matches) continue;

    events.push({
      uid: props.uid || '',
      title: props.summary || 'Untitled Event',
      startTime: props.dtstart.time || '',
      endTime: props.dtend?.time || '',
      allDay: isAllDay,
      location: props.location || '',
      organizer: props.organizer || '',
      attendees: attendees.slice(0, 20), // Limit to prevent huge payloads
    });
  }

  // Sort by start time
  events.sort((a, b) => (a.startTime || '0000').localeCompare(b.startTime || '0000'));

  return events;
}

function extractDateTimeValue(line) {
  // DTSTART;TZID=Romance Standard Time:20260318T110000
  // DTSTART;TZID=Europe/London:20260318T100000
  // DTSTART:20260318T100000Z
  // DTSTART;VALUE=DATE:20260318
  //
  // The colon separator can appear inside TZID values (e.g. "Standard Time:"),
  // so we find the date value by matching a date pattern after the last colon,
  // or use the last colon as separator.

  // Find the date value — always 8+ digits, possibly followed by T and time
  const dateMatch = line.match(/(\d{8})(T\d{6}Z?)?$/);
  if (!dateMatch) return null;

  const rawValue = dateMatch[0];
  const params = line.substring(0, line.lastIndexOf(rawValue));

  const allDay = params.includes('VALUE=DATE') || rawValue.length === 8;
  const dateOnly = rawValue.substring(0, 8); // YYYYMMDD

  let time = '';
  if (!allDay && rawValue.length >= 15) {
    // Extract HH:MM from THHMMSS
    time = rawValue.substring(9, 11) + ':' + rawValue.substring(11, 13);
  }

  return { dateOnly, time, allDay, raw: rawValue };
}

function extractParam(line, paramName) {
  const regex = new RegExp(paramName + '=([^;:]+)', 'i');
  const match = line.match(regex);
  if (match) {
    let val = match[1].trim();
    // Remove quotes if present
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    return val;
  }
  return null;
}

function extractMailto(line) {
  const match = line.match(/mailto:([^\s;]+)/i);
  return match ? match[1].trim() : null;
}

function checkRecurrence(rrule, startDateStr, targetDateStr) {
  // Basic recurrence check for common patterns
  // startDateStr and targetDateStr are YYYYMMDD strings
  const start = parseDateStr(startDateStr);
  const target = parseDateStr(targetDateStr);
  if (!start || !target || target < start) return false;

  const parts = {};
  rrule.split(';').forEach(p => {
    const [k, v] = p.split('=');
    parts[k] = v;
  });

  const freq = parts.FREQ;
  if (!freq) return false;

  // Check UNTIL if present
  if (parts.UNTIL) {
    const untilDate = parts.UNTIL.substring(0, 8);
    if (targetDateStr > untilDate) return false;
  }

  // Check COUNT — skip for now (would need full expansion)

  const diffDays = Math.round((target - start) / (1000 * 60 * 60 * 24));
  const interval = parseInt(parts.INTERVAL || '1');

  switch (freq) {
    case 'DAILY':
      return diffDays % interval === 0;
    case 'WEEKLY': {
      if (parts.BYDAY) {
        const dayMap = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
        const targetDay = target.getDay();
        const days = parts.BYDAY.split(',').map(d => dayMap[d.trim()]);
        if (!days.includes(targetDay)) return false;
      }
      const diffWeeks = Math.floor(diffDays / 7);
      return diffWeeks % interval === 0 || diffDays % (7 * interval) < 7;
    }
    case 'MONTHLY': {
      const sameDay = start.getDate() === target.getDate();
      const monthDiff = (target.getFullYear() - start.getFullYear()) * 12 + target.getMonth() - start.getMonth();
      return sameDay && monthDiff % interval === 0;
    }
    case 'YEARLY': {
      const sameMonthDay = start.getMonth() === target.getMonth() && start.getDate() === target.getDate();
      const yearDiff = target.getFullYear() - start.getFullYear();
      return sameMonthDay && yearDiff % interval === 0;
    }
    default:
      return false;
  }
}

function parseDateStr(str) {
  // YYYYMMDD -> Date
  if (str.length < 8) return null;
  const y = parseInt(str.substring(0, 4));
  const m = parseInt(str.substring(4, 6)) - 1;
  const d = parseInt(str.substring(6, 8));
  return new Date(y, m, d);
}

// ─── JWT validation ──────────────────────────────────────────

async function validateAccessJWT(request, env) {
  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN;
  const aud = env.CF_ACCESS_AUD;

  if (!teamDomain || !aud) {
    return { valid: false, reason: 'Access not configured' };
  }

  // Get the JWT from cookie or header
  const cookie = request.headers.get('Cookie') || '';
  const cfAuth = cookie.split(';').map(c => c.trim()).find(c => c.startsWith('CF_Authorization='));
  const token = cfAuth ? cfAuth.split('=')[1] : request.headers.get('Cf-Access-Jwt-Assertion');

  if (!token) {
    return { valid: false, reason: 'No token found' };
  }

  try {
    // Fetch the public keys from Cloudflare Access
    const certsUrl = `https://${teamDomain}/cdn-cgi/access/certs`;
    const certsRes = await fetch(certsUrl);
    if (!certsRes.ok) {
      return { valid: false, reason: 'Failed to fetch certs' };
    }
    const { keys } = await certsRes.json();

    // Decode the JWT header to find the right key
    const parts = token.split('.');
    if (parts.length !== 3) {
      return { valid: false, reason: 'Malformed token' };
    }

    const header = JSON.parse(atob(parts[0].replace(/-/g, '+').replace(/_/g, '/')));
    const kid = header.kid;

    const key = keys.find(k => k.kid === kid);
    if (!key) {
      return { valid: false, reason: 'Key not found' };
    }

    // Import the public key
    const cryptoKey = await crypto.subtle.importKey(
      'jwk',
      key,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    );

    // Verify the signature
    const signatureBytes = Uint8Array.from(atob(parts[2].replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const dataBytes = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);

    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      cryptoKey,
      signatureBytes,
      dataBytes
    );

    if (!valid) {
      return { valid: false, reason: 'Invalid signature' };
    }

    // Check claims
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    const now = Math.floor(Date.now() / 1000);

    if (payload.exp && payload.exp < now) {
      return { valid: false, reason: 'Token expired' };
    }

    if (payload.aud && !payload.aud.includes(aud)) {
      return { valid: false, reason: 'Audience mismatch' };
    }

    return { valid: true, email: payload.email };
  } catch (err) {
    return { valid: false, reason: `Validation error: ${err.message}` };
  }
}

// ─── Helpers ─────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(),
      'Content-Type': 'application/json',
    },
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
