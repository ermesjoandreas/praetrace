# Codemap — project context

## What this is

A local developer tool that visualises a codebase **live** while an AI coding agent
modifies it. The problem it solves: agent-driven coding moves faster than a human can
maintain a mental model of the codebase. This tool rebuilds that model continuously.

Runs entirely on localhost. Single user. No auth, no cloud, no multi-tenancy.

## Architecture — four layers

```
Agent / CLI  (Claude Code hooks, file system)
      ↓  events
Event collector  (HTTP + file watcher)
      ↓  file-changed notifications
Analysis / graph engine  (tree-sitter, worker threads)
      ↓  graph deltas
Live visualisation  (websocket → browser, Mermaid / React Flow)
```

Each layer talks to the next through a narrow interface. Do not let parsing logic
leak into the server layer, or rendering concerns into the graph engine.

## Stack

- **Language:** TypeScript everywhere. No Python, no Go, no Rust in application code.
- **Runtime:** Node.js
- **Parsing:** `tree-sitter` with `tree-sitter-typescript` grammar
- **Server:** Fastify (HTTP + websocket)
- **Frontend:** React + Vite, Mermaid for diagram rendering
- **Packaging:** Tauri — but NOT yet. See "Out of scope" below.

## Non-negotiable design decisions

These were decided deliberately. Do not change them without asking.

1. **Parsing runs in `worker_threads`, never on the main thread.**
   Set this up from the first commit even though it feels premature. The main
   process must never block while parsing, because the agent fires rapid
   consecutive edits.

2. **Parsing is incremental.** When a file changes, re-parse only that file and
   patch the graph. Never re-scan the whole project except on initial boot.

3. **The graph is the single source of truth.** It lives in one place, in memory,
   with a well-defined shape. Renderers read from it; they never derive their own
   structure from raw source files.

4. **Static analysis first, LLM second.** Class structure, imports, and call edges
   come from the AST — deterministic and fast. LLM inference is reserved for
   cross-file semantic dataflow, and is not part of the MVP at all.

## Graph model

Keep the node/edge shape stable and explicit. Roughly:

```ts
type NodeKind = 'file' | 'class' | 'function' | 'interface' | 'type';
type EdgeKind = 'imports' | 'extends' | 'implements' | 'calls' | 'contains';

interface GraphNode {
  id: string;          // stable: `${filePath}#${symbolName}`
  kind: NodeKind;
  name: string;
  filePath: string;
  range: { startLine: number; endLine: number };
}

interface GraphEdge {
  from: string;        // GraphNode id
  to: string;
  kind: EdgeKind;
}
```

Node IDs must be **stable across re-parses** so the frontend can diff and animate
rather than redraw everything.

## Event sources

Two, both feeding the same collector:

1. **Claude Code hooks** — configured in `.claude/settings.json`, matcher
   `Write|Edit|MultiEdit` on `PostToolUse`, POSTing the hook JSON to the local
   server. This is the primary source and the whole point of the tool.

2. **File watcher** (chokidar) — fallback so the tool also works when the developer
   edits by hand, or when using an agent other than Claude Code.

Both must converge on one internal event type. Do not build two parallel pipelines.

## MVP scope

Build exactly this, in this order:

1. Parse a directory of TypeScript files into the graph. CLI output only, no UI.
2. Render the graph as a static Mermaid class diagram in a browser page.
3. Add the file watcher + websocket so the diagram updates on save.
4. Add the Claude Code hook endpoint so events come from the agent.

Stop there. That is the MVP.

## Out of scope for MVP

Do not build these, do not scaffold for them, do not add dependencies for them:

- Tauri packaging or any desktop shell (comes after the engine works)
- Database / ER diagrams (Prisma, SQLAlchemy schema parsing)
- Infrastructure diagrams (docker-compose, Terraform, k8s)
- LLM-based dataflow inference
- Any language other than TypeScript
- Authentication, user accounts, hosted backend, multi-user anything
- Persistence — the graph is in-memory and rebuilt on boot

If a task seems to require one of these, stop and ask rather than building it.

## Conventions

- Strict TypeScript. No `any` without a comment explaining why.
- Small modules with one responsibility. The parser does not know about websockets.
- Prefer plain functions over classes unless there is real state to hold.
- No test framework ceremony in the MVP, but the graph engine must be pure enough
  to test later — keep I/O at the edges.
- Comments explain *why*, not *what*.

## Working style

- Make one coherent change at a time. Do not refactor unrelated code while
  implementing a feature.
- When a design decision is ambiguous, ask instead of guessing — this codebase is
  small enough that a wrong assumption is cheap to prevent and expensive to unwind.
- Explain what changed and why after each step.

---

# Current state

**MVP steps 1 and 2 are done.** Step 3 (file watcher + websocket) and step 4 (Claude
Code hook endpoint) are not started.

1. ✅ Parse a directory of TypeScript files into the graph. CLI output only.
2. ✅ Render the graph as a static Mermaid class diagram in a browser page.
3. ⬜ File watcher + websocket so the diagram updates on save.
4. ⬜ Claude Code hook endpoint.

## Running it

```bash
npm install          # .npmrc pins legacy-peer-deps, see "Dependency note"
npm run build        # tsc -> dist/, then copies the static page
npm run serve -- <dir>            # browser page on http://127.0.0.1:4400
npm run serve -- <dir> --port=5000
npm run codemap -- <dir>          # same graph as text
npm run codemap -- <dir> --json   # raw nodes + edges
npm run typecheck
```

## Layout

```
src/
  graph/          the graph engine — pure, no I/O
    types.ts      GraphNode / GraphEdge / Graph / GraphDelta
    resolve.ts    module specifier -> file, given the set of known files
    store.ts      holds parse results, derives the graph, emits deltas
  parser/         everything that knows about ASTs
    types.ts      ParsedFile / ParsedSymbol + worker message shapes
    extract.ts    tree-sitter -> ParsedFile (the only module using createRequire)
    worker.ts     worker_threads entry: reads a file, parses it, replies
    pool.ts       fixed pool of parser workers, one file at a time each
  project/        the project on disk; used by both the CLI and the server
    walk.ts       boot scan of a directory
    scan.ts       walk + parse everything through the pool
  render/
    mermaid.ts    Graph -> Mermaid class diagram source. Pure.
  cli/
    index.ts      arg handling + text/JSON output
  server/
    app.ts        Fastify routes
    main.ts       arg handling, boot scan, listen
    public/       the static page (copied to dist by scripts/copy-public.mjs)
```

## Decisions taken while building step 1

- **ESM with `createRequire`.** `tree-sitter` and its grammars are native CommonJS
  addons with no ESM entry point. `createRequire` is confined to `parser/extract.ts`;
  everything else is plain ESM.
- **Nodes are patched incrementally, edges are re-derived wholesale.** Only a
  changed file is re-parsed (decision 2 holds — parsing is the expensive part), but
  `derive()` rebuilds all nodes and edges from the stored `ParsedFile`s on every
  mutation. It is pure in-memory work with no AST and no I/O, and it means a newly
  added file can satisfy an import that failed to resolve earlier. Narrow it to
  indexed dependents only if a profile says to.
- **Top-level declarations only.** Class methods are not separate nodes; calls made
  inside a method attribute to the enclosing class.
- **Unresolvable references are dropped.** Bare specifiers (`react`, `node:fs`) and
  names that resolve to nothing produce no edge — the MVP graphs the project, not
  its dependencies. Name resolution is: own file first, then imported files.
- **`.d.ts` files are skipped** — they restate types the accompanying source declares.

## Decisions taken while building step 2

- **One box per file, not per class.** The diagram lists a file's symbols inside its
  box and lifts symbol-level `extends` / `implements` up to the owning files. A true
  class-per-box diagram would be empty on codebases like this one, which are almost
  all functions.
- **`calls` edges are not drawn.** At file granularity a call into another file is
  already implied by the import edge beside it; drawing both doubles the lines
  without adding information. They are still in the graph, and the CLI prints them.
- **No React or Vite yet.** The page is one hand-written HTML file served by Fastify,
  because step 2's deliverable is a single static diagram. React + Vite arrive when
  the UI actually needs component state. Step 3 hangs the websocket on this page.
- **No `@fastify/static`.** Two files (the page and the Mermaid bundle) do not need a
  plugin. The page is read per request, so it can be edited without a restart.
- **Mermaid is served from `node_modules`, not a CDN**, via `import.meta.resolve`, so
  the tool works offline. `dist/mermaid.min.js` is a single self-contained bundle
  that sets `globalThis.mermaid` — no chunk loading to serve.
- **The parser pool is closed after the boot scan.** Nothing re-parses yet. Step 3
  must keep it open for the watcher.

## Dependency note

`tree-sitter-typescript@0.23.2` declares a stale `peerOptional tree-sitter@^0.21.0`
while the current binding is `0.25.1`. The real constraint is the parser ABI, which
was verified to work. `.npmrc` sets `legacy-peer-deps=true` so `npm install` succeeds;
re-verify by parsing a file if either package is bumped.

## Verified

Step 1:

- Parses its own `src/` and a class/interface fixture: `extends`, `implements`,
  cross-file `calls`, `.js`→`.ts` specifier resolution, deduplicated import edges,
  self-edges dropped.
- Editing one file yields a delta touching only that file's nodes; ids in untouched
  files stay stable. Adding a file resolves a previously unresolvable import.
  Deleting a file removes its nodes and every edge into it.
- 360 parses through the pool block the main thread for 1.1 ms; the same work inline
  blocks it for 114 ms.

Step 2:

- Mermaid's own parser accepts the generated source for both this project and the
  inheritance fixture, and renders it to SVG. Checked headlessly by driving
  `mermaid.parse` / `mermaid.render` under jsdom — jsdom was installed *outside* the
  repo so it is not a project dependency.
- All three routes answer: `/` (html), `/api/diagram` (json), `/vendor/mermaid.min.js`
  (3.5 MB bundle, resolved through `import.meta.resolve`).

**Not verified:** how the diagram actually *looks*. jsdom has no text metrics, so
`getBBox` had to be stubbed and the resulting SVG geometry is meaningless. Layout,
spacing and legibility need a real browser.

## Known limitations

- A large project produces one enormous diagram. `maxTextSize` and `maxEdges` are
  raised in the page config, but there is no filtering, focus or depth limit yet —
  if this bites before step 3, that is the thing to add.
- Two symbols sharing a name in one file are disambiguated by document order
  (`path#name~2`), so their ids shift if their relative order changes. The only
  known crack in id stability.
