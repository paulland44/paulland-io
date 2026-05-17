# Live Artifact Design System (v0)

**Status:** v0 — minimal, just enough to ship Today + Tasks artifacts.
**To extract from Phase 2–3 outputs into v1.**

This document codifies the visual, structural, and behavioural patterns shared across all Live Artifacts in the paulland.io Cowork project. It mirrors the `v2_tokens.css` system used by the admin app so Live Artifacts feel visually continuous with the slim mobile admin.

---

## 1. Design tokens

Every artifact should inline these tokens at the top of its `<style>` block. Two themes (dark default, light optional). Five accents (sage default).

```css
:root,
[data-theme="dark"] {
  /* Surfaces */
  --bg:       #0E0E13;
  --surface:  #1C1C25;
  --card:     #2A2933;
  --card-hi:  #353441;

  /* Text */
  --text:     #ECE6D6;
  --text-2:   #B8AE96;
  --text-3:   #807865;
  --text-4:   #5A5448;

  /* Lines */
  --border:        rgba(236, 230, 214, 0.08);
  --border-hover:  rgba(236, 230, 214, 0.16);
  --divider:       rgba(236, 230, 214, 0.06);

  /* Hover / press */
  --hover: rgba(236, 230, 214, 0.04);
  --press: rgba(236, 230, 214, 0.08);

  /* Accent (sage default) */
  --accent:        #5BB088;
  --accent-hover:  #6FC09A;
  --accent-soft:   rgba(91, 176, 136, 0.14);
  --accent-text:   #5BB088;
  --on-accent:     #0E0E13;

  /* Semantic */
  --info:    #6BA3E8;
  --warn:    #E0B560;
  --danger:  #E37070;
  --success: var(--accent);

  /* Shadows */
  --shadow-sm: 0 1px 2px rgba(0,0,0,0.32);
  --shadow-md: 0 6px 18px rgba(0,0,0,0.36);
  --shadow-lg: 0 18px 48px rgba(0,0,0,0.45);

  /* Type */
  --sans: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  --mono: 'Inconsolata', 'SF Mono', Menlo, monospace;

  /* Radii */
  --r-sm: 4px;
  --r-md: 6px;
  --r-lg: 10px;
  --r-pill: 999px;

  /* Spacing — 4px grid */
  --s1: 4px;  --s2: 8px;  --s3: 12px; --s4: 16px;
  --s5: 20px; --s6: 24px; --s8: 32px; --s10: 40px; --s12: 48px;
}

[data-theme="light"] {
  --bg:       #FAF8F3;
  --surface:  #F2EFE7;
  --card:     #FFFFFF;
  --card-hi:  #F6F3EC;
  --text:     #1A1A22;
  --text-2:   #4A4A55;
  --text-3:   #767582;
  --text-4:   #B5B3AE;
  --border:        rgba(26, 26, 34, 0.10);
  --border-hover:  rgba(26, 26, 34, 0.20);
  --divider:       rgba(26, 26, 34, 0.06);
  --hover: rgba(26, 26, 34, 0.04);
  --press: rgba(26, 26, 34, 0.08);
  --accent:       #2F7A58;
  --accent-hover: #266547;
  --accent-soft:  rgba(47, 122, 88, 0.10);
  --accent-text:  #2F7A58;
  --on-accent:    #FFFFFF;
  --shadow-sm: 0 1px 2px rgba(20, 20, 30, 0.06);
  --shadow-md: 0 4px 14px rgba(20, 20, 30, 0.08);
  --shadow-lg: 0 16px 40px rgba(20, 20, 30, 0.14);
}
```

**Fonts:** Inter (sans), Inconsolata (mono). Load via Google Fonts at top of artifact.

**Accent variants** (apply `data-accent="gold|ocean|ember|violet"`): see `admin/v2_tokens.css` for exact values; mirror those when needed.

---

## 2. Layout shell

Every artifact follows the same three-region layout:

```
┌──────────────────────────────────────────────────┐
│  HEADER  — title, period nav, filter slot       │
├──────────────────────────────────────────────────┤
│  BODY    — content (cards / kanban / charts)    │
├──────────────────────────────────────────────────┤
│  FOOTER  — bulk actions, sync status (optional) │
└──────────────────────────────────────────────────┘
```

```html
<div class="artifact">
  <header class="artifact-header">
    <h1>Today</h1>
    <div class="artifact-filters"><!-- period picker, filter chips --></div>
  </header>
  <main class="artifact-body"><!-- content --></main>
  <footer class="artifact-footer"><!-- optional --></footer>
</div>

<style>
  body { background: var(--bg); color: var(--text); font-family: var(--sans); margin: 0; }
  .artifact { max-width: 1200px; margin: 0 auto; padding: var(--s6); }
  .artifact-header {
    display: flex; align-items: center; justify-content: space-between;
    padding-bottom: var(--s4); border-bottom: 1px solid var(--border);
    margin-bottom: var(--s6);
  }
  .artifact-header h1 { font-size: 1.5rem; font-weight: 600; }
  .artifact-body { display: grid; gap: var(--s6); }
</style>
```

---

## 3. Component primitives (v0 set)

### 3.1 Card

```html
<div class="card">
  <div class="card-header">
    <h3>Title</h3>
    <span class="card-meta">2026-04-28</span>
  </div>
  <div class="card-body">Content</div>
</div>

<style>
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    padding: var(--s4);
    transition: background 0.15s, border-color 0.15s;
  }
  .card:hover { background: var(--card-hi); border-color: var(--border-hover); }
  .card-header {
    display: flex; align-items: baseline; justify-content: space-between;
    margin-bottom: var(--s3);
  }
  .card-header h3 { font-size: 0.95rem; font-weight: 600; color: var(--text); }
  .card-meta { font-size: 0.75rem; color: var(--text-3); font-family: var(--mono); }
  .card-body { color: var(--text-2); font-size: 0.875rem; line-height: 1.55; }
</style>
```

### 3.2 KPI tile

```html
<div class="kpi">
  <div class="kpi-label">Pipeline value</div>
  <div class="kpi-value">£2.4M</div>
  <div class="kpi-delta positive">+£180K vs last week</div>
</div>

<style>
  .kpi {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    padding: var(--s4) var(--s5);
  }
  .kpi-label { font-size: 0.75rem; color: var(--text-3); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: var(--s2); }
  .kpi-value { font-size: 1.75rem; font-weight: 600; color: var(--text); font-family: var(--mono); }
  .kpi-delta { font-size: 0.8rem; margin-top: var(--s1); color: var(--text-3); }
  .kpi-delta.positive { color: var(--success); }
  .kpi-delta.negative { color: var(--danger); }
</style>
```

### 3.3 Kanban column

```html
<div class="kanban">
  <div class="kanban-col" data-status="open">
    <div class="kanban-col-header">
      <span>Open</span>
      <span class="kanban-count">7</span>
    </div>
    <div class="kanban-col-body"><!-- cards --></div>
  </div>
  <!-- more columns -->
</div>

<style>
  .kanban { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: var(--s4); }
  .kanban-col { background: var(--surface); border-radius: var(--r-md); padding: var(--s3); min-height: 200px; }
  .kanban-col-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: var(--s2) var(--s2) var(--s3); font-size: 0.875rem; font-weight: 500;
    color: var(--text-2); text-transform: uppercase; letter-spacing: 0.04em;
  }
  .kanban-count { font-family: var(--mono); color: var(--text-3); font-size: 0.75rem; }
  .kanban-col-body { display: flex; flex-direction: column; gap: var(--s2); }
</style>
```

### 3.4 Button

```html
<button class="btn">Cancel</button>
<button class="btn btn-primary">Synthesise</button>
<button class="btn btn-danger">Delete</button>

<style>
  .btn {
    appearance: none; cursor: pointer; font-family: var(--sans);
    background: transparent; color: var(--text-2);
    border: 1px solid var(--border); border-radius: var(--r-sm);
    padding: var(--s2) var(--s4); font-size: 0.875rem; font-weight: 500;
    transition: background 0.15s, border-color 0.15s, color 0.15s;
  }
  .btn:hover { background: var(--hover); border-color: var(--border-hover); color: var(--text); }
  .btn-primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
  .btn-primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
  .btn-danger { color: var(--danger); border-color: var(--border); }
  .btn-danger:hover { background: rgba(227, 112, 112, 0.08); border-color: var(--danger); color: var(--danger); }
</style>
```

### 3.5 Empty state

```html
<div class="empty">
  <i data-lucide="inbox"></i>
  <h3>Nothing here yet</h3>
  <p>When you capture your first thought, it'll appear here.</p>
</div>

<style>
  .empty {
    display: flex; flex-direction: column; align-items: center; gap: var(--s3);
    padding: var(--s12) var(--s6); text-align: center; color: var(--text-3);
  }
  .empty i { width: 32px; height: 32px; opacity: 0.6; }
  .empty h3 { font-size: 1rem; font-weight: 500; color: var(--text-2); }
  .empty p { font-size: 0.875rem; max-width: 320px; line-height: 1.5; }
</style>
```

### 3.6 Loading skeleton

```html
<div class="skeleton skeleton-card"></div>

<style>
  .skeleton {
    background: linear-gradient(90deg, var(--card) 0%, var(--card-hi) 50%, var(--card) 100%);
    background-size: 200% 100%;
    animation: shimmer 1.4s infinite linear;
    border-radius: var(--r-md);
  }
  .skeleton-card { height: 80px; }
  @keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
</style>
```

### 3.7 Error banner

```html
<div class="error-banner" role="alert">
  <i data-lucide="alert-triangle"></i>
  <span>Couldn't load tasks: network error</span>
  <button class="btn" onclick="retry()">Retry</button>
</div>

<style>
  .error-banner {
    display: flex; align-items: center; gap: var(--s3);
    background: rgba(227, 112, 112, 0.08);
    border: 1px solid rgba(227, 112, 112, 0.24);
    color: var(--danger);
    padding: var(--s3) var(--s4);
    border-radius: var(--r-md);
    margin-bottom: var(--s4);
  }
  .error-banner i { width: 18px; height: 18px; flex-shrink: 0; }
  .error-banner span { flex: 1; font-size: 0.875rem; }
</style>
```

### 3.8 WYSIWYG editor (Tiptap-based) — added v0.1

For any free-form note authoring (daily Notes & Thoughts, per-meeting notes, Stoic Challenge fields), use a Tiptap WYSIWYG editor that **preserves pasted formatting** and serialises to markdown on save. A plain `<textarea>` was tried in v2/v3 of the Today artifact; it failed because users paste structured content (Copilot meeting recaps, AI summaries) and need to see the bullets/headings/bold rendered immediately rather than as raw markdown.

**Required behaviour:**

- Paste from Copilot/Word/web preserves headings, bullet lists, numbered lists, bold, italic, links
- Inline toolbar: **B**, *I*, H1, H2, H3, bullet list, ordered list, blockquote, link, code (matches admin)
- Save format is markdown (portable, parseable by `daily_review_extract`, embeddable)
- Load reads markdown back into the editor

**Library choice — Tiptap.** Same as the previous admin. ProseMirror under the hood; mature; well-documented. Loaded as ES modules from `esm.sh` (no bundler needed):

```html
<script type="module">
  import { Editor } from 'https://esm.sh/@tiptap/core@2';
  import StarterKit from 'https://esm.sh/@tiptap/starter-kit@2';
  import { Markdown } from 'https://esm.sh/tiptap-markdown@0.8';

  const editor = new Editor({
    element: document.querySelector('#editor'),
    extensions: [StarterKit, Markdown],
    content: '',  // initial markdown loaded with editor.commands.setContent(md)
  });

  // Save: editor.storage.markdown.getMarkdown()
  // Load: editor.commands.setContent(markdownString)
</script>
```

**Toolbar wiring** (each button calls a Tiptap command):

```js
boldBtn.onclick   = () => editor.chain().focus().toggleBold().run();
italicBtn.onclick = () => editor.chain().focus().toggleItalic().run();
h1Btn.onclick     = () => editor.chain().focus().toggleHeading({ level: 1 }).run();
bulletBtn.onclick = () => editor.chain().focus().toggleBulletList().run();
// ...
```

**Styling:** the editor's content area inherits the design tokens. Apply:

```css
.tiptap-editor {
  min-height: 160px;
  padding: var(--s3) var(--s4);
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  font-family: var(--sans);
  font-size: 0.95rem;
  line-height: 1.55;
  color: var(--text);
}
.tiptap-editor:focus-within { border-color: var(--border-hover); }
.tiptap-editor h1 { font-size: 1.4rem; font-weight: 600; margin: var(--s3) 0 var(--s2); }
.tiptap-editor h2 { font-size: 1.15rem; font-weight: 600; margin: var(--s3) 0 var(--s2); }
.tiptap-editor h3 { font-size: 1rem; font-weight: 600; margin: var(--s3) 0 var(--s2); }
.tiptap-editor ul, .tiptap-editor ol { padding-left: var(--s5); margin: var(--s2) 0; }
.tiptap-editor li { margin: var(--s1) 0; }
.tiptap-editor strong { font-weight: 600; }
.tiptap-editor em { font-style: italic; }
.tiptap-editor a { color: var(--accent-text); text-decoration: underline; }
.tiptap-editor blockquote {
  border-left: 3px solid var(--border);
  padding-left: var(--s4);
  color: var(--text-2);
  margin: var(--s3) 0;
}
.tiptap-editor code {
  font-family: var(--mono);
  font-size: 0.875em;
  background: var(--press);
  padding: 2px 4px;
  border-radius: var(--r-sm);
}
```

**Why not just a `<textarea>` + Marked preview pane?** Considered. The split-view "source on left, rendered on right" pattern adds visual complexity without solving the *paste* problem — pasted content arrives as plain text in a textarea, formatting stripped. Tiptap captures the rich-text clipboard payload natively. The cost of Tiptap (~80 KB across ESM imports, lazily loaded) is acceptable given the workflow value.

**Required attribution row** (small, beneath each editor): `Saves as markdown` — sets correct expectations about portability.

---

## 4. Standard interactions

### 4.1 MCP call wrapper

Every artifact uses this pattern. **Never call `fetch` directly in artifact code.**

```js
async function callMcp(tool, args = {}) {
  // In Cowork artifacts, MCP tools are exposed via window.claude.callTool()
  // (verify exact API surface during Phase 1 spike)
  try {
    const result = await window.claude.callTool(tool, args);
    return { ok: true, data: result };
  } catch (err) {
    console.error(`MCP call failed: ${tool}`, err);
    return { ok: false, error: err.message || 'Unknown error' };
  }
}

// Standard usage with state handling:
async function loadTasks() {
  setLoading(true);
  const { ok, data, error } = await callMcp('list_tasks', { status: 'open' });
  setLoading(false);
  if (!ok) return showError(error);
  if (data.length === 0) return showEmpty();
  renderTasks(data);
}
```

### 4.2 Period picker

Standard shape: today / 7d / 30d / 90d / custom. Component spec to be drafted in Phase 6 when first dashboard ships.

### 4.3 Multi-select toolbar

Floating bar appears at bottom when ≥1 card selected. Shows count + actions (Synthesise, Tag, Delete).
Component spec to be drafted in Phase 4 (Reflections) and Phase 8 (Signals).

---

## 5. Library choices

| Need | Library | Notes |
|---|---|---|
| Charts | **Chart.js v4** | Already in admin; load via CDN |
| Icons | **Lucide** | Already in admin; load via CDN; call `lucide.createIcons()` after DOM updates |
| Markdown rendering (read-only) | **Marked** | For rendering saved markdown to HTML in display contexts |
| Markdown editing (WYSIWYG) | **Tiptap** (`@tiptap/core`, `@tiptap/starter-kit`, `tiptap-markdown`) | For all free-form note editing — see §3.8. Load as ES modules from `esm.sh`. |
| Framework | **Vanilla JS** | Avoid React/Vue; artifacts are small enough. Tiptap doesn't require a framework. |
| Date handling | **Native `Intl.DateTimeFormat`** | No moment.js / date-fns unless complexity demands |

CDN block to inline at top of every artifact:

```html
<script src="https://unpkg.com/lucide@latest"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
<!-- only if rendering markdown: -->
<!-- <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script> -->
```

---

## 6. Mobile

**Don't bother.** Cowork desktop is the primary surface; the slim mobile admin handles phone usage.

- Design for ≥ 768px width
- Below 640px, accept that the artifact may not render well — that's what mobile slim admin is for
- One exception: Approvals Inbox should render on phone (it's a glance + tap workflow), so design that one mobile-first

---

## 7. Behavioural patterns

### 7.1 Always make a real MCP call first

Before generating artifact code, invoke the MCP tool once via Cowork chat. Inspect the actual response shape. Build the artifact's data layer around what you observed. **Never trust a schema doc; verify with a real call.**

### 7.2 Single responsibility

Each artifact is read-mostly. Write actions are explicit buttons calling specific MCP tools. Don't blend list views and forms in the same artifact.

Exception: short inline inputs (e.g. "add note" on a meeting card) are acceptable — they're write-actions with a single, narrow scope.

### 7.3 Fail visibly

If an MCP call fails, render the error banner (3.7) above the body. Never silent-fail. Never log-only.

### 7.4 Refresh on visibility, not on a timer

When the artifact becomes visible again, re-fetch. Don't poll on a timer — Cowork handles the open/close cycle for you.

```js
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh();
});
```

### 7.5 Save artifact source to repo

After Cowork generates an artifact, **commit the source HTML to `cowork/artifacts/{slug}.html`**. This gives you version control, recovery, and a reference for the Skill Auditor agent later.

---

## 8. Version log

| Version | Date | Changes |
|---|---|---|
| v0 | 2026-04-28 | Initial draft. Tokens mirror `admin/v2_tokens.css`. Component primitives: card, kpi, kanban-column, button, empty, skeleton, error-banner. To be refined into v1 after Phase 2–3 ships. |
| v0.1 | 2026-04-29 | Added §3.8 WYSIWYG editor primitive (Tiptap) after Today artifact v3 paste-from-Copilot UX failed with plain `<textarea>`. Library choices table now permits Tiptap via `esm.sh`. The "vanilla JS, no framework" rule still holds — Tiptap is non-framework. New patterns from Today v3 (markdown-editor block, task-group with sections) deferred to v1. |
