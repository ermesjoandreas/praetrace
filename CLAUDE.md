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
- Architectural groups, named by a person or an agent — or suggested by a model
  and accepted by a person — committed to the project
- An MCP server, so the agent working in the project can query the graph
- Search, call edges, a side panel, a menu bar, a welcome screen
- Git status against a chosen base, and a group editor
- Explain: a paid, on-request reading of what a symbol is for, and whether it still
  matches the code it described
- Source Control: the commit graph with its threads, the diagram frozen at any
  commit (`?at=`), and a Repository panel — project, remote, hook and MCP
- Coverage read from what CI already wrote — never run, never instrumented, and
  absent is never zero
- The hook answers: after every edit it tells the agent what the file it just
  wrote is coupled to
- An oracle: the TypeScript checker as a re-runnable test, `scripts/oracle.mjs`
  over any repository and `src/oracle/checker.test.ts` over a pinned fixture

**What to build next, in this order.** Each is small, and each is here because
something in the last round of work argued for it:

1. **Close the loose ends.** `Session.gitBase()` has no caller; use it or delete
   it. A directory specifier resolves to `index.*` only — `package.json` `main`
   needs a fact on `ProjectFacts` gathered by `project/facts.ts`. A static call on
   a class name (`Store.create()`) is not qualified, because the parser cannot tell
   an imported class from a namespace object without the bindings it now records —
   it can, so do it.

2. **A corpus regression test.** Half of it exists: `src/oracle/checker.test.ts`
   pins our graph against the TypeScript checker's over a fixture, which is what
   catches a composition that lies while every function in it is right. What is
   left is a baseline over a real clone — `scripts/corpus.mjs` and
   `scripts/oracle.mjs` both print the numbers; nothing yet compares them to a
   checked-in expected file.

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

**A file can be the source of a call.** A call written outside every symbol — a
bare statement, a top-level `const` bound to something that is not a function, an
IIFE's arguments, a decorator on an exported class — has no caller node and used
to be dropped: 133 of express's 218 missing call edges, 3 264 of zod's 6 013,
1 869 of query's 2 572. It is collected as `ParsedFile.calls`, the file's own list,
in the same reference forms a symbol's calls use, and resolved through the same
lookup. No new NodeKind: a top-level constant does not become a node, its calls
become the file's. Worth 1 560 edges on zod and 1 675 on query. A file never calls
what it declares itself, and never itself. The edge means *this file calls that* —
not "at load": a call in an object-literal method or in an arrow passed to
`test(...)` lands there too, because neither is a symbol in our model.

**A name the symbol bound itself is never the module's.** A parameter, a `var`,
`let` or `const`, a destructured binding, a nested `function` or `class`, a catch
parameter — whatever it was bound to — hides the file's import or top-level
declaration of the same name for its whole scope, and so does the type written on
it. All three edges the TypeScript checker called lies were this one rule missing:
express's `var View = this.get('view')` reaching the imported `View`, and zod's
parameter named `Class` reaching the file's `export abstract class Class`.

**Methods and fields are not in the name-resolution table, and a bare name never
reaches them.** In TypeScript and JavaScript a call on an untyped receiver —
`x.map(...)` where nothing says what `x` is — reaches the graph as *nothing*: it
used to arrive as the bare `map`, which could only ever land on a same-file
declaration of that name, and did (zod's `def.items.map()` inside the file that
declares a `map()` factory). Go and Java keep their own rules. A missing edge is a
gap; a wrong one is a lie. **The one door in is
a qualified call.** A parser writes `T.m` only when the receiver's type was written
down — `this` inside `T`, a parameter or field declared `x: T`, `= new T()`, a
`private log: Logger` parameter property, Go's `c *Command` receiver or
`&Command{}`, Java's typed field, parameter or local — and the store resolves it
to `path#T.m` when `T` resolves to a class or interface that declares `m` (in Go,
anywhere in the same package: a method lives wherever it was written). Go
references across packages are spelled `<importPath>#Name` and `<importPath>#T.m`
(`QUALIFIED_SEPARATOR` in `parser/types.ts`), whose head is one of the file's own
imports, so `viper.New()` can never land on a local `New`. An ES `#private` member
is `T.#m` — the `.` before the `#` is what tells the two forms apart. `this` inside
a nested `function` expression or an anonymous class body is nobody's.

**A name resolves only through what the file bound.** `ParsedFile.bindings` records
every import binding a TypeScript or JavaScript file made — `{ a, b as c }`, a
default, `* as ns`, `require` — and `lookup` admits a name from another file only
through a binding: by `imported` into that specifier's export table, or, for a
namespace, `ns.name` through the alias. Before this, a barrel that re-exported 150
names made every bare property call in every importer a candidate for one of
them, and zod drew `process.hrtime.bigint()` as a call to its `bigint()` schema
factory. A language whose parser records no bindings keeps the whole-table rule.

**A barrel is followed, and only for what it exports.** A name imported from a file
that only re-exports it — `export * from`, `export { A as B } from` — lands on the
file that declares it, eight hops deep and cycle-safe, so `new QueryObserver()` in
react-query reaches `query-core/src/queryObserver.ts` through
`@tanstack/query-core`'s index. `ParsedSymbol.exported` keeps a private
`function secret()` from riding through `export *`; `export * as ns from` names a
module, has no node, and is skipped.

**`describeSymbol` says how much it knows.** `coverage` is `partial` for every
method and field (calls through an untyped receiver are not tracked, so an empty
list means unknown, not none), for a dotted top-level name like `app.init` (called
through the object it hangs off), and for an interface or type (uses in type
positions are not tracked); `full` for a function or class, whose note still says
a function passed by value is not tracked. The panel, the chip and the explain
prompt all show `coverageNote`, and a method never reads "0 in".

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
node scripts/oracle.mjs <dir>     # where the TypeScript checker says we are wrong

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
    edges.ts      which edge kinds mean "reaches" — one home, two readers
    resolve.ts    module specifier -> file, given the set of known files
    store.ts      holds parse results, derives the graph, emits deltas
  git/
    types.ts      GitFileStatus / GitStatus — pure, so the view can name a
                  status without importing the module that shells out
  report/
    types.ts      FileCoverage / SymbolCoverage — pure, so the view can carry a
                  number without importing the module that reads the artefact.
                  Named report/, not coverage/: `coverage` is in walk.ts's
                  IGNORED_DIRECTORIES, so a module there is invisible to our own
                  scan — which is how it was found
  lang/           one file per language, to the contract in types.ts
    types.ts      LanguageSupport / LanguageParse / ResolveContext / ProjectFacts
    registry.ts   extension -> language; what "cannot read" is the complement of
    typescript.ts the reference reader the JS one shares: scopes, typed
                  receivers, re-exports, bindings, property-assigned functions
    javascript.ts, java.ts, go.ts, csharp.ts, rust.ts
  oracle/         a second opinion from the TypeScript checker — dev only, never
                  in the live path, never imported from server/, cli/ or project/:
                  it pulls in `typescript`, a devDependency
    checker.ts    ts.Program -> our edge shape, with the diagnostics gate
    fixtures/     the shapes that have caught us before, pinned
  parser/         everything that knows about ASTs
    types.ts      ParsedFile / ParsedSymbol + worker message shapes
    extract.ts    tree-sitter -> ParsedFile (the only module using createRequire)
    worker.ts     worker_threads entry: reads a file, parses it, replies
    pool.ts       fixed pool of parser workers, one file at a time each
  project/        the project on disk, and everything that changes it
    walk.ts       boot scan + the ignore/source predicates everything shares,
                  and the census of what no language claims (countUnreadable)
    scan.ts       walk + parse everything through the pool
    watch.ts      chokidar; emits raw changes, does not batch
    git.ts        git status against a base -> GitStatus; the log, the remote,
                  fetch, resolveCommit, archiveCommit. Read-only, and never throws
    history.ts    one commit's graph: git archive -> temp dir -> scanProject
                  through the session's pool. Never throws, never leaves the dir
    groups.ts     named groups, their colours and sizes, .codemap/groups.json
    coverage.ts   what the test suite executed, read off lcov or istanbul.
                  Never runs anything, never throws; absent is never zero
    explain.ts    spawns `claude -p` for a reading of a symbol. Never throws
    suggest.ts    spawns `claude -p` for names for the unnamed groups. Never
                  throws, never writes; a person accepts, and that is the write
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
    lanes.ts      lane assignment for the commit graph — pure
    tests.ts      isTestFile(path): the one predicate clustering, the filter,
                  search ranking and the box tag share
    *.test.ts     beside every pure module. `npm test` runs them all, and
                  web/src/*.test.ts with them
  cli/
    index.ts      arg handling + text/JSON output
  server/
    session.ts    one project: store, pool, watcher, updater, git, an LRU of
                  16 past commits' graphs, and the last suggest run. Swapped whole
    app.ts        Fastify: static web build, and the API below
    live.ts       connected clients and their view specs; pushes per client,
                  and `groups` to every client after a groups.json write
    main.ts       boot scan, wiring, listen
web/              the browser page (Vite, built into dist/web)
  src/App.tsx     URL <-> view, live updates, breadcrumb, focus, depth, selection
  src/BoxNode.tsx one box: a file with its symbols, or a folder
  src/GroupNode.tsx a group frame: name, colour, size, membership
  src/Sidebar.tsx the right side bar: Following (with its readings) and Detail
  src/Categories.tsx   the left bar's third section: every group with its
                       cohesion or "by hand", the editor (name, colour, members,
                       delete), the create-from-selection form, and the model's
                       suggested names with accept / dismiss
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
  src/layout.ts   dagre for a view's first layout, keepLayout for every save after
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
                        an unknown one, never the live graph under its name.
                        404 too for a focus or scope the graph has not got —
                        never the root view under a bogus name. The view carries
                        fileCount, hiddenTests and parseErrors for the whole graph
GET  /api/project       the current root
POST /api/project       switch to another root
GET  /api/detail        one node's dependents and dependencies       (?at=)
GET  /api/symbol        one symbol's relations, plus coverage and the note that
                        says what an empty list means                (?at=)
GET  /api/log           the commits on every ref, newest first, plus HEAD and
                        the checked-out branch
GET  /api/repo          what the repository is: files, remote, hook, MCP, languages
POST /api/fetch         git fetch. The only verb that is not a read
GET  /api/changes       this session's change feed
GET  /api/search        subsequence search over the whole graph, or over a
                        commit's                                      (?at=)
GET  /api/agent         what the agent has asked, and when
GET  /api/clusters      { clusters, orphans }: the groups, named and unnamed,
                        and the stored names that match nothing      (?at=)
POST /api/clusters      accept or reject one, by membership (and by id, so a
                        rename of a drifted group replaces its entry)
POST /api/groups        create, update or delete one, by storedId. Answers
                        { clusters, orphans } like the GET
GET  /api/suggest       { result, running }: the last run's suggested names, or
                        null, and whether one is in flight. Session state, never disk
POST /api/suggest       ask a model for names for the unnamed groups. Awaited,
                        not 202: 400 when nothing is unnamed, 409 while a run is
                        in flight. Spends money, writes nothing
GET  /api/explain       the readings for the ids asked for, and the run
POST /api/explain       run (202), cancel, or forget one. Spends money. Skips ids
                        whose reading is current and names them in `skipped`;
                        `force: true` re-reads them; 400 when every id was current
GET  /api/git           the current git status
POST /api/git-base      change the base the working tree is compared against
GET  /api/hook-status   is a working hook installed
POST /api/hook-install  merge ours into whatever is there
POST /api/hook          the PostToolUse payload. Always 200, and answers with
                        what the file just written is coupled to, as
                        `hookSpecificOutput.additionalContext`
POST /api/note          the agent's own words about what it just changed
GET  /api/coverage      what the test suite executed, or { coverage: null }
     /live              the websocket. Besides views it carries `agent`,
                        `explain`, `explain-delta`, and `{ type: 'groups' }` after
                        every groups.json write — to every client, frozen ones
                        too, because a name lives outside the commit; the page
                        refetches /api/clusters on it
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
  of being mistaken for a working one. So does one that throws the answer away.
- **The hook answers.** Verified against a real run: a PostToolUse hook's plain
  stdout does *not* reach the model, and `systemMessage` goes to the user only —
  the one channel is JSON carrying `hookSpecificOutput.additionalContext`, capped
  at 10 000 characters. So `/api/hook` replies with what the file just written is
  coupled to, in prose, under 400 characters, and **says nothing when the graph
  has nothing worth saying**: a hook that always speaks becomes noise the agent
  learns to skip. It names the importers and the symbols actually reached from
  outside; it gives no ratio, because the graph cannot see a method called through
  an untyped receiver and a denominator would be a number it cannot support. The
  route still always answers 200 and never makes the agent wait.

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
/?tests=0                    without tests, fixtures and stories; hiddenTests says how many
```

**What a test is** is decided from the path alone, by `isTestFile` in
`view/tests.ts`: `*.test.*`, `*.spec.*`, `*.stories.*`, `*_test.go`,
`*Test(s).java`, `*Tests.cs`, `tests.rs`, and any `test/`, `tests/`, `__tests__/`,
`testdata/` or `fixtures/` segment. One predicate, shared by the clustering (tests
never vote on who belongs together), the `tests=0` filter, search ranking (code
before scaffolding) and the `test` tag on a box.

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
(`changed`, `edges`, `since`, `tests`); the websocket carries a `ViewSpec` object
with its filter nested (`onlyChanged`, `edgeKinds`, `sinceMs`, `hideTests`). Reading one with the other's
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
  subdirectory, so they are translated and anything outside is dropped. So are
  the tool's own files — `.codemap/` and `.claude/codemap.port` — from every
  status, line count and total: three reviewers watched "Changes" count
  groups.json. Every git command is scoped `-- .` and untracked files are listed
  one by one (`--untracked-files=all`), or a Java folder of 203 untracked files
  under one untracked directory read "Changes 0".
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
or an agent, gives them names — or a model suggests one and a person accepts it. See non-negotiable decision 5 for the rule that
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
  The rule: an exact stored id wins; otherwise Jaccard ≥ 0.6, or every stored
  member present and Jaccard ≥ 0.5 (a group that only grew); pairs are scored and
  taken best-first so a nested group is not eaten by its parent. A stored group
  that matches nothing is an *orphan* — returned by `/api/clusters`, listed under
  "Stored, matches nothing" with a delete — rather than silently never shown, and
  a group written before ids existed is given one on read.
- **Tests do not vote.** Clustering ignores test files and the edges into them:
  express once drew a "Benchmark suite" that was 82 tests out of 131 files. A
  cohesion percentage counts each edge once and is the share that stays inside
  the group; propagation is deterministic (sorted iteration), and a cluster found
  inside another carries `parent`.
- A group's **size** is the slack around its members, not an absolute rectangle. The
  frame hugs what it encloses; a free-floating box would describe nothing.

## The rest of the page

- **The left bar** is Repository › Source Control › Categories › Activity, 300px.
  The Repository panel absorbed the hook banner: hook, MCP and port file are rows,
  and "Install hook" is a button under them, hidden once installed. Activity
  describes *now* even while the diagram is frozen: the agent is still working in
  the working tree.
- **A category on the page is a group in the code.** The section, its menu items
  and the frame on the canvas say "category" — the user's word. The file stays
  `.codemap/groups.json`, the API stays `/api/clusters` and `/api/groups`, the MCP
  tools stay `list_groups` / `name_group`, the CSS classes stay `.group-*`. Do not
  "fix" either side toward the other.
- **The status bar.** 22px at the bottom: branch, ahead/behind, the "Changes" count
  that toggles the filter, then boxes and files, "N tests hidden" (a button that
  shows them) while `tests=0`, "N files with syntax errors" and "not read: …" for
  what the tool cannot fully read, the language summary and the agent's
  connection. Every item is information or runs something.
- **The menu bar.** Two rows: menus and project on top, breadcrumb and filter chips
  below. **Nothing in a menu is decoration.** Every item runs something the app can
  already do, and an item that needs a selection is greyed with the reason in its
  tooltip rather than silently doing nothing. View › "Hide tests" is a checked item
  that drives `tests=0`; View › "Re-layout" (⇧⌘L) is the only way after the first
  layout to run dagre again. Above 150 boxes in focus mode a chip in the breadcrumb
  row says "N boxes — depth 1 is quicker" and sets depth 1.
- **The welcome screen.** Shown from Help, and when there is genuinely nothing to
  draw. **Not** when a filter emptied the view. It covers the canvas, not the
  window — it used to position against the viewport and painted over the menu bar,
  both side bars and the status bar, which buried every way back out.
- **Search.** ⌘K searches the **whole graph**, not the slice on screen — the
  commit's graph while frozen. Matching is a subsequence, the way editors do it:
  `gst` finds `GraphStore`; ranking is exact name, then code before test, fixture
  and `.d.ts`, then match quality, then the shorter path. The keyboard owns the
  active row; the mouse only hovers and clicks.
- **Call edges** are off by default (`?calls=1`). When on, a call edge *replaces* the
  import between the same pair rather than being drawn beside it.
- **The side panel.** A followed method or field prints the graph's coverage
  sentence and "known used by N", never "0 in". Click inspects, double-click navigates. `zoomOnDoubleClick` is
  off and must stay off: d3-zoom handles a double click on the pane and stops it
  bubbling, so `onNodeDoubleClick` never fires and the view silently zooms instead.
- **The change feed** is the session's own history, the last 200 batches in memory,
  discarded with the session. It is *not* session history — that is VISION.md phase 1
  and it gets a schema designed for it rather than a ring buffer promoted into one.

## Live updates

Every connected client is sent a view **computed for its own spec**. The behaviour is
*mark, do not move*:

- A touched box pulses and holds a warm tint. The camera does not move.
- **dagre runs for a view's first layout — once its clusters have arrived — and
  for View › Re-layout, and for nothing else.** A save that adds a box keeps every
  existing box where it stands and puts the new one beside its most connected
  neighbour: to the right on a 40px grid, first free slot, below when the row is
  full; a box connected to nothing starts a new row under the diagram
  (`keepLayout` in `web/src/layout.ts`, tested). Frames are redrawn with
  `frameClusters` around wherever the boxes now are. The one existing box that
  moves is the column under a box that expanded, by its growth. Five reviewers
  named the shuffle-on-save as the thing that broke "mark, do not move"; do not
  bring back a layout key that re-runs dagre when the box set changes.
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
and nothing to keep in sync — with one exception. `note_change` carries a sentence
in the agent's own words, and a sentence with punctuation in it does not belong in
an HTTP header, so its route records the call itself. Two writers into one ring,
and they can drift. That buys one timeline (the agent's questions and the
file changes in a single column), a second pulse (a box glows blue when the agent
asked about it), and a status that names the tool and how long ago.

## The MCP server

`scripts/mcp.mjs` exposes codemap to whichever agent is working in the project.
`.mcp.json` wires it up.

The direction is the point. An MCP server is called **by** an agent and can never
call one, so *through MCP* the app cannot reach the agent already working in the
project. What it can do is offer that agent the unnamed groups, and `name_group`
is how the agent names them: for free, unprompted, whenever it chooses to.

**There is exactly one way in, and it is the hook, not MCP.** A PostToolUse hook's
`additionalContext` reaches the model — see *Event sources*. It carries facts the
graph already holds about the file the agent just wrote, never a request and never
a task.

**Since 2026-09-02 the app can also ask a Claude of its own.** `src/project/suggest.ts`
spawns `claude -p` — not MCP, and MCP's direction is unchanged — for names for
the unnamed groups, on a press of the lightbulb in the Categories section and
never otherwise. What comes back is a *proposal*, held in session memory. Decision
5 is what has not moved: the model suggests, the person decides, and accepting a
suggestion is the same `POST /api/clusters` write `name_group` makes, so
`groups.json` is written by a decision and nothing else. The two paths are for
different moments: the agent already running names for free while it works; the
lightbulb is for when no agent is running, costs about five cents a press, and
never decides who belongs.

```
list_groups     the clusters, named and unnamed; "by hand" for a drawn one,
                never a cohesion; nested ones under their parent; stored
                names that match nothing as "stored, matches nothing"
name_group      accept one with a name
describe_file   declares / used by / uses
search_symbols  subsequence search over the whole project
note_change     the agent says what it just changed, and why — at most 200
                characters, session memory, never .codemap/
```

It holds no graph of its own; it talks to a running codemap over HTTP and finds it
through the same `.claude/codemap.port` file the hook reads.

## Explaining what the graph found

The graph says a symbol is called by four things. It cannot say what it is *for*.
`src/project/explain.ts` spawns `claude -p` with the source and the graph's own
relations, and asks for a role rather than a walkthrough. Answers land in
`.codemap/explain.json`, beside `groups.json` — for the user to commit when they
choose; this repository's copy is untracked today.

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
`CODEMAP_CLAUDE_BIN`, when set, is the only place looked; an override that is not
executable is `missing`, never a fallback to PATH — the fallback was how a test
meant to cost nothing ran the real binary.

`GET /api/explain` takes ids on purpose — computing `state` re-reads every
described file off disk, so an unfiltered answer would read the whole project to
render a panel showing four.

**The prompt is told the graph's blind spots.** A method's caller list is marked
PARTIAL with `coverageNote`, and the model is told to say "unknown" rather than
conclude nothing calls it — the reading of cobra's `Command.Execute` had said
"nothing depends on it", false in sixteen places. A press re-reads only what is
not `current` ("Explain · N new"); `force` re-reads everything.

**Suggesting names is the same invocation.** `suggest.ts` reuses explain's exported
helpers — `resolveClaude`, `failureOf`, `parseJsonish`, `timeoutFor`,
`MAX_OUTPUT_BYTES` — so a change to how explain classifies a failure changes
suggest too. `--json-schema` is kept because nobody watches a name stream in.
Measured on this repository's three unnamed groups (62 files in the largest):
**$0.044 and 62.6 seconds** with haiku; a flat 60 s timeout timed out on exactly
that run after the money was spent, which is why the timeout is `timeoutFor(n)`
(60 s + 45 s per group) and the fetch is held for all of it. The pure half,
`readAnswer`, has its test beside it.

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
  is why `src/git/types.ts` exists separately from `src/project/git.ts`, and
  `src/report/types.ts` from `src/project/coverage.ts`.
- Comments explain *why*, not *what*.

**Testing.** The rule used to be "no test framework ceremony in the MVP, but the
graph engine must be pure enough to test later". Later has arrived, and the evidence
is that every check in DECISIONS.md is a scratch script that was run once and thrown
away, so nothing in it can be re-run to see if it still holds.

Use `node --test`. It is built into Node, so this adds no dependency and no ceremony.
`npm test` compiles and runs every `*.test.ts` beside the module it tests — one for
each pure module in `src/`, and `web/src/*.test.ts` run as they are.

- **Test the pure modules**: `graph/`, `view/`, `project/groups.ts`, and the parsing
  half of `project/git.ts`. These are where logic hides and where a bug is silent.
- **Do not** unit-test the server, the React page, or the parser workers. Those are
  I/O and integration; a scratch script against a running server is still the right
  tool, and it belongs in DECISIONS.md when it proves something.
- **A test may read a checked-in fixture off disk** when that is what turns a
  scratch script into something re-runnable. `src/oracle/checker.test.ts` builds a
  real `ts.Program` over `src/oracle/fixtures/` and `project/coverage.test.ts`
  writes a temp directory; both are the third category, and both exist because
  what they check cannot be reached with a pure input.
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

- **A monorepo's structure is drawn now** — workspace packages, tsconfig paths and
  barrels all resolve (TanStack: `react-query → query-core ×35`, 276 of 280
  `zod/v4` imports). What is still missing: `package.json` `main` for a directory
  specifier (only `index.*` is tried), and `export * as ns from`, which names a
  module and has no node to land on.
- **A types-only library draws as unconnected boxes.** `.d.ts` is skipped because
  it restates what the source declares — true for an app, false for type-fest,
  where 100% of 487 imports go unresolved, no import edge survives, and the
  clustering finds 0 groups in 221 files.
- **Enums are not parsed.** Not dropped with a warning — absent. 54 in vuejs/core,
  32 in zod. Namespaces, `declare`, class expressions, property-assigned functions
  (`app.init = function`) and `#private` members are.
- **The earlier "files that declare something and yield no symbols" counts (86 in
  TanStack/query, 53 in vuejs/core)** were measured before property-assigned
  functions and private members were symbols; re-measure before trusting them.
- Re-deriving the whole graph on every save is **not** the scaling problem it
  looked like: it tracks edge count at roughly 2 µs each, so 12 ms for zod's 500
  files and 15 ms for vuejs/core. It stays comfortable well past this project.
- The earlier cohesion figures (89% here, 31% zustand, 35% zod, 28% vuejs/core,
  7% TanStack/query) were measured with every internal edge counted twice and
  tests voting. Cohesion now counts each edge once, tests are out, and
  `MIN_COHESION` is 1/3 (the old 0.5 under the doubled count); the numbers are
  not comparable and have not been re-measured.

- Focus depth 2 on a densely coupled project explodes (64 boxes on the synthetic
  test). There is no cap or warning. At depth 4 the browser main thread blocks for
  about 2 s — client-side dagre plus the React Flow mount for ~288 boxes. The server
  answers in 3 ms; the cost is entirely in the page.
- Every save re-parses; there is no content hash, so a save that changes nothing
  still costs a parse and a publish. Collecting a file's own top-level calls
  roughly doubled the parse: zod went from 1.31 to 2.8 ms a file, query from 0.73
  to 2.1. It is in a worker, so decision 1 holds — the boot scan is what doubles,
  not the live pulse.
- **Coverage is coverage, not blast radius.** It answers "did the suite ever run
  this", and only for the third of a TypeScript graph that has a runtime function:
  of zod's 3 541 symbols, 1 124 join. "Which tests would break" was measured and
  refused — neither vitest nor nyc records it, manufacturing it costs 13.6× the
  suite, and the answer comes back as "125 of 192 tests". A symbol is measured
  only by a function the report declares on its own first line: joining executed
  statement lines onto a range gave express's `res.download` 87 of 88 test files
  where the truth is 2.
- The oracle is TypeScript's opinion and has its own blind spots: it does not walk
  tagged templates at all, and it names a symlink's realpath where we name the
  path as written — 33 of query's "ours-only" edges are those two, and all 33 are
  true.
- Two symbols sharing a name in one file are disambiguated by document order
  (`path#name~2`), so their ids shift if their relative order changes.
- A file with a syntax error still loses symbols — tree-sitter is error-tolerant —
  but the box carries a warning badge and the status bar counts them
  (`ParsedFile.hasError`). The flag is the grammar's word, not the compiler's:
  tree-sitter-typescript 0.23.2 marks TS 5.0 `export type * from` and TS 4.7
  `in`/`out` variance annotations as errors, so a barrel written that way wears
  the badge until the grammar is upgraded.
- A directory named `target` is skipped everywhere (`IGNORED_DIRECTORIES`), because
  Cargo's build output is 2 818 "unreadable" files on this repository alone and
  the scan drew generated `.rs` from it as source. Honouring `.gitignore` would be
  the real answer.
- **Gaps the oracle pins**, TS/JS, in `src/oracle/checker.test.ts`'s KNOWN_GAPS: a
  call to a member a class *inherits* reaches nothing, because `memberOf` reads
  only the owner's own declarations — hundreds of edges in zod; a function's own
  properties are invisible inside the file that defines them (`app.init()` in
  express's lib); a call chained straight onto a construction has no receiver.
- **Gaps that are gaps on purpose**, TS/JS: a TypeScript `namespace` object has no
  node, so `errorUtil.errToObj()` through `import { errorUtil }` resolves to
  nothing (70 true edges in zod); a parameter typed `typeof z4` and a spread alias
  `const z = { ...schemas }` likewise; a name imported from a package outside the
  project (lodash's `map`) resolves to nothing rather than to a same-named local;
  `exports.compileETag` keeps its prefix as the symbol's name, so
  `require('./utils').compileETag` does not land on it; a static call on a class
  name (`Store.create()`) is not qualified. A property-assigned function's id
  (`lib/app.js#app.init`) uses the member separator and would collide with a
  method `init` of a class `app` in the same file.
- Java: a bare call from inside an anonymous class body to the enclosing class's
  method is refused (gson: 14 such, all true), because only the anonymous type's
  supertype, which is not read, tells it from `new Runnable() { run() { run(); } }`.
  Go: a package-level variable types receivers only in the file that declares it.
- Grouping keys off the directory tree only. There is no filtering by name, kind or
  path glob, and a flat directory above the threshold cannot be grouped at all (it
  reports `grouped: false` honestly rather than claiming otherwise).
- Edges have no obstacle avoidance, so they route through unrelated boxes — 26% of
  edges in a 10-box root view.
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
  spent, and what it buys is that the answer is refused and never written. A
  suggest run has no cancel at all; a project switch during one answers "the
  project was switched" and the money is spent.
- A suggestion is session state on both sides: a project switch or a restart
  discards names that were paid for and not accepted.
- Dismiss removes a suggestion from this page only. The server keeps the whole
  last run, so a reload or a second tab shows the dismissed name again.
- A suggestion is keyed by cluster id, which is the first file plus the member
  count, so a save that moves one file in or out hides its suggestion without
  saying so — and a swap that keeps both keeps a suggestion whose reason may
  name a file that left.
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
