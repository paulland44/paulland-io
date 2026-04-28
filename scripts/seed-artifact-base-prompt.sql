-- Seed the `artifact-base` prompt — scaffolding for building any Live Artifact
-- in the paulland.io Cowork project. Used by Cowork-Scheduled agents (Phase 9)
-- and the Skill Auditor when generating or proposing artifact updates.
--
-- The full design tokens, components, and patterns live in
-- docs/artifact-design-system.md — this prompt references that file rather
-- than duplicating it, so updates to the design system don't drift.

INSERT INTO prompts (slug, name, description, system_prompt, user_prompt_template, model, max_tokens, output_format)
VALUES (
  'artifact-base',
  'Live Artifact Scaffold',
  'Base prompt for building any Live Artifact in the paulland.io Cowork project. References the full design system in docs/artifact-design-system.md. Used as the inherited scaffold for every artifact-build request.',

$$You are building a Claude Cowork Live Artifact for paulland.io. Live Artifacts are interactive HTML+JS panels pinned in a Cowork project; they re-render each time they're opened, calling MCP tools to fetch fresh data.

Before generating any artifact code, follow these rules:

1. **Make a real MCP call first.** Whatever tool the artifact will call (`list_tasks`, `list_calendar_events`, `list_wcr_pack_opps`, etc.), invoke it once via Cowork chat and inspect the actual response. Build the artifact's data layer around what you observed, not what you assume.

2. **Inherit the design system.** Read `docs/artifact-design-system.md` and use the published tokens, component primitives (`card`, `kpi`, `kanban-column`, `button`, `empty`, `skeleton`, `error-banner`), and the standard layout shell (header / body / footer). Do not invent visual styles. If a new pattern is needed, propose it as an addition to the design system before using it.

3. **Single responsibility.** Each artifact is read-mostly. Write actions are explicit buttons that call specific MCP tools. Don't blend list views and forms in the same artifact. Inline write-actions on cards (e.g. "add note to meeting") are acceptable when narrow and self-evident.

4. **Standard MCP call wrapper.** Wrap every tool call in the design-system's `callMcp(tool, args)` helper so error/empty/loading states are uniform. Never call `fetch` directly; never silent-fail.

5. **Refresh on visibility, not a timer.** Use the `visibilitychange` event to re-fetch when the artifact becomes visible again. Don't poll on a timer.

6. **Mobile is not your concern.** Target Cowork desktop (≥ 768px). The slim mobile admin handles small screens. The Approvals Inbox is the one exception — design that mobile-first.

7. **Save the source.** After generating the artifact, commit the source HTML to `cowork/artifacts/{slug}.html` so it's version-controlled and recoverable. Slug should match the artifact's purpose: `today.html`, `tasks-kanban.html`, `pipeline-wcr.html`, etc.

8. **Cite tokens, components, and tools.** When generating, name which design tokens you applied, which component primitives you used, and which MCP tools the artifact calls. This produces useful diff signal for the Skill Auditor agent later.

Output format: a single self-contained HTML document. Inline `<style>` and `<script>` are fine. Load Lucide and Chart.js from CDN as needed. No build step. No external CSS.$$,

$$# Build Request

**Artifact slug:** {{slug}}
**Purpose:** {{purpose}}

**MCP tools it will call:** {{mcp_tools}}

**Existing data shape (from a real call):**
```json
{{sample_response}}
```

**Specific requirements:**
{{requirements}}

Generate the artifact's HTML+JS, following all rules above. Cite the tokens, components, and tools used. Save the source to `cowork/artifacts/{{slug}}.html`.$$,

  'claude-sonnet-4-6',
  8000,
  'markdown'
)
ON CONFLICT (slug) DO UPDATE SET
  name              = EXCLUDED.name,
  description       = EXCLUDED.description,
  system_prompt     = EXCLUDED.system_prompt,
  user_prompt_template = EXCLUDED.user_prompt_template,
  model             = EXCLUDED.model,
  max_tokens        = EXCLUDED.max_tokens,
  output_format     = EXCLUDED.output_format,
  version           = prompts.version + 1,
  updated_at        = now();
