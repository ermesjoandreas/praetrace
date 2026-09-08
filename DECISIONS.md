# Codemap — decisions and evidence

Why things are the way they are, and what has actually been proven about them.

This is the archive. [CLAUDE.md](CLAUDE.md) is the working brief — what to know
before touching the code. Nothing here is required reading to make a change; it
is here so that a decision already taken is not silently taken again, and so a
claim about the code can be traced to the run that established it.

---

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
  **Reversed later.** The premise of the tool is watching an agent work, and adding
  a method to an existing class is the most common thing it does — which produced a
  graph update that changed nothing visible. Methods are nodes now, contained by
  their class, and a class no longer claims the calls its methods make or the same
  call would be counted twice from two different nodes.
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
  **Answered differently on 2026-09-07.** Phase 1 arrived without touching
  deltas at all: the diff is of two whole graphs — a commit's, built by
  `history.ts`, and the working tree's — so nothing is stored and git keeps
  the commits. See "Never draw the hairball" below.


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

---

# Phase D — the desktop shell, in full

The condensed rules live in CLAUDE.md. This is the reasoning behind them,
including the research that ruled out the alternatives.

## Desktop shell

Phase D is finished. All six items are done. The app launches, picks a project through a native
dialog, starts its sidecar on an OS-assigned port, renders the graph, updates
live from both the hook and the watcher, opens files in the editor on click,
remembers what it should between launches, and exits without leaving a stray
Node process.

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

**Local persistence.** `src-tauri/src/store.rs` keeps recent projects, window
state and per-project settings in SQLite under the app config directory.

SQLite rather than more JSON files because of what comes next: session diff
(`VISION.md`, phase 1) records many rows per project over time and wants to query
them by project and by date. The schema is shaped for that now, so it arrives
without a migration — `project` carries a surrogate `id` from day one purely so a
later `session(project_id REFERENCES project(id))` needs no back-fill. Recents as
a bare list of paths, which is all this phase needs, would have forced exactly
that rewrite later. (Phase 1 then arrived as a diff of two graphs in memory
and wrote no row; the seam is still there for persisted history, unused.)

Item 3's `recent-projects.json` is imported once on first open and then deleted,
so the two cannot drift. The import assigns distinct descending timestamps: a
whole import lands inside one second, and equal timestamps left the recency order
to whatever SQLite happened to return.

Window geometry is tracked in memory — recorded once at startup and on every
resize or move — and written once on exit, rather than a database write per frame
of a drag. A restored position is checked against the attached monitors first,
since a saved position can name a screen that is no longer there.

Per-project settings are a JSON column, read and written whole for one project at
a time and never queried across projects. Its first consumer is the editor
scheme, which is why `openInEditor` asks for it rather than hard-coding
`vscode://`. There is no UI for changing it yet.

**Editor deep links.** A click on a box already navigates the graph, so opening
an editor uses a different target: clicking a **symbol** opens its file at that
symbol's own line, and a button in the box header opens the file at line 1. The
line numbers were already in the graph; `ViewMember` now carries one.

The URL is `vscode://file/<absolute path>:<line>`, built with `encodeURI` so a
path with a space survives. Under Tauri it goes through an `open_in_editor`
command that allowlists the scheme — the webview hands Rust a string, and
"open whatever you are given" is how a page becomes a way to launch things. In a
browser the OS handles the scheme itself, usually after a prompt. The scheme is
fixed for now; item 6's per-project settings are where it would become a choice.

**The port contract.** `--port=0` asks the OS to assign one; the server prints
`codemap-port=<n>` as its first stdout line and Rust parses that. The CLI default
is still 4400. Nothing in the web page hard-codes a port: it calls
`get_server_port` under Tauri and uses relative URLs everywhere else, which is
what keeps the same page working when Fastify serves it directly.

**No orphaned processes, and no killing either.** On exit Rust *drops* the child
rather than killing it. Dropping closes our end of the sidecar's stdin, which is
the signal `--exit-on-stdin-close` already listens for, so the server runs its
own shutdown and removes `.claude/codemap.port`. `CommandChild::kill` is SIGKILL,
which skipped that and left the file naming a dead port — one the hook would keep
posting to, and that something else could later occupy. Do not "fix" this back to
a kill. The closed pipe is what guarantees the exit, which is why SIGKILLing the
app has the same effect: verified, the sidecar still goes away and removes its
port file.

## Packaging

`CI=true npm run tauri build` produces `codemap.app` (153 MB) and
`codemap_0.1.0_aarch64.dmg` (45 MB) under `src-tauri/target/release/bundle/`.

**`CI=true` is not optional.** `bundle_dmg.sh` drives Finder through AppleScript
to arrange the disk image window, which needs macOS automation permission; without
it the build fails at the very last step with only "error running bundle_dmg.sh".
`CI` makes Tauri pass `--skip-jenkins`, which skips the cosmetics. If a build does
fail there, it leaves a mounted `rw.*.dmg` behind that blocks the next attempt —
`hdiutil detach` it first.

`scripts/prepare-resources.mjs` stages what ships. The repository's
`node_modules` is 160 MB of build tooling; the server loads six packages, and the
frontend's dependencies are already inside `dist/web`. Staging installs only those
six and prunes the native prebuilds to this platform: 28 MB.

Prune carefully. `bindings` is tree-sitter-typescript's own `main` and `common`
holds shared grammar code — deleting either makes the addon unloadable, and
because a worker that fails at module load is indistinguishable from one that
crashed, the symptom is a hang rather than an error.

**The app is not signed or notarised.** macOS will refuse it on first launch;
right-click and Open. Signing is out of scope for phase D.


## The status bar was a pixel too tall (2026-09-02)

DESIGN.md's checklist asks that `document.body.scrollHeight === innerHeight`. It
read false by one pixel in every state. The status bar is 22px *including* its
1px top line, so a 22px item inside it stood half a pixel proud above and below
and the document scrolled by one. `.status-item` and `.agent-status` are 21px
now, the same sum the breadcrumb row's search box already makes. Measured true in
all four fold states of the left bar afterwards.


## Which UML diagrams the tree can carry (2026-09-04)

The question was what other UML diagrams could sit on top of the class diagram.
It was measured before it was decided, and the measurement is what decided it.

**The sequence diagram was refused, on a number.** A sequence diagram is calls
in order, and the parser can name the receiver of a method call only when its
type was written down — `x: T`, `this` inside `T`, `= new T()`. Counted over
every method-call site: **13% on this repository, 27% on a Java first-year
tree** (~/IdeaProjects). A diagram drawn from that shows one message in eight
and reads as complete, which is the exact lie the project exists not to tell.
`collectCalls` discarding order into a Set is the smaller reason. Nothing was
built towards one, and CLAUDE.md says nothing may drift towards one. Do not
re-derive this: the number is the decision.

Three things can be drawn honestly from the tree, and were:

### The class diagram, finished

Four marks were missing that need no resolution at all — they are in the
declaration. Measured on this repository before the work: 890 TypeScript
fields, 206 with a type the parser could name, 217 optional (`x?: T`,
`T | undefined`), 146 arrays, 1 built inline with `new`; and **1 association
edge**, because only a class was an owner and 205 of the 209 typed fields were
interface properties. Once an interface owns its members the way a class does
the same tree drew 142 associations carrying 152 roles (27 optional, 71 many,
10 edges spelled by several fields) and 28 `depends` edges, 0 guessed.
Re-measured on 2026-09-04 with the tree a little larger: 143 files, 969 fields
(225 optional, 153 many), **148 associations, 159 roles** — 30 optional, 77
many, 1 composition, 0 aggregation, 11 edges with several roles — and **28
dependencies, 0 guessed**. On ~/IdeaProjects (199 Java files): 223 fields, 133
handed in through the constructor, 8 built with `new`, 0 both; 9 association
edges — 2 composition, 8 aggregation — and 10 dependencies, 0 guessed. So a
diamond is a Java, C# or class-heavy TypeScript thing: on a TypeScript project
almost every association is an interface property with no constructor to say
who owns the part, and the graph says nothing rather than guessing.

The decisions:

- **One `ownership` field with absence as the third state**, not two booleans.
  Composition and aggregation are exclusive by definition, so two flags would
  admit a state that means nothing. The parser reports `composed` and `handedIn`
  separately — it saw what it saw — and the store decides: **both marks mean
  neither**, because `x = new T()` beside `if (t) this.x = t` is a source that
  said two things, and a half-true diamond reads as authoritative. `ownershipOf`
  in `view/select.ts` applies the same rule again over a line that stands for
  several fields, and it is also what picks the panel's word, so the shape and
  the phrase cannot disagree.
- **`composed` only when the constructed type is the field's own declared type.**
  `items: Item[] = []` builds a container; `log: Logger = new ConsoleLogger()`
  builds something the file cannot say is a Logger without a resolution it
  cannot do. Both stay plain.
- **`*`, not `1..*`, for an array.** `Node[]` says nothing about being
  non-empty. The old CLAUDE.md sentence "for 1..*" was the one line this
  contradicted, and it was corrected.
- **`depends` is a kind, not a flag on `associates`.** `edges.ts` counts
  `associates` as reaching — the hook's sentence and the panel's "used by" read
  that set — and a class that takes a Store as a parameter must not be told it
  holds one. A kind is what `?edges=` and the socket spec already switch on, and
  the compiler tells every exhaustive switch. `edges.test.ts` pins that
  `depends` does not reach. The panel lists it anyway, marked as its own
  widening; the hook does not.
- **A dependency is drawn only for a name the class reaches no other way.** A
  dashed line beside a solid one to the same box would say less than the solid
  one already does.
- **No oracle fixture was added.** The TypeScript checker cannot vouch for a
  diamond or a dashed line, and a file under `src/oracle/fixtures/` would move
  the pinned file count in `checker.test.ts`. The corpus baseline is where this
  lands: `scripts/baseline.mjs` lists `depends`, and the four clones' records
  have to be re-accepted after a fetch.

Verified on the page: no real box in reach carried all three line kinds to
distinct files, so the three were checked on three Java boxes — Program.java,
Ansatt.java, Operations.java — rather than one. Three of the interactions (the
follow mark, the menu bar) did not receive OS keystrokes mid-session and were
dispatched onto the page's own listeners instead, and were labelled so.

### The component diagram

The categories as boxes, the imports between categories summed onto one line per
pair, and each box listing what it *provides* — the symbols in it that files
outside it actually reach, read off the four reaching edge kinds and never off
imports, which name no symbol. It is honest for the reason the package diagram
is: the same import data, summed one level up.

- **No cache of the clusters.** `clusterFiles` measures 0.73 ms on this
  repository's 139 files and 3 905 edges and 0.34 ms on 204 Java files; the merge
  with the stored names 0.10 ms. A push to every component-diagram client after
  a save costs less than the view it draws, so `Session.clustersOf(graph)` is
  computed per call. A cache keyed on the graph object would be correct and
  would be paying for a cost nobody has measured.
- **Leaves, not the outer level.** On one graph of this repository the engine
  found three peers of 61, 11 and 3 files; on the next — one unrelated edit
  later — one 75-file outer group at 97% holding six. Drawn at the outer level
  that was one box with three lines, and the one category a person had named
  ("Prog.lang decoder") was folded inside it; drawn at the leaves it is six boxes
  and twenty lines either way. The leaves are the level a whiteboard shows, and
  they were the level that held still.
- **The partition's first-listed rule and the page's overlapping-frame rule
  agree** about a hand-drawn group inside a found one: the derived groups come
  first, largest first, so a drawn category entirely inside a found one claims
  no file and is no box — which is the call `frameClusters` already makes when
  two frames overlap and the more cohesive keeps its frame. This repository's
  "Lang decoder" (7 files by hand) inside "Prog.lang decoder" (12 files found)
  is that case on both diagrams.
- **`diagram` rides both wire formats under one key.** Probed: a socket that
  sent `diagram: 'components'` was pushed component boxes; before `toSocketSpec`
  read it, the same socket was pushed the class diagram under a page drawing
  components — the silent widening CLAUDE.md warns about, in a new key.
- **The pulse works through it.** A hook landing on a file inside a component
  pulsed the component box 208 ms after the POST.
- **The stored names live in the session** (`groups`, `refreshGroups`), read on
  the way in by a component view and on the way out by the two routes that write
  groups.json, before they announce — a push from the session's previous copy
  would draw the box under the name it just lost.

Verified on the page: three component edges, two diamonds and one flow were
checked by hand against the graph the CLI prints, which is the scratch script
for this round.

### The activity diagram of one function

CLAUDE.md said activity diagrams are "not derivable from static structure at
all". Across files that is true. Inside one function body it is false — an `if`
is an `if` in the tree, a loop is a loop — so this is the one behavioural diagram
that can be complete rather than a sample, and the only reason it was built.

- **Through the pool, never on the main thread** (decision 1). The flow is a
  parse: the worker re-reads the file, because a worker keeps no source, parses
  it with a parser of its own, finds the function in the symbol's range and walks
  it. Measured 1.65 ms a request end to end over every function and method of
  this repository (1.8 ms in the round that built it). `createRequire` is no
  longer confined to `extract.ts`: `worker.ts` builds its parser with it, and
  `src/lang/*` load their grammars.
- **Never in the graph** (decision 3). It is computed per request from the
  working tree and answered by `GET /api/flow` as a detail about one symbol,
  like `/api/symbol`. That is also why there is no `?at=`: a commit's files are
  unpacked, scanned and removed by `history.ts`, so there is nothing on disk to
  read them from, and a live flow under a commit's name would be the wrong
  picture that looks right.
- **Measured over this repository on 2026-09-04:** 998 functions and methods
  asked, 919 drawn (the rest have no body — overloads, interface methods), 607
  with control flow, median 7 boxes, 18 over 40, largest `web/src/App.tsx#App`
  at 194 boxes over 3 966 lines. `src/graph/store.ts#derive`: **116 boxes, 158
  edges** — 27 decisions, 16 loops, 67 actions, 4 exits — with 14 function
  bodies inside it not walked and 19 ternaries inside larger expressions
  counted, not drawn. Over ~/IdeaProjects: 519 Java methods, 505 drawn, the
  largest 19 boxes, 0.28 ms each. Hence the 40-box gate: the size is said
  before it is drawn.
- **In the browser:** derive is 6.6 ms server-side and 26.5 ms to lay out and
  mount; `applyBatch` 11 boxes / 14 edges / 2.5 ms; `git` 7 boxes,
  `readSettings` 12. The whole diagram is rebuilt on every read, because the
  engine's ids (`n<index>`) are not stable across edits; the page draws nothing
  the engine did not send and adds no branch.
- **Two bugs found by running every symbol of both trees, fixed before it
  landed, both pinned in `flow.test.ts`:** a `finally` box with nothing into it
  when every path in the try returned (`history.ts#graphAt`), and an empty box
  drawn from the statement tree-sitter invents to recover from `if (a || b)`
  with nothing after it (a broken student file).


## Never draw the hairball (2026-09-07)

The course change, and the numbers that made it. The rule is in CLAUDE.md
under the same title; this is what was measured, on a copy of astrupdata —
368 files, TypeScript, Next.js — and what was decided from it.

### The measurement

The user opened the tool on their own project and said: too many lines, no
overview, unsure it gives any value at this size. Measured, they were right.
The root was 12 boxes and fine. One level in, `lib` was **106 boxes** — 53
files inside and 53 dimmed directories outside, both drawn — **427 lines** over
125 files, laid out as one strip zoomed to a smear. The Data Pipeline category
was 96 members and 32 external boxes, 128 in all, and 462 lines. The clustering
offered "Terminal App, 254 files, 98%", which is the algorithm saying
everything imports everything: true, and worthless. The screenshot answered no
question a person has.

Every tool that drew the big graph hit this wall. Sourcetrail's answer after
years of trying is the one adopted: never draw it. The default view is one
symbol and its neighbours; the overview is a list; the diagram is something you
go to. The engine — the graph, the seven languages, the honesty rules, the live
update, `?at=` — did not move. The view layer turned.

### The list

- **Thirty boxes, decided on the server.** `LIST_ABOVE = 30` is where a
  diagram of this project's boxes on this project's canvas stopped answering
  "what is in here" faster than a list would. The rule lives in
  `presentationOf` over the `ViewGraph`, not on the page: two readers of one
  threshold is how a live push redraws a list as a diagram, and the page never
  re-derives it. `nodes.length` counts the external boxes, because they are
  drawn.
- **A focus is never a list.** The lines are the answer there; a list of
  neighbours with the lines taken away says less than the three boxes did. A
  diff is small by construction and is drawn for the same reason.
- **The row's numbers are the view's lines**, summed by weight, and a floor
  said only in the column title. `app/terminal/routes` at 17 boxes was the
  natural diagram on this copy; `app/terminal` is 41 and lists.
- **Faint lines are a DOM class, not state.** A hover that renders re-renders
  every edge, so the page toggles `edge-near` on the line elements. Measured
  with synthetic mouseover events, three real hovers for the long-task count:
  17 boxes / 51 lines, 0.118 ms mean and 0.4 ms max per hover; 41 boxes / 115
  lines, 0.112 ms mean and 0.5 ms max; only class-attribute mutations on the
  line elements, no mounts, 0 long tasks. "No re-render" is argued from the
  absence of state and of any non-class mutation, not from React internals.
- **Mark, do not move, in a list.** `holdOrder` keeps the order across a save.
  Measured: `lib` sorted by In, two imports added by hand, 106 rows in the same
  order with three counts changed in place. The DOM was read 3 s after the
  save, so the counts and the order were seen and the 2.5 s pulse was not.

### The front page

- **What astrupdata names.** 57 manifest entry points — 36 Next pages, 7
  routes, 4 layouts, 3 fallbacks, 6 scripts, 1 `main` — and 87 roots, of which
  70 are under `scripts/` and 7 are `app/` components nothing imports, grep-
  verified dead. `gatherFacts` 2 ms, `overviewOf` 1.7 ms, the route 25 ms.
  Layouts and fallbacks were named at all because they were the top of the
  roots list before they were: a layout wraps every page below it and nothing
  imports one.
- **Grouped by reason, capped at twelve roots, the page is 38 rows.** 57 rows
  of entry points is the hairball again, as a list; one row per reason, biggest
  first, folded at nine or more, is a page. Twelve roots with the total beside
  them, and the total is a count with no view behind it yet — the one number
  on the page that leads nowhere, and it says so in its title.
- **Go `func main` is read in facts, not off the graph.** The parser already
  reads `package main` as `moduleName`, but a parse result is not a fact —
  facts are gathered while the workers parse, and the graph carries no module
  name a pure module could read later — so the head of each `.go` file is
  read once more as the manifest of itself. Both halves are required: `cmd/foo/`
  is three files in `package main` and one start. Fixture-tested only; no Go
  clone was on hand and a test never clones.
- **The front page drops the filters on the way in.** A filter filters a
  diagram, and there is none here; the rows build their links afresh, so a
  `tests=0` set three views ago does not ride into the focus view an entry
  point opens. `?scope=` with an empty value is how the root diagram is still
  reached — the key is what makes it a diagram — and `?scope=&as=diagram` is
  "Draw the whole project", the one row that asks for the big graph on purpose.
- **A frozen front page is refused, not approximated.** `Session.graphAt`
  hands back a `Graph` without the `ProjectFacts` `history.ts` gathered beside
  it. Answering with today's facts filtered to the commit's files would be
  right for every page that existed then and still does, and silently wrong for
  one deleted since — the mostly-right picture the tool refuses to draw.

### The structural diff

- **Two graphs, set arithmetic over ids.** Ids are stable across parses, so a
  node in both graphs is the same declaration and a node in one is one that
  came or went. `contains` is not diffed: a symbol's container is spelled in
  its id, and counting both would report a class that gained a method as two
  changes. `touched` follows outgoing edges only — a file that gained an
  importer did nothing. `modifiedAt` is left out of "same declaration": a
  commit's graph is unpacked moments before it is scanned, and a clock would
  touch every file at every commit.
- **Measured against git.** astrupdata HEAD~5 → HEAD: files +2 −1 M39 against
  git's A2 D1 and M41 source files, the two misses a className string and a
  comment — edits that move no declaration and change no resolved reference,
  which the diff cannot see and says so; symbols +22 −5, edges +156 −2, 619 ms
  including two commit builds; HEAD~1 → live 347 ms. base → live with three
  edits made by hand (a function added, a file deleted, a class with a method
  added): files {2 added, 1 removed, 6 touched}, symbols {189, 1}, edges
  {226, 8}, against `git diff --stat HEAD` = 3 files +13 −37 — the same three
  files plus two gitignored ones, `functions/lib/index.js` and
  `next-env.d.ts`, which the live scan reads off disk and `git archive` does
  not hold: 184 of the symbols and 226 of the edges are those two, before the
  session's own edits. dc7d76f → 2db63b9: files {1 added, 1 touched} against
  git's 2 files, the same two.
- **The `~2` hole is pinned, not hidden.** The suffix names a position among
  namesakes, so removing the first of two overloads reads as the second removed
  and the first moved, and a swap reads as every edge moved. `graph/diff.test.ts`
  pins that reading, built through the store so the ids are the live ones, and
  `DIFF_CAVEAT` rides every `/api/diff` reply for the panel to print.
- **`session.graphAt` is handed a sha, never a ref.** Its `spelled` cache pins
  every spelling to the sha it resolved to the first time — right for `7fe7f88`
  and wrong for `HEAD`, which names a different commit after every commit.
  `resolveDiffEnds` resolves `base` with `resolveCommit` first, and is shared
  by `/api/diff` and `/api/view?diff=` so the canvas and the lists cannot be
  between different commits.
- **The hub cannot draw a diff yet, and does not pretend to.** `live.ts` holds
  one graph, so a diff client is pushed the ordinary slice with `diff` dropped
  from its echo; the page reads the mismatch as "the diff changed" and refetches.
  Probed: the route's echo `diff: "base"` with 9 nodes, the hub's push
  `undefined` with 12 — the silent widening CLAUDE.md warns about, caught by
  the echo rule. The three optional keys are read for both wire formats by one
  `optionalKeys`, checked the same way: send the server's own spec back.
- **The ghost.** A removed file is drawn from the before graph — dashed like a
  box outside the scope, dimmed a little further, its name struck, a `D` —
  and never a new hue. Its panel reads `/api/detail?at=<from.sha>`, the only
  graph that still holds it. "Add a method" was driven as a class added with
  its method, because astrupdata's HEAD holds no class and the copy may not be
  committed to; a method added to a class already in the base takes the same
  path in `diffview` and was not seen on screen.

### Verified on the page

On a copy of astrupdata served from a copy of this tree: `.front-row` and
`.list-row` measure 22px, 0 uses of the accent on the front page, 0 new hex
colours in the built CSS, one Tab stop in the list and one on the front page.
The list's per-row in and out matched `/api/detail` on the rows sampled; the
category 404 was measured by curl and is not pinned, there being no route
tests. Two interactions were driven with dispatched KeyboardEvents when OS
keystrokes stopped reaching the tab, and were labelled so in the evidence.


## Where the database is in the code (2026-09-08)

The user asked whether the tool could show the database. CLAUDE.md said "ER
diagrams are out of scope", decided in the abstract. It was reconsidered on
evidence — eight stacks on real repositories, measured the same day — and the
evidence narrowed the sentence rather than overturning it. The rule is in
CLAUDE.md under the Graph model; this is what was measured, what was built,
and what was refused by name.

### The first fact

The project the user opened has no database. On webapp-h26, `grep -rln
"EntityFramework|DbContext|DbSet|ConnectionString"` over its `.cs`, `.csproj`
and `.json` finds nothing; BackendAPI.csproj references one package
(Microsoft.AspNetCore.OpenApi) and the API is the WeatherForecast template.
Their other repositories are the same shape: astrup is Firestore — 243
`collection(` calls, a firestore.rules, no schema in code because Firestore
has none — and IdeaProjects has four files touching `java.sql` and no `CREATE
TABLE`. Nothing under this heading draws a single mark on the project the
question was asked about. It was built for the next project, and said so.

### What the code states, stack by stack

Two facts are stated in code almost everywhere: *this class is a table*, and
*this class holds that one* — the navigation property, which the graph
already draws as `associates` with a role and a multiplicity. What is stated
past those two varies by stack, and that is what decided the design:

- **EF Core** (eShopOnWeb, CleanArchitecture, dotnet/eShop): `DbSet<T>` is
  the one line that says T is a table, and it never over-counts — every T it
  names is a `CreateTable` in the migration beside it. Everything else is
  convention or a lambda in another project: `[Key]`, `[ForeignKey]` and
  `[Table]` are written **0 times in all three repositories** (56 `[Required]`
  and 1 `[NotMapped]` are the only data annotations); keys are `Id` by
  convention (5 of eShopOnWeb's 7 tables; 2 have `HasKey`); table names are
  stated 1 in 7 (`ToTable("Catalog")`). eShopOnWeb's migration creates four
  foreign keys: two from fluent `HasForeignKey`, one from a name convention
  (`BasketItem.BasketId`), and one — `OrderItems.OrderId` — a **shadow column
  no source line holds** (`grep -c OrderId OrderItem.cs` is 0). A reader that
  took `XxxId` for a foreign key would be wrong 4 times in 7 on that repository
  (CatalogItemId ×2, BuyerId ×2 are not) and still miss the shadow one.
  dotnet/eShop names a foreign key on a *private field* by string,
  `HasForeignKey("_cardTypeId")`, and declares 2 of its ordering schema's 7
  tables only through `ApplyConfiguration`/`ToTable`, never a DbSet — so
  `DbSet<T>` under-counts, and never over-counts. `: BaseEntity` is not a
  table test either: Buyer and PaymentMethod extend it and are in no DbSet and
  no migration, 2 of 9.
- **JPA** (spring-petclinic, jhipster-sample-app): `@Entity` states the table,
  `@Id` the key, the field's type the relation (100%), and `@JoinColumn` the
  column — written 4 times in 7 across the two. petclinic's `@Id` sits on a
  `@MappedSuperclass`, and the store does not walk inheritance for members.
  Its `schema.sql` holds 5 `FOREIGN KEY` lines for 4 relations, and the graph
  already draws all 4 associations.
- **TypeORM** (typeorm's own test entities, 1 405 `@Entity`): the key is
  always stated (`@PrimaryGeneratedColumn` 1 018 + `@PrimaryColumn` 485), the
  target is the field's type (219 of 237 `@ManyToOne` agree with the arrow
  function), the column name is convention 86% of the time (34 `@JoinColumn`
  in 237) and the table name 88% (165 named). typescript.ts reads decorators
  only for calls; the class's own are unread.
- **Prisma** (cal.com, 2 851 lines): everything is stated column by column —
  100 models, 175 `@relation(fields:)`, 93 `@id` + 4 `@@id`, one implicit
  many-to-many — and it is the most expensive to reach: `.prisma` is claimed
  by no language, and tree-sitter-prisma@1.6.0 parses the whole schema with 0
  ERROR nodes but ships no prebuilds, so every `npm install` would compile it
  (it fails under Homebrew's python 3.14 and needs `--python=/usr/bin/python3`)
  and prepare-resources.mjs would have to ship the addon.
- **Drizzle** (openstatus, 54 tables) and **Mongoose** (Overleaf, 33 models):
  stated, and undrawable under the current model, because a table is
  `export const monitor = sqliteTable(...)` — a top-level `const`, which
  CLAUDE.md says is not a node. The engine draws 0 classifiers for either.
  Mongoose's `ref` is optional and **36 of Overleaf's 73 ObjectId fields omit
  it** (49%; devconnector 3 of 4).
- **SQLAlchemy** (airflow, 52 `__tablename__`) and **Django** (saleor, 249
  models): the table is stated (`__tablename__` is already a field row on
  every model class; `models.Model` is in the extends), the key is stated
  (`primary_key=True`), and the relation target is a **string** 85 times in 93
  (`relationship("DagRun")`) and 67 in 242 (`ForeignKey("Product")`), which
  python.ts does not read; `Mapped[DagRun]` is not in its TRANSPARENT list.
  The engine draws 1 association for airflow's models and 0 for saleor's.

### What was built

- **`DbSet` is in C#'s `MANY`.** A bug by the rule the comment above `MANY`
  states: `DbSet<T>` is a collection of T, and left out it reduced to a type
  named `DbSet` that resolves to nothing. eShopOnWeb's CatalogContext drew
  seven properties and no edge; it draws seven `1..*` lines now.
- **A `«table»` stereotype on the class, not a NodeKind.** `GraphNode.stereotype`
  is `{ name: 'table', statedBy }`, the id of the `DbSet<T>` property that said
  it. UML's own data-modelling profile is a stereotype on a class, and the
  model already holds classifier, field, association, role and multiplicity.
  A `table` NodeKind was costed at the 15 files that switch over the kinds
  (edges.ts REACHES, filter.ts, detail.ts, search.ts ranking, server/diff.ts,
  oracle/checker.ts, parser/flow.ts, api.ts, the Sidebar, App and
  RelationEdge) plus four kind-keyed CSS rules — and it would split a JPA
  entity, which has methods and a superclass, into a class and a table, the
  lie in the other direction. The mark follows `isAbstract`'s path instead.
- **Derived in the store, reported by the parser on the field.** The
  declaration sits on a different class in a different file from the class it
  describes, and a file is parsed alone, so csharp.ts writes
  `typeStereotype: 'table'` on the property and `derive()` stamps the class
  `typeName` resolves to, beside the association it draws from the same
  lookup. The first declaration to name a class keeps the credit; an
  interface is never marked; a guessed resolution stamps nothing, because the
  line is only as sure as its far end. Pinned in `store.test.ts`.
- **On the class's own row, before the name.** UML puts a stereotype on a
  line above the name; here `layout.ts` measures every box from its row
  count, so a second line for one class would move every box under it. The
  guillemets are text, like the visibility marks. The row's title names the
  line that said it — "a table, by the word of CatalogContext.Baskets in
  src/Infrastructure/Data/CatalogContext.cs" — and says that a class without
  the mark may still be one, because a mark nobody can check against a line
  is the convention this project refuses.

### What was refused, by name

- **EF Core keys, foreign-key columns and table names.** The numbers above:
  0 attributes in three repositories, a shadow column, a private field named
  by string, an `XxxId` rule wrong 4 in 7. The has-a line the navigation
  property draws is what the source states, and it is drawn.
- **`[Key]`, `[ForeignKey]` and `[Table]` when literally written.** Stated,
  and readable off `attribute_list` in twenty lines — and written 0 times in
  every repository measured, so there is nothing to check a reader against.
  A language is finished when its edges are checked against a real
  repository, not when it parses; this waits for a repository that writes
  them.
- **`: BaseEntity` and `XxxId` as evidence.** 2 of 9 and 4 of 7, above.
- **JPA, TypeORM, SQLAlchemy and Django table marks.** Each is stated and
  each is one reader's change (`@Entity` beside `isNullable` in java.ts; the
  class's `decorator` children in typescript.ts; a `__tablename__` field-name
  test and `Model` in the extends in python.ts). Deferred, not refused on
  evidence: the brief was one stack, narrowly, and the user's is EF Core.
  JPA is the cheapest next and spring-petclinic's `schema.sql` is its oracle.
  The string-typed relation targets of SQLAlchemy and Django are a further
  call-argument reader and a project-wide name lookup, and are not to be read
  until that exists.
- **Drizzle and Mongoose tables.** A top-level `const` is not a node, and
  making one for a const bound to a known call is a graph-model decision to
  argue for in writing, not to slip in under this heading. Mongoose's
  ref-less ObjectIds — 49% of Overleaf's — are refused as edges either way.
- **Prisma.** A language file, a grammar with no prebuilds compiled on every
  install, and — once it existed — an island, because `prisma.booking.findMany()`
  is a call on an untyped receiver and no app file would reach a model.

### Verified

Re-measured here on eShopOnWeb at 4da8212 with the CLI (`node dist/cli/index.js
<clone> --json`): 256 files, 240 classes, **7 `«table»`** — Basket, BasketItem,
CatalogBrand, CatalogItem, CatalogType, Order, OrderItem — each credited to
its `CatalogContext.<DbSet>` property, and the same seven the initial
migration's `CreateTable` calls make (Baskets, BasketItems, CatalogBrands,
Catalog, CatalogTypes, Orders, OrderItems). Buyer and PaymentMethod are
unmarked, as the migration has them. CatalogContext draws 7 associations, all
`*`, 0 guessed of the graph's 2 155 edges. The migration's four foreign keys
are the four has-a lines the entities already drew — Basket→BasketItem,
CatalogItem→CatalogType, CatalogItem→CatalogBrand, Order→OrderItem — and none
of them wears a key or a column name, because no source line names one. The
seven `PrimaryKey(x => x.Id)` calls are convention and draw nothing.

On the page, served from a copy of this tree on port 4901 with the focus on
`CatalogContext.cs` at one hop and associations on: 9 boxes, 19 lines, the
context's seven `1..*` lines each labelled with its property, and **7
`.member-stereotype` rows reading `«table»`** — Basket, BasketItem,
CatalogBrand, CatalogItem, CatalogType, Order, OrderItem — with CatalogContext
the one class row without it. Every member row measured 17px by `offsetHeight`
with the mark in it, so `ROW_HEIGHT` and the layout are untouched; the mark's
colour read `rgb(157, 157, 157)`, the muted token; the row's title read "a
table, by the word of CatalogContext.Baskets in
src/Infrastructure/Data/CatalogContext.cs. A class without this mark may still
be one: only a declaration puts it here". The screenshot was kept at
`/tmp/eshop-tables.png`. The server and the copy were removed afterwards.
