# Codemap — project context

## What this is

A local developer tool that visualises a codebase **live** while an AI coding agent
modifies it. The problem it solves: agent-driven coding moves faster than a human can
maintain a mental model of the codebase. This tool rebuilds that model continuously.

Runs entirely on localhost. Single user. No auth, no cloud, no multi-tenancy.

Where the product is going is in [VISION.md](VISION.md). That file is the
destination; this one is the current sprint. When they disagree, this one wins.

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
- **Frontend:** React + Vite, React Flow for diagram rendering (was Mermaid; see Current state)
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

**The MVP is complete. All four steps are done.**

1. ✅ Parse a directory of TypeScript files into the graph. CLI output only.
2. ✅ Render the graph in a browser page — React Flow, with a view layer so the
   page never draws the whole project at once.
3. ✅ File watcher + websocket: the page updates as files change.
4. ✅ Claude Code hook endpoint, so events come from the agent itself.

Per the scope above, this is where the MVP stops. Anything further is a phase in
[VISION.md](VISION.md) and should be picked deliberately, not drifted into.

## Running it

```bash
npm install          # .npmrc pins legacy-peer-deps, see "Dependency note"
npm run build        # tsc -> dist/, then vite -> dist/web
npm run serve -- <dir>            # http://127.0.0.1:4400, watches for changes
npm run serve -- <dir> --port=5000
npm run dev:web                   # vite dev server, proxies /api to a running serve
npm run codemap -- <dir>          # the same graph as text
npm run codemap -- <dir> --json   # raw nodes + edges
npm run typecheck                 # checks src/ and web/

node scripts/prepare-sidecar.mjs  # once: builds the Node sidecar binary
npm run tauri dev                 # the desktop app
npm run tauri build               # bundled app
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
  project/        the project on disk, and everything that changes it
    walk.ts       boot scan + the ignore/source predicates everything shares
    scan.ts       walk + parse everything through the pool
    watch.ts      chokidar; emits raw changes, does not batch
    hook.ts       a Claude Code PostToolUse payload -> the same FileChange
    updater.ts    the one pipeline: coalesce, parse, patch, publish
  view/           which slice of the graph to draw — pure
    types.ts      ViewSpec / ViewGraph
    select.ts     selectView(graph, spec) -> ViewGraph
  cli/
    index.ts      arg handling + text/JSON output
  server/
    session.ts    one project: store, pool, watcher, updater. Swapped whole
    app.ts        Fastify: static web build, /api/view, /api/project, /api/hook, /live
    live.ts       connected clients and their view specs; pushes per client
    main.ts       boot scan, wiring, listen
web/              the browser page (Vite, built into dist/web)
  src/App.tsx     URL <-> view, live updates, breadcrumb, focus and depth
  src/BoxNode.tsx one box: a file with its symbols, or a folder
  src/ProjectMenu.tsx  folder picker and recents; desktop only
  src/layout.ts   dagre layout; React Flow does not place nodes itself
  src/api.ts      fetch + the shared ViewGraph type, imported from src/view
.claude/
  settings.json   the PostToolUse hook, committed so the repo dogfoods itself
```

## Event sources

Two sources, one pipeline. Both build the same `FileChange` and queue it into
`createUpdater`, which coalesces, re-parses and publishes. Nothing downstream can
tell them apart, which is the point.

```
Claude Code PostToolUse hook  ──► POST /api/hook ──┐
                                                   ├──► updater ──► graph ──► clients
chokidar watcher ──────────────────────────────────┘
```

- **The hook is primary.** The agent says what it changed, at the moment it
  changes it.
- **The watcher is the fallback**, for hand edits and other agents. It emits raw
  events and does no batching of its own — coalescing belongs to the updater, or
  the two sources would debounce independently and the same edit would land
  twice.
- `.claude/settings.json` posts the hook payload with `curl ... || true` and a
  2 second timeout. **A hook must never fail the agent's tool call**, so every
  response is 200, including for payloads the endpoint cannot use.
- The hook's URL hard-codes port 4400. Running the server on another port means
  the hook silently misses and only the watcher feeds the graph.

## Desktop shell (phase D, in progress)

Items 1-3 are done: the Tauri shell exists, it owns a Node sidecar on an
OS-assigned port, and the project is chosen at runtime. Items 4-6 (hook
installation, editor deep links, local persistence) are not started.

```
Tauri shell (Rust — process lifecycle, nothing else)
  ├── spawns the Node sidecar, reads its port from stdout
  ├── exposes get_server_port() to the webview
  └── webview → the same React page the browser serves
                  ↓ HTTP + websocket on the OS-assigned port
      Node sidecar — dist/server/main.js, unchanged in substance
```

**The server is not bundled into a single executable.** Node SEA on Node 24 runs
CommonJS only and this app is ESM throughout; it also cannot spawn a worker from
its own blob, which is exactly what `parser/pool.ts` does, and it cannot see
tree-sitter's native addon because node-gyp-build resolves it with a runtime
filesystem scan. A working SEA was built during research, but only by rewriting
third-party package internals that `npm install` overwrites. pkg is archived.

Instead `scripts/prepare-sidecar.mjs` produces a real Node binary from the one
running the script — thinned with `lipo` and ad-hoc signed, or macOS SIGKILLs it
— and the app's own `dist/` ships beside it as a Tauri resource. Both hard
constraints stop being constraints: worker_threads loads a real sibling file, and
the addons are found exactly as in development. The binary is 111 MB, generated
rather than committed, and gitignored.

**Switching projects opens a new session, it does not reset the old one.**
`server/session.ts` owns everything root-scoped — the store, the parser pool, the
watcher, the updater. A switch builds the next session, swaps it in, then closes
the previous one, so nothing is shared and nothing can leak. The alternative was
a `reset()` on each of six modules, every one an opportunity to forget something.

Switches are serialised, and the new session is built before the old one is torn
down: a root that turns out not to exist leaves the current project serving.
Clients are told through a `project` message rather than an `update`, because
every spec they hold names a path in the project just left; the page clears its
URL when it arrives.

**Recent projects are a JSON file** in the app config directory, written by Rust.
Item 6 introduces SQLite for window state and per-project settings, designed
around the session history that phase 1 of VISION.md will need. A list of paths
is not a reason to improvise that schema early. On launch the app opens the most
recent directory that still exists; with none, an empty placeholder directory —
never $HOME, which would set a parser pool loose on the whole filesystem.

**The port contract.** `--port=0` asks the OS to assign one; the server prints
`codemap-port=<n>` as its first stdout line and Rust parses that. The CLI default
is still 4400. Nothing in the web page hard-codes a port: it calls
`get_server_port` under Tauri and uses relative URLs everywhere else, which is
what keeps the same page working when Fastify serves it directly.

**No orphaned processes.** Rust kills the child on `RunEvent::Exit`, and the
sidecar additionally runs with `--exit-on-stdin-close`: Rust holds the stdin
pipe, so if the app dies without getting to kill anything, the pipe closes and
the server exits. Verified by SIGKILLing the app, which skips the exit handler
entirely — the sidecar still went away and released its port.

## The view layer

The page never draws the whole project. `selectView(graph, spec) -> ViewGraph`
reduces the graph to a slice, and the spec lives in the URL, so navigation is
links: the back button works and a view is shareable.

```
/                            root, auto-descends past single-child directories
/?scope=src/graph            the files in one directory
/?focus=<file>&depth=1       a file and its neighbours, imports both ways
```

- Above 40 files in scope, boxes stand for directories instead of files, and
  edges between them are aggregated with a weight.
- Files outside the current scope collapse to their directory and are drawn
  dimmed, so a scoped view still shows what it connects to.
- Every `ViewNode` carries the `files` it stands for. That is what lets the page
  tell an in-view change from one it must report as happening elsewhere.
- `ViewGraph` is a separate type from `Graph` on purpose. A box standing for a
  directory is not a `GraphNode`, and an aggregated edge needs a weight the core
  model has no business carrying. The graph stays the single source of truth.

## Live updates

Every connected client is sent a view **computed for its own spec** — a client
looking at one directory is never handed another's slice.

The behaviour is *mark, do not move*, chosen deliberately:

- A touched box pulses and holds a warm tint. The camera does not move.
- Box positions are preserved across an update. They are only re-laid-out when
  the set of boxes actually changes, and `fitView` runs on navigation only. A box
  must not jump because the agent saved a file.
- A change landing outside the current view is not drawn; it increments a
  "N changes outside" badge that focuses the most recent one when clicked.

Following the agent automatically was considered and rejected: it makes it
impossible to study one part of the graph while the agent works elsewhere.

## Decisions taken while building step 1

- **ESM with `createRequire`.** `tree-sitter` and its grammars are native CommonJS
  addons with no ESM entry point. `createRequire` is confined to `parser/extract.ts`.
- **Nodes are patched incrementally, edges are re-derived wholesale.** Only a
  changed file is re-parsed (decision 2 holds — parsing is the expensive part), but
  `derive()` rebuilds all nodes and edges from the stored `ParsedFile`s on every
  mutation. It is pure in-memory work, and it means a newly added file can satisfy
  an import that failed to resolve earlier.
- **Top-level declarations only.** Class methods are not separate nodes; calls made
  inside a method attribute to the enclosing class.
- **Unresolvable references are dropped.** Bare specifiers and names that resolve
  to nothing produce no edge. Resolution is: own file first, then imported files.
- **`.d.ts` files are skipped** — they restate types the accompanying source declares.

## Decisions taken while building step 2

- **One box per file, not per class.** A file's symbols are listed inside its box,
  and symbol-level `extends` / `implements` are lifted to the owning files.
- **`calls` edges are not drawn.** At file granularity a call into another file is
  already implied by the import edge beside it. They stay in the graph, and the
  CLI prints them.
- **React Flow, not Mermaid.** Mermaid rendered a static SVG and could not pan,
  zoom or collapse. It is in git history if a static export is ever wanted. The
  view layer, not the renderer, is what makes large projects legible.
- **dagre lays out, React Flow draws.** Boxes are measured before layout, from
  member counts, because dagre needs dimensions up front.

## Decisions taken while building steps 3 and 4

- **One batch entry point on the store.** `applyBatch(store, updated, removed)`
  replaced `setFile` / `setFiles` / `removeFile`. A re-derivation is whole-graph
  work, so an agent touching five files should cost one, not five.
- **Every filtering rule has one definition.** `isIgnoredDirectoryName` and
  `isSourceFileName` live in `walk.ts` and are used by the scan, the watcher and
  the hook endpoint, so none of them can disagree about what the project contains.
- **Coalescing lives in the updater, not in either source.** This is what makes
  the two sources one pipeline: a hook and a watcher event for the same edit,
  80 ms apart, become a single graph update and a single pulse.
- **The server pushes views, not deltas.** A `GraphDelta` does not map onto a view
  slice — a change can be entirely outside what a client is looking at.
- **Updates are published even when the graph did not change.** A comment-only
  edit still tells you where the agent is working.
- **Deltas are not stored.** `applyBatch` returns one and nothing reads it. Session
  diff (`VISION.md`, phase 1) is where that changes; the seam is there, the
  storage is not, because unused storage is not worth carrying.

## Dependency note

`tree-sitter-typescript@0.23.2` declares a stale `peerOptional tree-sitter@^0.21.0`
while the current binding is `0.25.1`. The real constraint is the parser ABI, which
was verified to work. `.npmrc` sets `legacy-peer-deps=true` so `npm install` succeeds;
re-verify by parsing a file if either package is bumped.

## Verified

- Parses its own source and a class/interface fixture: `extends`, `implements`,
  cross-file `calls`, `.js`→`.ts` specifier resolution, deduplicated import edges,
  self-edges dropped.
- Editing one file yields a delta touching only that file's nodes; ids in untouched
  files stay stable. Adding a file resolves a previously unresolvable import.
- 360 parses through the pool block the main thread for 1.1 ms; the same work
  inline blocks it for 114 ms.
- View selection on a generated 120-file project: root collapses to 8 folder boxes
  with weighted edges in 0.5 ms; focus depth 1 gives 19 boxes, depth 2 gives 64.
- End to end over a real websocket: an edit adds the new symbol to its box, a new
  file appears with its edge, a delete removes the box, and three simultaneous
  writes arrive as one coalesced message.
- The hook endpoint accepts source files and relative paths; rejects `.md`,
  `node_modules`, paths outside the root, and payloads with no `file_path` —
  always with HTTP 200. A hook for a file that no longer exists removes it.
- **A hook and a watcher event for the same edit produce exactly one websocket
  message.** The two sources really are one pipeline.
- The real page bundle, mounted in jsdom against a running server: the touched box
  pulses, the new symbol appears, positions are unchanged, and a change outside
  the view produces a badge that focuses that file when clicked. Test tooling
  (jsdom, esbuild) lives outside the repo so it is not a dependency.

**Confirmed in a real browser** (headless Chrome via playwright-core, installed
outside the repo): edges render with correct geometry at root, scope and focus
views, and weight labels appear on aggregated edges. The empty edge container in
jsdom was jsdom's missing layout engine, not a fault.

**Still not verified:** whether Claude Code picks up a newly added
`.claude/settings.json` without a restart. The watcher covers the same edits
either way, so the hook failing silently costs latency, not correctness.

## Known limitations

- The hook's port is hard-coded to 4400 in `.claude/settings.json`.
- Focus depth 2 on a densely coupled project explodes (64 boxes on the synthetic
  test). There is no cap or warning yet.
- Every save re-parses; there is no content hash, so a save that changes nothing
  still costs a parse and a publish.
- Two symbols sharing a name in one file are disambiguated by document order
  (`path#name~2`), so their ids shift if their relative order changes.
- Grouping keys off the directory tree only. There is no filtering by name, kind
  or path glob, and a flat directory above the threshold cannot be grouped at all
  (it now reports `grouped: false` honestly rather than claiming otherwise).
- A focus view at depth 4 on a well-connected file blocks the browser main thread
  for about 2 s: client-side dagre plus the React Flow mount for ~288 boxes. The
  server answers in 3 ms; the cost is entirely in the page.
- Edges have no obstacle avoidance, so they route through unrelated boxes — 26% of
  edges in a 10-box root view.
- A file with a syntax error silently loses symbols. tree-sitter is error-tolerant
  and `parseSource` never checks `tree.rootNode.hasError`, so a malformed file
  is indistinguishable from an empty one.
- `/api/hook` can still answer 413/400/415: Fastify's 1 MiB body limit and its
  content-type parser reject before the route handler's deliberate 200.
- A failed view fetch leaves the previous graph rendered under the error banner,
  and re-navigating to the same URL is a no-op because only `search` drives the
  refetch.
- Deleting and recreating the focused file drops the page out of focus mode while
  the URL still says `?focus=`.
