# Codemap — project context

## What this is

A local developer tool that visualises a codebase **live** while an AI coding agent
modifies it. The problem it solves: agent-driven coding moves faster than a human can
maintain a mental model of the codebase. This tool rebuilds that model continuously.

Runs entirely on localhost. Single user. No auth, no cloud, no multi-tenancy.

Four files carry the project, and they answer different questions:

| | |
|---|---|
| **CLAUDE.md** (this file) | What to know before touching the code, and what to build next |
| [VISION.md](VISION.md) | Where the product is going, and why anyone would want it |
| [DECISIONS.md](DECISIONS.md) | Why things are the way they are, and what has been proven |
| [DESIGN.md](DESIGN.md) | How it looks — VS Code Dark Modern, and it is binding for `web/` |

When this file and VISION.md disagree, this one wins. VISION.md is the destination;
this one is the road.

---

## Where the project is now

The MVP shipped, and four capabilities were built on top of it. The sequencing in
VISION.md was **not** followed — the desktop shell was pulled forward from phase 6,
and the MCP server from phase 4 — so read that table as a menu, not a schedule.

**Built and working:**

- The graph engine, incremental, parsed off the main thread
- The browser page: React Flow, a view layer, live updates from hook and watcher
- The Claude Code hook, and a Tauri desktop app that packages the whole thing
- Architectural groups, named by a person or an agent, committed to the project
- An MCP server, so the agent working in the project can query the graph
- Search, call edges, a side panel, a menu bar, a welcome screen
- Git status against a chosen base, and a group editor
- Explain: a paid, on-request reading of what a symbol is for, and whether it still
  matches the code it described
- Source Control: the commit graph with its threads, the diagram frozen at any
  commit (`?at=`), and a Repository panel — project, remote, hook and MCP

**What to build next, in this order.** Each is small, and each is here because
something in the last round of work argued for it:

1. **Close the loose ends from the git and group work.** `Session.gitBase()` has
   no caller; use it or delete it. `list_groups` in the MCP server prints a
   hand-drawn group exactly like a derived one, with "0% cohesion", which is the
   one promise the group feature makes and the one consumer most likely to be
   misled by breaking it. And ⌘K still searches the live graph while the diagram
   is frozen at a commit — the one request left that does.

2. **Tests for the pure modules.** See *Conventions*. This is the highest-value
   item on the list and the reason is in the last round: a bug that made colour and
   size edits fail on any group whose membership had drifted lived entirely inside
   two pure functions, survived three review agents' worth of reading, and would
   have been caught by a single test case.

3. **Structural session diff** — VISION.md phase 1. Today the tool knows which
   *files* differ from a base, and since time travel it can build a commit's whole
   graph (`project/history.ts`) with the same ids the live one has. Phase 1 is
   which *symbols and edges* differ: the diff of two graphs is the only part left,
   and it is also the only way to draw a deleted file as a ghost — a file that is
   not on disk is not in the live graph, so the current feature honestly cannot
   show one.

**Not started, and not to be drifted into.** Architecture drift detection
(VISION.md capability 1), blast radius (capability 3), LLM dataflow inference, and
anything hosted or multi-user. If a task seems to need one of these, say so and ask
rather than building it.

## Many languages

**The direction changed on 2026-09-01.** The tool reads TypeScript, JavaScript,
Java, Go, C# and Rust. Anyone can point it at their repository. VISION.md's
"language sprawl" line is overridden by this section, and its reasoning — a
mediocre parser for six languages is worse than an excellent one for a single
language — is answered by the rule below rather than dismissed.

**The graph model did not change, and that is why this was affordable.** File,
class, interface, method, field, and extends / implements / calls / contains /
associates are UML, not TypeScript. A language supplies two things and nothing
else: how to read symbols out of a syntax tree, and how to turn a reference into a
file. The contract is `src/lang/types.ts`; a language is one file in `src/lang/`.

**A language is finished when its edges are checked against a real repository, not
when it parses.** This is the whole rule, and it is not academic. Before this
existed, opening vuejs/core drew four boxes and zero edges, because 357 of its
imports name packages inside the same repo and nothing resolved them. That does not
look broken. It looks like code with no coupling — wrong in a way that reads as
authoritative, which is the failure this project cares about most. Parsing is the
easy half; resolution is the half that decides whether the picture is true.

**Detected, never declared.** Opening a project does not ask what language it is.
File extensions are unambiguous, and real repositories are mixed — TanStack/query is
TypeScript, JSX, JavaScript, Svelte and Vue at once, so any single declared answer
would be wrong. The interface shows what was found instead, and says plainly when a
project contains files the tool cannot read at all.

**Grammar loading has one trap, already paid for.** Pass the grammar *module* to
`setLanguage`, not its `.language` property. The bare language throws
`Cannot read properties of undefined (reading '<n>')` from inside `parse` rather
than from the call that was wrong, which reads exactly like an ABI mismatch and is
not one. `tree-sitter-typescript` is the exception: it exports `typescript` and
`tsx` and wants one of those. All six grammars need `.npmrc`'s `legacy-peer-deps`,
for the same stale peer range documented under Dependency note.

---

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

- **Language:** the application is TypeScript everywhere — the Tauri shell is the one
  exception, and it does process lifecycle only. What it *reads* is a separate
  question, answered under "Many languages" above.
- **Runtime:** Node.js
- **Parsing:** `tree-sitter` with `tree-sitter-typescript` grammar
- **Server:** Fastify (HTTP + websocket)
- **Frontend:** React + Vite, React Flow for diagram rendering, Codicons for every
  icon. The look is VS Code Dark Modern, specified in DESIGN.md.
- **Desktop:** Tauri, with a Node sidecar. SQLite for local state.

## Non-negotiable design decisions

These were decided deliberately. Do not change them without asking.

1. **Parsing runs in `worker_threads`, never on the main thread.**
   The main process must never block while parsing, because the agent fires rapid
   consecutive edits.

2. **Parsing is incremental.** When a file changes, re-parse only that file and
   patch the graph. Never re-scan the whole project except on initial boot.

3. **The graph is the single source of truth.** It lives in one place, in memory,
   with a well-defined shape. Renderers read from it; they never derive their own
   structure from raw source files.

4. **Static analysis first, LLM second.** Class structure, imports, and call edges
   come from the AST — deterministic and fast. **Nothing in the graph comes from a
   model**, and that is the part that must not change. A model has exactly one job
   here, and it is reading, not deciding: saying what a symbol the graph already
   found is *for*, on request, into a panel — see "Explaining what the graph found".
   Cross-file semantic dataflow inference is still reserved and still not built.

5. **Group membership is graph-derived by default, and a hand-drawn group says so.**
   A tidy grouping that does not match the imports is worse than none, because it is
   wrong in a way that looks authoritative. A person may draw a group — they may know
   something the imports do not — but it is stored with `origin: 'manual'` and marked
   wherever it is shown. A model may suggest a name; it may never decide who belongs.

## Graph model

Keep the node/edge shape stable and explicit:

```ts
type NodeKind = 'file' | 'class' | 'function' | 'interface' | 'type' | 'method' | 'field';
type EdgeKind = 'imports' | 'extends' | 'implements' | 'calls' | 'contains' | 'associates';

interface GraphNode {
  id: string;          // stable: `${filePath}#${symbolName}`
  kind: NodeKind;
  name: string;
  filePath: string;
  range: { startLine: number; endLine: number };
  modifiedAt?: number; // file nodes only
}

interface GraphEdge {
  from: string;        // GraphNode id
  to: string;
  kind: EdgeKind;
}
```

Node IDs must be **stable across re-parses** so the frontend can diff and animate
rather than redraw everything. A method lives in its own namespace —
`path#Class.method` — so it can never collide with a top-level symbol of the
same name, and it is contained by its class rather than by the file.

**A class box is a UML class box.** Fields and methods are both nodes, with the
visibility, `static` and `abstract` the source actually stated — absent means the
source said nothing, which in TypeScript is public, so the parser reports what
was written rather than what it inferred. Attributes are pushed before
operations, which is the order a UML class box reads in.

**An association is what an import cannot say.** A field's declared type gives
`Store ──has──> Logger`; an import only says this file mentions that one.
The edge runs between the two classifiers, not from the attribute holding it —
the field is how the relationship is spelled, the class is what has it. Like
`calls`, it is opt-in (`?edges=…,associates`) and *replaces* the import between the
same pair rather than being drawn beside it. `Logger[]` sets `many`, for 1..*.

**Methods and fields are not in the name-resolution table.** A bare name is resolved against
it, and `x.map(...)` reaches the graph layer as just `map`, so admitting members
would invent a call edge to every class that happens to declare one. A missing
edge is a gap; a wrong one is a lie.

**Not built, and deliberately.** Sequence diagrams need call *order*, which
`collectCalls` discards into a Set, and receiver resolution on top of that. State
and activity diagrams are not derivable from static structure at all. ER
diagrams are out of scope. A package diagram is the root view, and exists.

**A cluster id is not a stable identity.** It embeds the member count
(`src/cli/index.ts~8`), so it changes the moment a file joins or leaves the group,
while the group itself survives — re-matched by member overlap under the id it was
recorded with. Anything that edits a stored group addresses it by `storedId`, never
by the id of the cluster it currently describes.

---

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
node scripts/corpus.mjs <dir>...  # what the engine makes of real projects

node scripts/prepare-sidecar.mjs  # once: builds the Node sidecar binary
npm run tauri dev                 # the desktop app
CI=true npm run tauri build       # .app + .dmg — see "Packaging"
```

`npm run serve` loads `dist/`, so a source change is invisible until `npm run build`.
A server left running from an earlier session will happily serve code from before it.

## Layout

```
src/
  graph/          the graph engine — pure, no I/O
    types.ts      GraphNode / GraphEdge / Graph / GraphDelta
    resolve.ts    module specifier -> file, given the set of known files
    store.ts      holds parse results, derives the graph, emits deltas
  git/
    types.ts      GitFileStatus / GitStatus — pure, so the view can name a
                  status without importing the module that shells out
  parser/         everything that knows about ASTs
    types.ts      ParsedFile / ParsedSymbol + worker message shapes
    extract.ts    tree-sitter -> ParsedFile (the only module using createRequire)
    worker.ts     worker_threads entry: reads a file, parses it, replies
    pool.ts       fixed pool of parser workers, one file at a time each
  project/        the project on disk, and everything that changes it
    walk.ts       boot scan + the ignore/source predicates everything shares
    scan.ts       walk + parse everything through the pool
    watch.ts      chokidar; emits raw changes, does not batch
    git.ts        git status against a base -> GitStatus; the log, the remote,
                  fetch, resolveCommit, archiveCommit. Read-only, and never throws
    history.ts    one commit's graph: git archive -> temp dir -> scanProject
                  through the session's pool. Never throws, never leaves the dir
    groups.ts     named groups, their colours and sizes, .codemap/groups.json
    explain.ts    spawns `claude -p` for a reading of a symbol. Never throws
    hook.ts       a Claude Code PostToolUse payload -> the same FileChange
    hook-install.ts  detect, preview and merge the hook into settings.json
    port-file.ts  leaves the port where the hook can read it
    updater.ts    the one pipeline: coalesce, parse, patch, publish
  view/           which slice of the graph to draw — pure
    types.ts      ViewSpec / ViewGraph
    filter.ts     what to leave out; filtering is not navigating
    select.ts     selectView(graph, spec, now, git) -> ViewGraph
    cluster.ts    label propagation over the import graph
    detail.ts     one node's dependents and dependencies, for the panel
    search.ts     subsequence search over the whole graph
    lanes.ts      lane assignment for the commit graph — pure, and tested
    lanes.test.ts the first test. `npm test`
  cli/
    index.ts      arg handling + text/JSON output
  server/
    session.ts    one project: store, pool, watcher, updater, git, and an LRU of
                  16 past commits' graphs. Swapped whole
    app.ts        Fastify: static web build, and the API below
    live.ts       connected clients and their view specs; pushes per client
    main.ts       boot scan, wiring, listen
web/              the browser page (Vite, built into dist/web)
  src/App.tsx     URL <-> view, live updates, breadcrumb, focus, depth, selection
  src/BoxNode.tsx one box: a file with its symbols, or a folder
  src/GroupNode.tsx a group frame: name, colour, size, membership
  src/Sidebar.tsx the side panel: detail, change feed, group list and editor
  src/Repository.tsx   the left bar's first section: project, remote, the Claude
                       Code hook and MCP, and the buttons that act on them
  src/SourceControl.tsx  Changes (the per-file list, the base picker) and Graph
  src/GitGraph.tsx     the commit graph: lane numbers into pixels, refs, ages
  src/Activity.tsx     what the agent is doing, and where — describes now, always
  src/ProjectMenu.tsx  folder picker and recents; desktop only
  src/Welcome.tsx      shown when there is nothing to draw, and from Help
  src/MenuBar.tsx      the menus
  src/StatusBar.tsx    branch, git base, counts, languages, the agent — what the
                       project is, read at the bottom the way an editor does it
  src/Section.tsx      one side bar section: 22px header, a chevron that folds it,
                       actions hidden until hover. Every panel region is one
  src/SearchPalette.tsx  ⌘K, in Quick Pick's shape
  src/AgentStatus.tsx  what the agent is doing, and how long ago
  src/layout.ts   dagre layout; React Flow does not place nodes itself
  src/api.ts      fetch + the shared types, imported from src/
.claude/
  settings.json   the PostToolUse hook, committed so the repo dogfoods itself
.codemap/
  groups.json     accepted group names, committed on purpose
  explain.json    what a model said each symbol is for, and of which source
```

**The API surface**, all served by `server/app.ts`:

```
GET  /api/view          the slice for a ViewSpec, given as a query string.
                        ?at=<sha> draws the project as of that commit; 404 for
                        an unknown one, never the live graph under its name
GET  /api/project       the current root
POST /api/project       switch to another root
GET  /api/detail        one node's dependents and dependencies       (?at=)
GET  /api/symbol        one symbol's relations, for following it     (?at=)
GET  /api/log           the commits on every ref, newest first, plus HEAD and
                        the checked-out branch
GET  /api/repo          what the repository is: files, remote, hook, MCP, languages
POST /api/fetch         git fetch. The only verb that is not a read
GET  /api/changes       this session's change feed
GET  /api/search        subsequence search over the whole graph
GET  /api/agent         what the agent has asked, and when
GET  /api/clusters      the groups, named and unnamed                (?at=)
POST /api/clusters      accept or reject one, by membership
POST /api/groups        create, update or delete one, by storedId
GET  /api/explain       the readings for the ids asked for, and the run
POST /api/explain       run (202), cancel, or forget one. Spends money
GET  /api/git           the current git status
POST /api/git-base      change the base the working tree is compared against
GET  /api/hook-status   is a working hook installed
POST /api/hook-install  merge ours into whatever is there
POST /api/hook          the PostToolUse payload. Always 200
     /live              the websocket
```

---

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
  the two sources would debounce independently and the same edit would land twice.
- **A hook must never fail the agent's tool call**, so every response is 200,
  including for payloads the endpoint cannot use.
- **The hook contains no port.** It reads the one the server leaves in
  `.claude/codemap.port`, so one hook definition survives a port the OS reassigns
  on every launch, and follows a switch between projects. The file is written only
  when `.claude/` already exists — the server does not create Claude Code's
  directory uninvited — and is removed on shutdown.
- **The app writes the hook for you.** A hook that names a port rather than reading
  the file counts as *not* installed, so an old one is offered the upgrade instead
  of being mistaken for a working one.

## The view layer

The page never draws the whole project. `selectView(graph, spec, now, git)` reduces
the graph to a slice, and the spec lives in the URL, so navigation is links: the
back button works and a view is shareable.

```
/                            root, auto-descends past single-child directories
/?scope=src/graph            the files in one directory
/?focus=<file>&depth=1       a file and its neighbours, imports both ways
/?changed=1                  only what differs from the git base
/?at=<sha>                   the whole diagram as of that commit — not a highlight
```

**A frozen view is frozen.** `at` is a view, so it rides the URL and the socket
spec, and every helper that rebuilds the URL carries it. The server selects from
`session.graphAt(sha)` — a commit unpacked with `git archive` and scanned exactly as
a project is at boot, so the ids match the live graph's — and everything that
describes the diagram (`/api/detail`, `/api/symbol`, `/api/clusters`) takes the same
`at`, so a frame or a panel on a diagram of last week is what last week's imports
produced. `changed` and `since` are dropped on freeze: a commit has no working tree
or clock to filter by. Escape leaves the commit, unless a menu took the key first.

- Above 40 files in scope, boxes stand for directories, and edges between them are
  aggregated with a weight.
- Files outside the current scope collapse to their directory and are drawn dimmed.
- Every `ViewNode` carries the `files` it stands for. That is what lets the page
  tell an in-view change from one it must report as happening elsewhere.
- `ViewGraph` is a separate type from `Graph` on purpose. A box standing for a
  directory is not a `GraphNode`, and an aggregated edge needs a weight the core
  model has no business carrying.

**Two wire formats, two readers.** The URL carries the spec as short flat keys
(`changed`, `edges`, `since`); the websocket carries a `ViewSpec` object with its
filter nested (`onlyChanged`, `edgeKinds`, `sinceMs`). Reading one with the other's
parser silently yields the default filter — no error, just a diagram that quietly
widens back to everything. Keep `toSpec` and `toSocketSpec` apart.

## Git status

`project/git.ts` compares the working tree against a base and returns a
`Record<path, GitFileStatus>` — `git diff --name-status -z <base>` for the tracked
half, the `??` entries of `git status --porcelain -z` for the untracked one. It
**never throws**: a directory that is not a repository is a missing feature, not an
error, and every caller treats `null` as "no git here".

- The base is `HEAD`, `HEAD~1` or `branch` (the merge base with the default branch).
  It is a **session setting, not a view**, so it does not go in the URL — no more
  than the project root does. The `?changed=1` filter *is* a view, and does.
- Paths come back relative to the repo root; the project may be opened at a
  subdirectory, so they are translated and anything outside is dropped.
- **A commit is invisible to the watcher.** `isIgnoredDirectoryName` drops every
  dotted directory, so `.git` is never watched. Hence a 3 second poll that publishes
  only when the status actually changed, unref'd so it cannot hold the process open,
  and cleared with the session.
- Git status is a small badge on a box, never a third full-box tint. Amber already
  means "just changed" and blue means "the agent asked about this".
- **The vocabulary is VS Code's.** "Changes" with a count, "Diff against HEAD ·
  HEAD~1 · merge base", `⎇ main ↑2 ↓0` — never "vs HEAD". The letters are VS
  Code's too: an untracked file is `U`, on the box and in the list.
- **Git is read-only here.** The log is `git log --date-order --all -n 300` (date
  order because the lane layout needs a parent never to precede its child), the
  remote is read, and `fetch` is the one verb that writes — to `.git`, never to the
  working tree. Nothing commits, checks out, resets or stashes.
- **The commit graph's lanes are a pure function**, `view/lanes.ts`, with the test
  beside it. One bug lived there already: a merge whose second parent joined a
  lane that was already open dropped that lane's thread through the row.

## Architectural groups

The graph finds groups of files that lean on each other more than on anything else —
label propagation over the import graph, deterministic, no model involved. A person,
or an agent, gives them names. See non-negotiable decision 5 for the rule that
governs membership.

- Frames are drawn tight around where members actually landed, not around dagre's
  parent box, which spans every rank its children touch. Where two overlap badly the
  more cohesive one keeps its frame — and the panel lists every group regardless, so
  a frame that cannot be drawn is still nameable and still editable.
- Accepted names live in `.codemap/groups.json` **in the project, committed**: a name
  for a piece of architecture belongs beside the code. The file is written only when
  a decision is made.
- Names are matched back to freshly computed clusters by member overlap, so they
  survive membership drifting. That is why `storedId` exists — see *Graph model*.
- A group's **size** is the slack around its members, not an absolute rectangle. The
  frame hugs what it encloses; a free-floating box would describe nothing.

## The rest of the page

- **The left bar** is Repository › Source Control › Activity, 300px. The Repository
  panel absorbed the hook banner: hook, MCP and port file are rows, and "Install
  hook" is a button under them, hidden once installed. Activity describes *now*
  even while the diagram is frozen: the agent is still working in the working tree.
- **The status bar.** 22px at the bottom: branch, ahead/behind, the "Changes" count
  that toggles the filter, then boxes and files, the language summary and the
  agent's connection. Every item is information or runs something.
- **The menu bar.** Two rows: menus and project on top, breadcrumb and filter chips
  below. **Nothing in a menu is decoration.** Every item runs something the app can
  already do, and an item that needs a selection is greyed with the reason in its
  tooltip rather than silently doing nothing.
- **The welcome screen.** Shown from Help, and when there is genuinely nothing to
  draw. **Not** when a filter emptied the view. It covers the canvas, not the
  window — it used to position against the viewport and painted over the menu bar,
  both side bars and the status bar, which buried every way back out.
- **Search.** ⌘K searches the **whole graph**, not the slice on screen. Matching is
  a subsequence, the way editors do it: `gst` finds `GraphStore`.
- **Call edges** are off by default (`?calls=1`). When on, a call edge *replaces* the
  import between the same pair rather than being drawn beside it.
- **The side panel.** Click inspects, double-click navigates. `zoomOnDoubleClick` is
  off and must stay off: d3-zoom handles a double click on the pane and stops it
  bubbling, so `onNodeDoubleClick` never fires and the view silently zooms instead.
- **The change feed** is the session's own history, the last 200 batches in memory,
  discarded with the session. It is *not* session history — that is VISION.md phase 1
  and it gets a schema designed for it rather than a ring buffer promoted into one.

## Live updates

Every connected client is sent a view **computed for its own spec**. The behaviour is
*mark, do not move*:

- A touched box pulses and holds a warm tint. The camera does not move.
- Box positions are preserved across an update, and only re-laid-out when the set of
  boxes actually changes. **The layout cache has two keys.** `placementKey` is what
  dagre reads — the boxes, their heights, which group each belongs to; `shapeKey`
  adds everything a frame is drawn from — colour, slack, lock, hand-placed geometry.
  A change to the second alone redraws the frames around where the boxes already
  are (`frameClusters`) and never runs dagre, because running it moved every box
  for a click that meant "hold this one still", and a frame locked to where it
  stood was left standing where the boxes used to be.
- **Dragging a frame locks it**, the way pulling a corner does; the lock button only
  releases. A frame that had to be locked before it could be moved was the wrong
  order, and it was reported as such.
- A socket whose spec names a commit is not pushed `update` at all — a frozen view
  is frozen — and the page refuses `update` frames while frozen as well. Because
  that push was what bumped `revision`, the page polls changes, git status and the
  log every 3 s while frozen so the left bar keeps describing now.
- A change landing outside the current view is not drawn; it increments a
  "N changes outside" badge that focuses the most recent one when clicked.

Following the agent automatically was considered and rejected: it makes it impossible
to study one part of the graph while the agent works elsewhere.

## Seeing the agent

The MCP proxy marks its own requests with `x-codemap-tool` and `x-codemap-arg`, and
one `onRequest` hook records them. Headers rather than a separate report: one request,
and nothing to keep in sync. That buys one timeline (the agent's questions and the
file changes in a single column), a second pulse (a box glows blue when the agent
asked about it), and a status that names the tool and how long ago.

## The MCP server

`scripts/mcp.mjs` exposes codemap to whichever agent is working in the project.
`.mcp.json` wires it up.

The direction is the point. An MCP server is called **by** an agent and can never
call one, so the app cannot ask a model to name a group. Instead it offers the
unnamed groups to the agent already running — no API key, no cost, nothing leaving
the machine.

**That still holds, and it is about deciding, not about asking.** Since the explain
feature the app *can* reach a model — it spawns `claude -p` itself, which is not
MCP and does not change MCP's direction. What has not moved is decision 5: a name
that goes in `groups.json` is a claim about the architecture and stays the user's,
offered through MCP to the agent already running. The model's new job is to *read* —
to say what a symbol is for, into a panel, where being wrong is visible and one ✕
away. Naming through `claude -p` would be the same money buying a worse version of
something that already works for free.

```
list_groups     the clusters, named and unnamed
name_group      accept one with a name
describe_file   declares / used by / uses
search_symbols  subsequence search over the whole project
```

It holds no graph of its own; it talks to a running codemap over HTTP and finds it
through the same `.claude/codemap.port` file the hook reads.

## Explaining what the graph found

The graph says a symbol is called by four things. It cannot say what it is *for*.
`src/project/explain.ts` spawns `claude -p` with the source and the graph's own
relations, and asks for a role rather than a walkthrough. Answers land in
`.codemap/explain.json`, committed like `groups.json`.

**It spends the user's money, so nothing is implicit.** A run happens only on a
press, its price is measured and shown, and the panel says what a reading now
stands to: `current`, `stale` (the source was rewritten — the fingerprint is
`sha256`-prefixed and a consumer that cannot compute the prefix answers `unknown`
rather than guessing), `drifted` (something related moved), `orphaned` (the code is
gone). A stale reading is kept, because it is usually still most of the answer.

**The invocation is measured, and four flags are load-bearing.** Two real symbols
of this repo cost **$0.0255 and took 27 seconds**. Left to sit in the project
instead, a *trivial* prompt costs **$0.217**, because the child loads the project's
CLAUDE.md and tool definitions on every run — hence `cwd: os.tmpdir()` and:

- `--strict-mcp-config`, or the child starts a second codemap MCP server and its
  queries come back through the request hook as *the agent* asking. codemap would
  report itself in the one timeline it exists to keep honest. (Verified: a real run
  against this repo recorded zero agent calls.)
- `--setting-sources ''`, so the project's PostToolUse hook is never loaded by the
  child. **Not `--restricted`**, which says the same in one flag and is rejected
  outright by CLIs people still have installed — 2.1.167 on this machine.
- `--allowed-tools ''`, so every tool call is denied and only the prompt leaves.
- `--json-schema`, which makes "the model answered in prose" impossible. The CLI
  satisfies it with a StructuredOutput tool call, so the answer is in the envelope's
  `structured_output` and **not** in `result`, which holds only a closing remark.

A run is far longer than a browser holds a fetch open, so `POST /api/explain`
answers **202** and the outcome arrives on the socket — `{ type: 'explain', run }`
— with a 3 s poll as the fallback that also notices a run another tab started.
`explain()` never throws and never rejects: every failure is a named reason
(`missing` carries the list of places searched, which is the fixable one).
`CODEMAP_CLAUDE_BIN` overrides the search.

`GET /api/explain` takes ids on purpose — computing `state` re-reads every
described file off disk, so an unfiltered answer would read the whole project to
render a panel showing four.

## Desktop shell and packaging

Full reasoning in [DECISIONS.md](DECISIONS.md). The rules:

- **The server is not bundled into a single executable.** `scripts/prepare-sidecar.mjs`
  produces a real Node binary and `dist/` ships beside it as a Tauri resource, so
  `worker_threads` loads a real sibling file and the native addons resolve as they do
  in development. Node SEA cannot do either. Do not try again without reading why.
- **Switching projects opens a new session; it does not reset the old one.**
  `server/session.ts` owns everything root-scoped. A switch builds the next session,
  swaps it in, then closes the previous one.
- **On exit Rust *drops* the child rather than killing it.** The closed stdin pipe is
  what `--exit-on-stdin-close` listens for, so the server runs its own shutdown and
  removes its port file. `kill` is SIGKILL, which skipped that and left the file
  naming a dead port. **Do not "fix" this back to a kill.**
- **`CI=true` is not optional** for `npm run tauri build`. Without it the build fails
  at the last step in `bundle_dmg.sh`, which drives Finder through AppleScript. A
  failed build leaves a mounted `rw.*.dmg` that blocks the next attempt.
- **Prune carefully** in `scripts/prepare-resources.mjs`. `bindings` is
  tree-sitter-typescript's own `main` and `common` holds shared grammar code —
  deleting either makes the addon unloadable, and because a worker that fails at
  module load is indistinguishable from one that crashed, the symptom is a hang
  rather than an error.
- **The app is not signed or notarised.** macOS will refuse it on first launch;
  right-click and Open.

---

## Conventions

- Strict TypeScript. No `any` without a comment explaining why.
- Small modules with one responsibility. The parser does not know about websockets.
- Prefer plain functions over classes unless there is real state to hold.
- Keep I/O at the edges. `graph/` and `view/` are pure and must stay that way — that
  is why `src/git/types.ts` exists separately from `src/project/git.ts`.
- Comments explain *why*, not *what*.

**Testing.** The rule used to be "no test framework ceremony in the MVP, but the
graph engine must be pure enough to test later". Later has arrived, and the evidence
is that every check in DECISIONS.md is a scratch script that was run once and thrown
away, so nothing in it can be re-run to see if it still holds.

Use `node --test`. It is built into Node, so this adds no dependency and no ceremony.
`npm test` compiles and runs every `*.test.ts` beside the module it tests; the first
is `src/view/lanes.test.ts`.

- **Test the pure modules**: `graph/`, `view/`, `project/groups.ts`, and the parsing
  half of `project/git.ts`. These are where logic hides and where a bug is silent.
- **Do not** unit-test the server, the React page, or the parser workers. Those are
  I/O and integration; a scratch script against a running server is still the right
  tool, and it belongs in DECISIONS.md when it proves something.
- A bug worth fixing is worth a test that fails first. The last three bugs found by
  review all lived in pure functions.

## Working style

- Make one coherent change at a time. Do not refactor unrelated code while
  implementing a feature.
- When a design decision is ambiguous, ask instead of guessing — this codebase is
  small enough that a wrong assumption is cheap to prevent and expensive to unwind.
- Explain what changed and why after each step.
- **Keep this file true.** It is the first thing read and the easiest thing to let
  rot. When a section here describes something that is no longer the case, that is a
  bug: it sends the next agent to rebuild something that exists, or to trust
  something that is gone. Move the history to DECISIONS.md rather than growing this
  one — it has been 662 lines and contradicting itself once already.

## Dependency note

`tree-sitter-typescript@0.23.2` declares a stale `peerOptional tree-sitter@^0.21.0`
while the current binding is `0.25.1`. The real constraint is the parser ABI, which
was verified to work. `.npmrc` sets `legacy-peer-deps=true` so `npm install` succeeds;
re-verify by parsing a file if either package is bumped.

## Known limitations

Structural, and each one a real report rather than a worry. The first four were
measured with `scripts/corpus.mjs` against zustand, type-fest, zod, vuejs/core and
TanStack/query — 32 to 925 files each — and they are the ones that decide whether
the graph can be trusted at a glance on a project that is not this one:

- **A monorepo's own structure is invisible.** Packages import each other by
  name, and a bare specifier resolves to nothing: 357 of vuejs/core's imports are
  `@vue/*` and 503 of TanStack/query's are `@tanstack/*`, all internal, none
  drawn. The cross-package architecture is exactly what a map is wanted for, and
  it is the one part missing. Same cause as tsconfig path aliases (`@/`, `~/`),
  which cost zod 37 edges and query 25.
- **A types-only library draws as unconnected boxes.** `.d.ts` is skipped because
  it restates what the source declares — true for an app, false for type-fest,
  where 100% of 487 imports go unresolved, no import edge survives, and the
  clustering finds 0 groups in 221 files.
- **Enums, namespaces, `declare module` and class expressions are not parsed.**
  Not dropped with a warning — absent. 54 enums in vuejs/core, 32 in zod.
- **Files that declare something and yield no symbols**: 86 in TanStack/query,
  53 in vuejs/core. Cause unknown; that is what makes it worth chasing.
- Re-deriving the whole graph on every save is **not** the scaling problem it
  looked like: it tracks edge count at roughly 2 µs each, so 12 ms for zod's 500
  files and 15 ms for vuejs/core. It stays comfortable well past this project.
- The 89% single-cluster blob is **this project's shape, not the algorithm's**.
  The same clustering gives 3 groups at 31% on zustand, 5 at 35% on zod, 11 at
  28% on vuejs/core and 47 at 7% on TanStack/query.

- Focus depth 2 on a densely coupled project explodes (64 boxes on the synthetic
  test). There is no cap or warning. At depth 4 the browser main thread blocks for
  about 2 s — client-side dagre plus the React Flow mount for ~288 boxes. The server
  answers in 3 ms; the cost is entirely in the page.
- Every save re-parses; there is no content hash, so a save that changes nothing
  still costs a parse and a publish.
- Two symbols sharing a name in one file are disambiguated by document order
  (`path#name~2`), so their ids shift if their relative order changes.
- A file with a syntax error silently loses symbols. tree-sitter is error-tolerant
  and `parseSource` never checks `tree.rootNode.hasError`, so a malformed file is
  indistinguishable from an empty one.
- Grouping keys off the directory tree only. There is no filtering by name, kind or
  path glob, and a flat directory above the threshold cannot be grouped at all (it
  reports `grouped: false` honestly rather than claiming otherwise).
- Edges have no obstacle avoidance, so they route through unrelated boxes — 26% of
  edges in a 10-box root view.
- A group with no `id` in `groups.json` — written before ids existed — cannot be
  given a colour or a size until it is renamed, which heals the id. Nothing in this
  repo's file is in that state.
- **An explanation can be confidently wrong, and nothing checks it.** The measured
  run described `explain()` as "called during session initialization to populate the
  client", which it is not — it runs on a press. The model is given one symbol's
  source and the graph's relations, so it reasons about *when* something runs by
  guessing. The fingerprint proves the reading matches the code it described; it
  proves nothing about whether the reading is true. This is the exact failure mode
  this project cares most about, which is why a reading is one ✕ from being
  forgotten and never feeds the graph.
- `GET /api/explain` packs ids into one comma-separated parameter and splits on
  commas, so a path containing a comma — legal on every OS this runs on — becomes
  two ids that resolve to nothing. Silent wrong answer, nobody has hit it.
- Neither the followed list nor the reading list is cleared on a project switch, and
  the "last run cost" line survives one too. Ids from the old project sit there until
  dropped; pressing Explain on them gets a 400 with the server's own words.
- `cancel` abandons a run, it does not kill the subprocess: the money is already
  spent, and what it buys is that the answer is refused and never written.
- **⌘K searches the live graph while the diagram is frozen**; detail, symbols and
  groups follow the commit, search does not yet.
- A commit's graph is built through the same FIFO parser pool as the live updater,
  so a save that arrives after a big commit has queued its files waits behind them
  — seconds on a vuejs/core-sized repository. Decision 1 is about the main thread,
  which stays free; the *latency* of the live pulse is what suffers.
- `git archive` honours `export-ignore`, so a directory marked that way is absent
  from every commit's graph while present in the live one.
- A history temp dir survives a SIGKILL mid build (the desktop shell dropping the
  sidecar, Ctrl-C). Boot sweeps `codemap-*` directories older than an hour; a
  fresher one is assumed to belong to another codemap still running.
- HEAD further back than the 300-commit log selects no Graph row; a commit at which
  the opened subdirectory did not exist answers "unknown commit".
- `/api/hook` can still answer 413/400/415: Fastify's 1 MiB body limit and its
  content-type parser reject before the route handler's deliberate 200.
- A failed view fetch leaves the previous graph rendered under the error banner, and
  re-navigating to the same URL is a no-op because only `search` drives the refetch.
- Deleting and recreating the focused file drops the page out of focus mode while the
  URL still says `?focus=`.
- **Saving window state on quit is unverified.** Driving a native window from outside
  needs macOS accessibility permission, which is not granted here, so the restore
  path was proved from a log line and the save path only by reading. Check it by
  resizing, quitting with Cmd-Q, and relaunching.
- `codemap.db-wal` and `-shm` are left behind on exit: Tauri leaves through
  `std::process::exit`, so no final checkpoint runs. Harmless, but the files persist.
- Errors in the persistence layer are swallowed. A read-only config directory loses a
  remembered preference silently.
- `schema_version` is written but never read. There is a place to put an upgrade, not
  an upgrade path.
- **Still not verified:** whether Claude Code picks up a newly added
  `.claude/settings.json` without a restart. The watcher covers the same edits either
  way, so the hook failing silently costs latency, not correctness.
