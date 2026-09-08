# codemaps — project context

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

## The name is codemaps

**One name, and it is `codemaps`.** The product, the window title, the wordmark in
the menu bar, the page `<title>`, the `.app`, the Cargo package, `package.json`'s
name and its `codemaps` bin — and the bundle identifier `com.praetrace.codemaps`,
because the company owns the reverse domain and the product does not. **One
version, 0.1.0**, in `package.json` and `src-tauri/tauri.conf.json` both: `0.1.0`
is what a `.dmg` had already been built as, and `package.json`'s `0.0.1` was npm's
default that nothing had ever shipped under.

**The old spelling survives on disk, and that is deliberate.** `.codemap/` in every
project that has one, `.claude/codemap.port`, the `codemap-port=` line the sidecar
prints for Rust to parse, `CODEMAP_PROJECT`, `codemap.db`, the `codemap.layout`
key in localStorage, the `/api` routes and the MCP server's own name and tools are
**contracts** — with projects that already hold a `.codemap/`, with a hook
definition sitting in someone's `settings.json`, with the one stdout line
`src-tauri/src/lib.rs` reads a port out of. Renaming them breaks something real and
shows nobody anything. Do not "fix" either side toward the other: it is the same
rule as *a category on the page is a group in the code*.

**Changing the identifier abandoned the app's own data.** macOS derives the config
directory from it, so recents, window geometry and per-project settings written by
an install made as `com.codemap.app` are simply not found. Only this machine ever
had one, the file names inside the directory are unchanged, so a hand copy recovers
it, and `lib.rs` says so at the line that opens the directory.

**Prose still says the old name in files this rename did not reach:** the three
`codemap:` message prefixes in `src/cli/index.ts`, and the sentences in `web/src/`
(StatusBar, BoxNode, Repository, Overview, Activity, Sidebar, ListView,
ComponentNode, AgentStatus). Those are user-visible and should follow — unlike the
`.codemap/` paths in the same files, which must not.

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
- A conversation about the categories, streamed into the panel, and a second
  press that **proposes** a grouping for a project the imports found none in —
  each proposal carrying our own cohesion and overlap, and accepted through the
  create that stores it as a category a person drew. See *Asking about the
  categories*
- The folders as frames around the boxes, nested, under `?folders=1` — a second
  arrangement of the same boxes, on the class diagram's scopes and on the
  structural diff, with a fold that puts a folder back as the box it is above
  the grouping threshold. See *The view layer*
- Source Control: the commit graph with its threads, the diagram frozen at any
  commit (`?at=`), and a Repository panel — project, remote, hook and MCP
- Coverage read from what CI already wrote — never run, never instrumented, and
  absent is never zero
- The hook answers: after every edit it tells the agent what the file it just
  wrote is coupled to, which category holds it, and which categories it reached
  out of that one into
- An oracle: the TypeScript checker as a re-runnable test, `scripts/oracle.mjs`
  over any repository and `src/oracle/checker.test.ts` over a pinned fixture
- Python, the seventh language, and a baseline that pins what the graph draws
  for express, zod, cobra and flask at four commits
- The UML notation, as far as a syntax tree can say it: role names and
  multiplicity on an association, a composition or aggregation diamond where the
  source states who owns the part, and `depends` — a class that names another
  only in a signature — as its own dashed line
- Two diagrams beside the class diagram: the categories as UML components
  (`?diagram=components`), and the activity diagram of one function
  (`GET /api/flow`), read off its syntax tree alone. The sequence diagram was
  measured and refused — see "Not built, and deliberately"
- The view turned on 2026-09-07 — see "Never draw the hairball" below. A scope
  past 30 boxes is a list, `/` is a front page, a category is a scope, and the
  structural diff (VISION.md phase 1) draws what came, went and moved between
  two graphs, a removed file as a ghost
- The database, as far as the code states it: a class wears `«table»` on the
  class diagram where an Entity Framework `DbSet<T>` names it, and nothing is
  drawn from convention — see "A table is a class with a stereotype" under the
  Graph model, and DECISIONS.md for the eight stacks measured

**What to build next, in this order.** Each is small, and each is here because
something in the last round of work argued for it:

1. **Close the loose ends.** `Session.gitBase()` has no caller; use it or delete
   it. A directory specifier resolves to `index.*` only — `package.json` `main`
   is now read into `ProjectFacts.entryPoints`, but `graph/resolve.ts` is not
   handed it. A static call on a class name (`Store.create()`) is not qualified,
   because the parser cannot tell an imported class from a namespace object
   without the bindings it now records — it can, so do it.

2. **Re-accept the corpus baseline.** `scripts/baseline.mjs` now records
   `depends`, interfaces own their members, and fields carry `optional` — so
   associates, `field` counts and a new key all move, every one in the direction
   the comparison passes. The four clones were not fetched in the round that made
   the change, so `src/oracle/baseline.json` still describes the graph before it:
   `--fetch`, `--check`, read what moved, `--accept`. The oracle fixture in the
   same file reads "every count as recorded" today.

3. **The diff's three open ends.** The hub holds one graph, so a socket whose
   spec carries `diff` is pushed the ordinary slice with `diff` dropped from
   its echo; the page reads the mismatch as "the diff changed" and refetches
   `/api/view` — right on screen, and one root view thrown away per diff
   client per save. `live.ts` should resolve the ends with `resolveDiffEnds`
   and hand `selectView` the before graph. The front page is refused at
   `?at=` because `Session.graphAt` hands back a `Graph` without the
   `ProjectFacts` that `history.ts` gathered beside it; keep the commit's
   facts in the LRU and `server/overview.ts` is a three-line branch. And
   `DIFF_CAVEAT` — the `~2` hole — is on every `/api/diff` reply and nowhere
   on the canvas.

4. **A view of the rest of the roots.** The front page lists 12 of
   astrupdata's 87 roots and "and 75 more" is a count with nothing behind it,
   on a page whose rule is that every number leads somewhere.

**Not started, and not to be drifted into.** Architecture drift detection
(VISION.md capability 1), blast radius (capability 3), LLM dataflow inference, and
anything hosted or multi-user. If a task seems to need one of these, say so and ask
rather than building it.

## Never draw the hairball

**The view turned on 2026-09-07.** Opened on a real project — astrupdata, 368
files, Next.js — the root was 12 boxes and fine, and one level in, `lib` was
**106 boxes and 427 lines**, laid out as one strip zoomed to a smear, while the
clustering offered "Terminal App, 254 files, 98%": the algorithm saying
everything imports everything, which is true and worthless. The screenshot
answered no question a person has. A map of everything never works — every
tool that tried hit this wall, and Sourcetrail's answer after years is the one
taken here: **never draw the big graph.** The default view is one symbol and
its neighbours. The overview is a list. The diagram is something you go to,
not something you land in.

The engine did not move — the graph, the seven languages, the honesty rules,
the live update, `?at=` — and the view layer turned, in three moves:

1. A scope past `LIST_ABOVE` (30) boxes is a **list**, not a diagram; below it
   the lines are faint until a box is asked about; a category is a scope.
2. `/` is a **front page** — what the project is, where it starts, what it is
   made of, what changed, what the agent is doing — and every line is a link.
3. The **structural diff**: what came, went and moved between two graphs,
   drawn on its own, a removed file as a ghost.

What a CS engineer actually asks, and what answers each: *what is this
project* — the front page; *what touches this, what does it touch* — the focus
view; *what did the agent change in the shape* — `?diff=`; *where is X* — ⌘K.
None of the four was answered by 106 boxes in a directory. The mechanics are
under "The view layer"; the numbers that decided it are in DECISIONS.md.

## Many languages

**The direction changed on 2026-09-01.** The tool reads **twelve languages**
across 25 extensions: TypeScript, JavaScript, Java, Go, C#, Rust, Python,
Kotlin, PHP, C/C++, and the two single-file component formats, Vue and Svelte —
plus Razor, which is a view rather than a language and is read by a line
scanner rather than a grammar. Anyone can point it at their repository.
VISION.md's "language sprawl" line is overridden by this section, and its
reasoning — a mediocre parser for many languages is worse than an excellent one
for a single language — is answered by the rule below rather than dismissed.

**A view is not a language, and three of these are views.** Vue and Svelte are
one component in one file: the reader is a block splitter that hands the
`<script>` to the TypeScript reader with the file's own rows kept, so no range
is shifted, and reads the template for component names — and a tag is an edge
**only when the file imported that name**, never from the tag alone. Vue's
native-tag list is `@vue/shared`'s own, because `<table>` beside an imported
type called `Table` drew a component calling itself. An SFC usually declares no
symbol at all (1 395 of 2 172 files measured), so the component itself is a
`class` node named by the source or by the file — without it those are empty
boxes and the render edge has nothing to point at. Razor has no usable grammar
(the only one on npm was unpublished; the one people build by hand fails a
third of real files on a DOCTYPE line), so it is a line scanner for eight
forms, which recovered every edge the grammar found plus every one it lost
across 236 files. **Angular is written and not registered**: an `.html` file is
a view only when a component's `templateUrl` names it, and adding `.html` as an
extension would draw every static page in every project. `src/lang/angular.ts`
waits for the second pass that reads `templateUrl` out of the TypeScript side.

**The graph model did not change, and that is why this was affordable.** File,
class, interface, method, field, and extends / implements / calls / contains /
associates / depends are UML, not TypeScript. A language supplies two things and nothing
else: how to read symbols out of a syntax tree, and how to turn a reference into a
file. The contract is `src/lang/types.ts`; a language is one file in `src/lang/`.

**A language is finished when its edges are checked against a real repository, not
when it parses.** This is the whole rule, and it is not academic. Before this
existed, opening vuejs/core drew four boxes and zero edges, because 357 of its
imports name packages inside the same repo and nothing resolved them. That does not
look broken. It looks like code with no coupling — wrong in a way that reads as
authoritative, which is the failure this project cares about most. Parsing is the
easy half; resolution is the half that decides whether the picture is true.

**Python is the one added on that rule, and it names its own gaps.** A module's
name is its path, and `from a.b import c` cannot say whether `c` is a name in
`a/b.py` or the submodule `a/b/c.py`, so the reference is written `a.b#c` — Go's
qualified form — and the resolver, which has the file set, decides: submodule
first, then the module, from every source root (a directory that holds a package
without being one, `src/` above `src/flask/`) and last from the importing file's
own directory. Every name a module imports it also exports, because that is how
a Python package's `__init__.py` presents its API, so `from flask import Flask`
lands on app.py and not on the barrel. Checked against flask, requests and
werkzeug: 0 parse failures, 0 unresolved relative imports, 0 guessed edges, and
twenty sampled edges all real. What it does not draw, honestly: a call through a
receiver nobody annotated (`x = f(); x.m()`), which is most of Python; a method
inherited from a base class, which the store does not walk for any language; and
a class nested in a class. `moduleName` waits on `extract` being handed the file
path — the source cannot say it — so an unresolved `flask.x` is not yet counted
as internal.

**A convention is not the language.** Java refused a lower-case name to be a
type, which is how Java is usually written and not how it is defined: 131 of the
266 classes in a real first-year tree break it, and a directory named after the
inheritance lecture drew no edges while its source held four `extends`. The
convention survives in exactly one place — judging the receiver of a qualified
call, where `Streams.write()` and `helper.go()` on an inherited field are the
same three tokens and no table the resolver holds can separate them — and
because that case is undecidable, a Java symbol never answers `tracked`.

**A file's own import line decides what it reached.** TypeScript, JavaScript, Go,
Java, C# and Rust all record what the file named, and `lookup` admits nothing
else. Before C# and Rust did, three of ripgrep's six `Config` edges pointed at a
type the file cannot name while `use crate::searcher::{Config}` sat six lines
above. A file whose scope genuinely cannot be enumerated — a Rust wildcard `use`,
`#[macro_use]` — records none and keeps the whole-table rule, and its edges wear
`guessed`. A hostile sample found 50 of 52 of those correct, so the mark is
pessimistic rather than a warning about a bad graph.

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
`tsx` and wants one of those. All seven grammars need `.npmrc`'s `legacy-peer-deps`,
for the same stale peer range documented under Dependency note, and every one of
them belongs in `RUNTIME_DEPENDENCIES` in `scripts/prepare-resources.mjs`, or the
desktop app ships without it and the worker hangs at module load.

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

   **A model may *propose* a grouping; it may never *store* one.** That is the
   reading this rule gained on 2026-09-08, and it does not bend it. A proposal
   is text on a screen with evidence beside it — and the evidence is
   `view/cluster.ts` counting the same imports the clustering counts, never a
   number the model gave. Nothing on that path writes. A person pressing accept
   **is the person drawing that group**, so it is stored with `origin: 'manual'`
   through the same `POST /api/groups` a shift-click draw makes, and it is
   marked "by hand" on the frame, in the panel, on the front page and on the
   component diagram. The graph never claims to have found it. See *Asking about
   the categories*.

## Graph model

Keep the node/edge shape stable and explicit:

```ts
type NodeKind = 'file' | 'class' | 'function' | 'interface' | 'type' | 'method' | 'field';
type EdgeKind = 'imports' | 'extends' | 'implements' | 'calls' | 'contains' | 'associates' | 'depends';

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
  guessed?: true;      // resolved by something weaker than a binding; absent means found
  roles?: AssociationRole[]; // associates only: one per field that spells it
}

interface AssociationRole {
  name: string;        // the field's own name — UML's role name at the far end
  many?: true;         // `T[]`, `List<T>`; the page writes `*`
  optional?: true;     // `x?: T`, `T | null`, `T?`, `Optional<T>`; the page writes `0..1`
  ownership?: 'composition' | 'aggregation'; // absent: the source did not say
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
`calls`, it is opt-in (`?edges=…,associates`, or `?associates=1`) and *replaces*
the import between the same pair rather than being drawn beside it. An interface
owns its members the way a class does, and its typed property draws the
association — on a TypeScript project that is nearly all of them. A parameter
property is a field, listed where the constructor is written.

The edge is one per pair of classifiers and carries `roles`, one per field that
spells it, each holding what that field's declaration wrote and nothing more.
`many` is `Logger[]` or `List<Logger>`, and the page writes `*` rather than
`1..*`, because an array says nothing about being non-empty. `optional` is
`x?: T`, `T | null`, `T | undefined`, C#'s `T?`, Java's `Optional<T>` or
`@Nullable`, and the page writes `0..1`. `ownership` is `composition` when the
class builds the part — `= new T()` where the field is declared, or
`this.x = new T()` in a constructor, and only when `T` is the field's own declared
type: `items: Item[] = []` builds a container and `log: Logger = new
ConsoleLogger()` builds something the parser cannot say is a Logger, and both
stay plain — and `aggregation` when the part is handed in: a parameter property, a
record component, `this.x = param` for a constructor parameter. The parser reports
`composed` and `handedIn` separately; a field that is both is a source that said
two things, and the edge carries neither. Absent means the source did not say —
never false. The page draws UML's diamond at the holder's end from what a line's
roles agree on — `ownershipOf` in `view/select.ts`, which also decides the
panel's word (`composed of`, `aggregates`, `holds`), so the shape and the word
cannot drift — and the role name and multiplicity at the far end. The near end's
multiplicity is not in the source and is not drawn.

**A dependency is the weakest line UML draws, and it is its own kind.** `depends`
runs from a class or interface to a type it names only in a parameter or return
type of its own operations — `ParsedSymbol.dependsOn`, every type identifier in
the signatures, type parameters excluded — and the store draws it only for a name
the class reaches no other way: not a field's type, not a supertype. A kind rather
than a flag on `associates`, because `edges.ts` counts `associates` as reaching
and a dependency must not be — a class that takes a Store as a parameter does not
hold it, and the hook's sentence must not say it does; `edges.test.ts` pins that.
The panel is the one surface that widens past `REACHES`: it lists a dependency
under uses and used by, as `depends on`. Opt-in (`?edges=…,depends` or
`?depends=1`), dashed with an open head on the page, drawn **beside** the import
and never instead of it — `calls` and `associates` replace the import between
the same pair, a dependency is too weak to stand in for one: "merely depends
on" between two files one of which holds the other was the picture that rule
drew. Resolved through the same `lookup`, so it wears `guessed` under the same
rule. TypeScript, Java and C# record it; JavaScript writes no types and records
none. A dependency that resolves to nothing is not counted in `unresolved`,
and **a dependency does not vote in the clustering**: a type named only in a
signature is not the coupling label propagation measures, and letting it vote
moved every stored name on every typed project the day the kind arrived.

**A table is a class with a stereotype, where a declaration says so.**
`GraphNode.stereotype` is `{ name: 'table', statedBy }` on a class an Entity
Framework `DbSet<T>` names — `statedBy` the id of the property that said it, so
the box's title can say "a table, by the word of CatalogContext.Baskets in
CatalogContext.cs" rather than assert it. The parser reports
`ParsedSymbol.typeStereotype: 'table'` on the *field*, because the class it
describes is in another file and a file is parsed alone; the store writes the
mark onto the class `typeName` resolves to — the first declaration wins, a
guessed resolution stamps nothing, an interface is never marked. `DbSet` is in
C#'s `MANY`, which it should always have been: a DbContext used to draw seven
properties and no edge. A stereotype and not a NodeKind, because a JPA entity
has methods and a superclass and is a class; absent means no line said so,
never "not a table". Keys and foreign-key columns are **not** marked for EF
Core, by name and on a number: `[Key]`, `[ForeignKey]` and `[Table]` are
written 0 times across eShopOnWeb, CleanArchitecture and dotnet/eShop, `Id` is
convention, `HasKey` and `HasForeignKey` are lambdas in another project,
`OrderItems.OrderId` is a shadow column no source line holds, and a rule on
properties named `XxxId` is wrong 4 times in 7 — the has-a line the
navigation property already draws is what the source states. Measured on
eShopOnWeb: 7 `DbSet<T>`, 7 `«table»`, the same seven the migration creates;
Buyer and PaymentMethod extend `BaseEntity` and are in neither. DECISIONS.md
has the eight-stack survey and what was refused by name.

**Ownership is written only when the source said one thing.** `composed` when
the class builds the part (`= new T()` inline, `this.x = new T()` in the
constructor), `handedIn` when the constructor stored a parameter in it; the
store's `roleOf` draws a diamond for exactly one of them and none for both or
neither. Two readings that were lies until measured: a parameter property the
body also builds says both (a hollow diamond on a part the class constructs),
and a parameter the body reassigns — `cfg = new Config()` before `this.cfg =
cfg` — is no longer what was handed in, and says neither. The far end's
multiplicity is `*` for an array and `0..1` for `?`, and **nothing** when the
field said neither: `1` is a claim of exactly one, and a Java reference field
is nullable by default.

**Every edge says how we know, and what did not resolve is counted.**
`GraphEdge.guessed?: true` marks an edge resolved by something weaker than a
binding — today only the whole-table fallback, which no language with bindings
can reach, so TypeScript, JavaScript, Go and Java mark zero and C# and Rust do
not. Absent means found; there is no `false`. And a reference that resolved to
nothing is no longer dropped in silence: `GraphNode.unresolved` counts it on the
file, so a box with no coupling can be told from a file we could not follow. The
count is **only what the project could plausibly hold** — a relative path, a
tsconfig alias, a workspace package, a name some file declares. `node:http`,
`react`, `console.log` and `describe` resolved to nothing too, and nothing is
missing; counting them marked 133 of express's 141 files and claimed lost
coupling where there was none. It is a count and never an edge: there is no node
to draw one to, which is the whole of what the number says.

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
prompt all show `coverageNote`, and a method never reads "0 in". The class
sentence names the one exception to "written only in a type": a class that names
this in its own methods' signatures is listed as depending on it.

**Not built, and deliberately.** Sequence diagrams are refused, on a number. One
is calls in order, and the parser can name the receiver of a method call only
when its type was written down (`x: T`, `this` inside `T`, `new T()`): measured,
that is 13% of method-call sites on this repository and 27% on a Java project, so
a sequence diagram would draw one message in eight and read as complete — the
exact lie this project exists not to tell. `collectCalls` also discards order
into a Set. Nothing may drift towards one. State diagrams are not derivable from
static structure, and an activity diagram across files is not either — but inside
one function body it is, completely: an `if` is an `if` in the tree, a loop is a
loop, a return is a return, and none of it needs a receiver typed.
`src/parser/flow.ts` draws that one, for TypeScript, JavaScript, Java and Go,
through the worker and the pool (decision 1); it is a detail about one symbol —
`GET /api/flow` — and never graph structure (decision 3). Two rules it learned
from a review: a function handed to a call is never the symbol's own body
(`items = xs.map((x) => …)` puts an arrow on the field's line, and the route
served that arrow's flow as the flow of `items`), and a `finally` that exits
on its own replaces every exit it was carrying — an edge out of the finally box
for the try's `return` was a path no run takes. An ER diagram is not drawn
and there is no ER view: a table is a class wearing `«table»` on the class
diagram where a declaration says so, and nothing more — the Graph model above
says what is stated, DECISIONS.md says which stacks leave it to convention and
were refused. A package diagram is the root diagram, `?scope=&as=diagram`, and exists;
a component diagram is `?diagram=components` — the categories as boxes, each
listing what files outside it reach — and it is honest for the reason the
package diagram is: the same import data, summed one level up.

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
npm run codemaps -- <dir>         # the same graph as text
npm run codemaps -- <dir> --json  # raw nodes + edges
npm run typecheck                 # checks src/ and web/
node scripts/corpus.mjs <dir>...  # what the engine makes of real projects
node scripts/oracle.mjs <dir>     # where the TypeScript checker says we are wrong
node scripts/baseline.mjs --fetch # clone the four pinned corpus repositories, once
node scripts/baseline.mjs --check # what the graph draws for them, against the pin
node scripts/baseline.mjs --accept # record today's numbers as the new baseline

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
    edges.ts      which edge kinds mean "reaches" — one home, two readers; its
                  test pins that `depends` does not
    resolve.ts    module specifier -> file, given the set of known files
    store.ts      holds parse results, derives the graph, emits deltas
    diff.ts       two graphs -> what came, went and moved; ids are the
                  identity, `~2` is the hole. Its test builds graphs through
                  the store so the ids, `~2` included, are the live ones
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
    types.ts      LanguageSupport / LanguageParse / ResolveContext / ProjectFacts,
                  and EntryPoint — a file the project starts from, and why
    registry.ts   extension -> language; what "cannot read" is the complement of
    typescript.ts the reference reader the JS one shares: scopes, typed
                  receivers, re-exports, bindings, property-assigned functions
    javascript.ts, java.ts, go.ts, csharp.ts, rust.ts
    python.ts     module path -> file from every source root; `a.b#c` for a
                  from-import, decided by the resolver; every import a re-export
    kotlin.ts     resolves by (package, declared name), because a Kotlin file
                  is named after none of what it holds; an extension function
                  is not a member of the type it extends
    php.ts        PSR-4 out of composer.json turns a namespace into a directory
                  — the resolver is stated by the project, not guessed
    cpp.ts        .c .h .cpp .hpp .cc .hh .cxx .hxx; a quoted include is a path
                  we follow, an angled one is a system header and is not a miss
    vue.ts        blocks, not a grammar: the script goes to the TypeScript
                  reader with the file's own rows; the component is a node
    svelte.ts     the same, for a script and a module script
    razor.ts      a line scanner for eight forms; _ViewImports applies to every
                  view beneath it, which is what makes the rest resolve
    angular.ts    written, tested, and deliberately not registered — see above
  oracle/         a second opinion, and a memory — dev only, never in the live
                  path, never imported from server/, cli/ or project/: it pulls
                  in `typescript`, a devDependency
    checker.ts    ts.Program -> our edge shape, with the diagnostics gate
    fixtures/     the shapes that have caught us before, pinned
    baseline.json what the graph draws for four repositories at four commits
    baseline.test.ts runs scripts/baseline.mjs; skips a clone it does not have
  parser/         everything that knows about ASTs
    types.ts      ParsedFile / ParsedSymbol + worker message shapes
    extract.ts    tree-sitter -> ParsedFile
    flow.ts       the activity diagram of one function: a walk over one
                  tree-sitter node, a table per language for TS/JS, Java and
                  Go, null with a reason for the rest; FlowRequest/FlowResponse
                  beside it. Pure; the worker hands it the node
    worker.ts     worker_threads entry: reads a file, parses it, replies — or
                  answers a FlowRequest with a parser of its own
    pool.ts       fixed pool of parser workers, one file at a time each;
                  `flow()` queues beside `parse()`
  project/        the project on disk, and everything that changes it
    walk.ts       boot scan + the ignore/source predicates everything shares,
                  and the census of what no language claims (countUnreadable)
    facts.ts      what no single file can know: tsconfig paths, packages,
                  go.mod, crates — and where the project starts: package.json
                  main/bin/exports and the scripts that run a file of its own,
                  Next's page/route/layout files under a package that depends
                  on `next`, Cargo bins, Go `func main` read off the file
                  head, `__main__.py`. Read once at boot; only files the scan
                  found, one claim per file, the first wins; build output is
                  dropped, never mapped dist -> src
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
    ask.ts        the two paid presses under Categories: `ask()`, the streamed
                  conversation about the component diagram, resumed through
                  --resume; and `propose()`, its own invocation, its own prompt
                  and its own schema, asked how the project divides. Neither
                  writes; `tooBigToPropose` refuses before a cent is spent
    hook.ts       a Claude Code PostToolUse payload -> the same FileChange
    hook-install.ts  detect, preview and merge the hook into settings.json
    mcp-install.ts  the same three, for .mcp.json: the script is found from
                  this module's own compiled location and never from cwd,
                  written relative inside codemap's own checkout and absolute
                  anywhere else, and "installed" means the script the entry
                  names is really on disk
    port-file.ts  leaves the port where the hook can read it
    updater.ts    the one pipeline: coalesce, parse, patch, publish
  view/           which slice of the graph to draw — pure
    types.ts      ViewSpec / ViewGraph, LIST_ABOVE and Presentation
    filter.ts     what to leave out; filtering is not navigating
    select.ts     selectView(graph, spec, now, git, coverage, categories, before)
                  -> ViewGraph; presentationOf (list or diagram, the one
                  rule), categoryOf (a stored id -> its accepted category, or
                  null — the route's 404 and the view's fallback share it),
                  boxesOf (one builder for a directory scope and a category scope)
    diffview.ts   the boxes that differ, and only those; a ghost is the
                  before graph's. Its test hand-builds graphs
    overview.ts   the front page as data: roots (no source imports it; tests
                  do not vote), the manifests' entry points, categories,
                  changes, agent — pure; capped lists carry their totals
    components.ts the categories as components: which file is whose, and what
                  each provides (partitionByCategory); select.ts draws it
    cluster.ts    label propagation over the import graph, and `fileLinks` —
                  the one home of what couples two files, which
                  `undirectedNeighbours` and `evidenceFor` are both built from
                  so the clustering's number and a proposal's cannot drift
    folders.ts    the folders as nested frames: which folders are drawn, which
                  are collapsed into the one below, what each is then called,
                  and which frame holds each box. Pure — the geometry is
                  web/src/layout.ts's, the arrangement is decided here
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
    session.ts    one project: store, pool (exposed, for the flow), watcher,
                  updater, git, an LRU of 16 past commits' graphs (graphAt —
                  hand it a sha, never a ref name: its `spelled` cache pins a
                  spelling to the sha it resolved to first, right for a sha
                  and wrong for HEAD), the stored group names (groups,
                  refreshGroups, clustersOf — held in memory like coverage,
                  re-read by the view route for a component diagram or a
                  category scope and by the two routes that write
                  groups.json), the conversation about the categories and the
                  last suggest run. Swapped whole
    app.ts        Fastify: static web build, and the API below; `optionalKeys`
                  reads `as`, `category` and `diff` for both wire formats
    flow.ts       GET /api/flow, registered from app.ts; asks the session for
                  root, store and pool
    diff.ts       GET /api/diff, and resolveDiffEnds — the one place `base`
                  and a commit become two graphs, shared with the view route
    overview.ts   GET /api/overview, live only
    ask.ts        GET and POST /api/ask; `askContext` runs the real
                  `selectView` for the component diagram rather than
                  re-deriving it, `proposeContext` is the level underneath
                  (files, who holds each, `fileLinks`) and `judge` attaches
                  `evidenceFor` and the overlaps off one graph. The propose
                  run is held here, against the session it was made for
    mcp-install.ts  GET /api/mcp-status and POST /api/mcp-install; asks the
                  session for the root and nothing else
    live.ts       connected clients and their view specs; pushes per client,
                  and `groups` to every client after a groups.json write, then
                  a fresh view to each live client drawing components or
                  scoped to a category
    main.ts       boot scan, wiring, listen
web/              the browser page (Vite, built into dist/web)
  src/App.tsx     URL <-> view, live updates, breadcrumb, focus, depth, selection
  src/Overview.tsx  the front page: what `/` shows instead of the root diagram
  src/frontpage.ts  isFrontPage, homeSearch, rootDiagramSearch, manifestGroups,
                  changesSummary, splitPath — pure, tested
  src/ListView.tsx  the rows, where the engine said the slice is a list
  src/listrows.ts rows, sort, holdOrder (mark, do not move), presentationChip,
                  letterStatus — pure, tested
  src/BoxNode.tsx one box: a file with its symbols, or a folder — or a ghost
  src/ComponentNode.tsx  one component box: a category's name, count and
                       cohesion, and what it provides
  src/RelationEdge.tsx   every line on the class diagram: the path, and the
                       diamond, role text and open head a kind adds
  src/Flow.tsx    the flow of one function, over the canvas: its own
                  ReactFlowProvider, dagre top-to-bottom, the engine's notDrawn
                  under it
  src/GroupNode.tsx a group frame: name, colour, size, membership
  src/FolderNode.tsx a folder, under ?folders=1: the frame around its boxes —
                  name, count, fold — or, shut, the one box standing for them.
                  The structural line, never a category's colour
  src/fold.ts     what a shut folder does to the boxes and the lines: the boxes
                  it swallows, the frames left, the lines re-pointed at it and
                  summed. Pure, tested; hands the view straight back when
                  nothing is shut
  src/Sidebar.tsx the right side bar: Following (with its readings), and
                  Activity placed into it by App. `DetailPanel` is exported
                  from here too and stands at the foot of the LEFT bar
  src/Categories.tsx   the left bar's third section, a tree: one folded row per
                       group with its count and cohesion or "by hand", the files
                       under it once unfolded, the editor (name, colour, members,
                       delete), the create-from-selection form, and the model's
                       suggested name on the group's own row with accept / dismiss
  src/Ask.tsx          under the categories: the conversation, and the second
                       press that proposes a grouping — each proposal's name,
                       sentence, our cohesion, its overlap and every one of its
                       files, with accept (the ordinary create) and dismiss
  src/ask.ts           its pure half — the transcript reducer, what a delta
                       does, and the sentences a proposal is read by. Tested
  src/Repository.tsx   the left bar's first section: project, remote, the Claude
                       Code hook and MCP, and the buttons that act on them
  src/SourceControl.tsx  Changes (the per-file list, the base picker) and Graph
  src/GitGraph.tsx     the commit graph: lane numbers into pixels, refs, ages
  src/Activity.tsx     what the agent is doing, where, and who — describes now,
                       always. The right bar's second section since the swap
  src/ProjectMenu.tsx  folder picker and recents; desktop only
  src/Welcome.tsx      shown for an empty project, and from Help — over the
                       front page, never instead of it
  src/MenuBar.tsx      the menus
  src/StatusBar.tsx    branch, git base, counts, languages, the agent — what the
                       project is, read at the bottom the way an editor does it
  src/Section.tsx      one side bar section: 22px header, a chevron that folds it,
                       actions hidden until hover. Every panel region is one
  src/SearchPalette.tsx  ⌘K, in Quick Pick's shape
  src/CommandPalette.tsx ⇧⌘P, the same shape over the menu bar's own items
  src/commands.ts the menu tree flattened into commands, matched and ranked —
                  pure, and the one home of the subsequence matcher ⌘K shares
  src/FindBar.tsx ⌘F: the matches in what is drawn, stepped, camera-moving
  src/find.ts     which boxes and members a query lights — pure
  src/listkeys.ts arrows in a list, and roving tabindex: one Tab stop per list
                  rather than one per row. Pure rules, tested; the hook reads
                  the rows out of the DOM
  src/Sash.tsx    one draggable border, reporting a size in pixels
  src/panes.ts    how wide the bars are and how the sections divide them — pure
  src/placement.ts where a person put a box and how wide they made it: the view
                  key, the merge with a computed layout, the two ways back and
                  the localStorage shape with its version and its caps — pure,
                  and the only I/O is the two storage calls
  src/marks.ts    how long a live signal stands and how it weakens — pure, and
                  the one place the two durations are decided
  src/AgentStatus.tsx  what the agent is doing, and how long ago
  src/layout.ts   dagre for a view's first layout, keepLayout for every save after
                  (which takes the folder frames, so a new box lands in its own
                  folder); ClusterInput.folder and the four rules a directory
                  frame needs; componentHeight, and layoutFlow / flowBoxSize
                  for the flow (tested in flow.test.ts)
  src/api.ts      fetch + the shared types, imported from src/ — and one value,
                  flow.ts's language table, which bundles because it reads a
                  tree and nothing else
  src/fileicons.ts path -> file icon, the Material Icon Theme's twelve SVGs in
                  src/icons/ — the one icon that is not a Codicon, and DESIGN.md
                  says why; tested, and the SVGs are bound with `new URL` so Node
                  can load the module
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
                        fileCount, hiddenTests and parseErrors for the whole graph.
                        ?diagram=classes|components picks the diagram: 400 for
                        anything else, and under components scope and focus are
                        ignored and echoed cleared rather than 404'd.
                        ?as=list|diagram overrides the threshold: 400 for
                        anything else. ?category=<storedId> is a scope by
                        membership: 404 `no such category: X` or `category "X"
                        was rejected`. ?diff=base|<sha> draws only what differs
                        between that graph and this one — always a diagram,
                        scope/focus/category dropped from the echo — and the
                        reply carries `diff: { from, to }` with the resolved
                        shas; 400 for a spelling that is neither (named
                        `diff=`), 404 for an unknown commit or no git.
                        ?folders=1 arranges a scope diagram or a diff with the
                        folders as nested frames, and answers with them as
                        `folders`; never a 400 — where the arrangement does not
                        apply the key is dropped from the echo instead.
                        The view carries `presentation`: list or diagram
GET  /api/overview      the front page in one fetch: project (files, tests,
                        languages, what cannot be read), entry points (the
                        manifests' and the graph's roots, capped with totals),
                        categories, changes, agent. Live only: ?at= answers
                        400 with a sentence, because a commit's graph is
                        served without the facts its entry points are read from
GET  /api/diff          from=<sha|base>&to=<sha|live>, absent is base -> live:
                        counts and the whole lists of what differs — files,
                        symbols, edges, every kind, no cap — with `caveat`, the
                        `~2` sentence, on every reply. 400 for a spelling
                        neither end takes, 404 for an unknown commit
GET  /api/flow          the activity diagram of one function or method, ?id=.
                        404 for an id the graph has not got; 200 with
                        { flow: null, reason } for one it has but cannot draw —
                        a language without a table (C#, Rust, Python), a symbol
                        without a body, a file, class, interface or type; `boxes`
                        counts start and end so the page can warn before it
                        draws. Read off the working tree: ?at= is 400, because a
                        commit's files are not on disk
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
GET  /api/mcp-status    is .mcp.json naming a script that is really there —
                        with the other servers in the file, and the preview
POST /api/mcp-install   merge ours into whatever is there. 400, never an
                        overwrite, for a .mcp.json that is not valid JSON or a
                        build with no scripts/mcp.mjs beside it
POST /api/hook          the PostToolUse payload. Always 200, and answers with
                        what the file just written is coupled to, as
                        `hookSpecificOutput.additionalContext`
POST /api/note          the agent's own words about what it just changed
GET  /api/coverage      what the test suite executed, or { coverage: null }
GET  /api/ask           the conversation about the categories, whether a turn
                        is in flight, and the last proposed grouping
POST /api/ask           { action: 'ask' } 202 and the words arrive on the
                        socket; 'end' closes it; 'propose' 202s a grouping run
                        — 400 for a project with no files or one too big for
                        one prompt, 409 while one is in flight —
                        'drop-proposal' throws that run away. Spends money.
                        **Writes nothing**: accepting a proposal is the
                        ordinary POST /api/groups create
     /live              the websocket. Besides views it carries `agent`,
                        `ask` and `ask-delta` (a proposal has none — a schema
                        answer has nothing to stream, and the panel polls),
                        `explain`, `explain-delta`, and `{ type: 'groups' }` after
                        every groups.json write — to every client, frozen ones
                        too, because a name lives outside the commit; the page
                        refetches /api/clusters on it, and a live client drawing
                        components or scoped to a category is pushed an
                        `update` right after, so the box wears the name the
                        panel just got and a scope whose members moved is redrawn
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
- **And it says where the file sits in the architecture.** One more sentence:
  which category holds the file, and which categories it reaches out of that one
  into. A person drew that architecture and an agent that knows it can write code
  that fits; the crossing is the half the agent cannot work out from its own
  edit, because it would have to know where every file it imported lives.
  **A fact, never a verdict.** Nobody has declared which category may reach
  which — codemap holds no such rule and will not invent one — so the sentence
  says where the edge went and stops. Calling a crossing wrong would be a model
  deciding architecture, which is what decision 5 forbids, and there is a test
  named for it. The categories are the rows `/api/clusters` answers with, so the
  hook and the diagram read one list — but they do not yet read it the same
  way, and the one case where they disagree is under Known limitations;
  only an accepted name counts, the most specific category wins (a group
  found inside another says more than the one around it), and a project nobody
  has named anything in gets exactly the note it got before. Being in a category
  with nothing else to say is still silence. Measured over astrup — 358 files,
  eleven real categories, ten of them nested: 207 notes, median 182 characters,
  longest 387, none over the ceiling; one note traded its list of importer paths
  for the category clause, which is the ladder working (paths are the expensive
  half, a category name is not); and 43 files that were silent now speak, every
  one of them because it crossed a boundary. 0.45 ms on the round trip.

## The view layer

The page never draws the whole project unasked. `selectView(graph, spec, now,
git, coverage, categories, before)` reduces the graph to a slice, and the spec
lives in the URL, so navigation is links: the back button works and a view is
shareable.

```
/                            the front page — a list, never a diagram; only `at` may ride it
/?scope=&as=diagram          the root diagram, drawn whatever its size ("Draw the whole project")
/?scope=src/graph            the files in one directory — a list past 30 boxes
/?category=<storedId>        a category's files, wherever they sit, by the same rule
/?as=list  ·  /?as=diagram   overrides the threshold either way
/?focus=<file>&depth=1       a file and its neighbours, imports both ways — always a diagram
/?diff=base  ·  /?diff=<sha> only what differs between that graph and this one — always a diagram
/?at=<sha>&diff=<older sha>  the same, between two commits
/?changed=1                  only what differs from the git base
/?at=<sha>                   the whole diagram as of that commit — not a highlight
/?tests=0                    without tests, fixtures and stories; hiddenTests says how many
/?calls=1 ?associates=1 ?depends=1   the three opt-in edge kinds; `?edges=` spells them too
/?diagram=components         the categories as UML components: one box per leaf
                             category listing what files outside it reach, the
                             imports between categories summed onto one line per pair
/?folders=1                  the folders as frames around the boxes, nested — a
                             second arrangement of the same boxes, not a third
                             diagram. Scope diagrams and the structural diff only
```

**`/` is the front page, and it is recognised by key presence.** `isFrontPage`
in `web/src/frontpage.ts` answers yes to a URL whose only key is `at`, and no
to every other: `?scope=` with an empty value is the root *diagram* — the key
is what makes it one — and `?tests=0` alone is that diagram with tests hidden,
because a filter filters a diagram. Every URL that worked before this page
existed lands where it did; only a bare `/` moved. The root crumb, Go › Whole
project and "Up one level" from a top-level directory land on the front page
and drop the filters on the way in (`homeSearch`); Go › "Draw the whole
project" is `rootDiagramSearch`, `?scope=&as=diagram`, which asks for the big
graph on purpose. What the page shows is under "The rest of the page".

**Above `LIST_ABOVE` boxes a scope is a list, not a diagram.** `LIST_ABOVE` is
30, in `src/view/types.ts`. `ViewGraph.presentation` carries the rule as
applied, decided once in `presentationOf` (`view/select.ts`) over the *echoed*
spec: `as` wins; a focus and a diff are always diagrams, because there the
lines are the answer; else `nodes.length` above 30 is a list. External boxes
count, because they are drawn: lib is 53 boxes inside and 53 dimmed
directories outside. Decided server-side and never re-derived on the page, so
a live push cannot redraw a list as a diagram. The list is the explorer's
shape — `web/src/ListView.tsx`, the arithmetic in `listrows.ts` with its test
— one 22px row per box carrying kind, members, imports in, imports out, the
git letter and the test tag; every column header sorts; one Tab stop; click
inspects, double-click focuses a file and scopes a folder. In and out are the
view's own lines summed by `weight`, and a floor: a call through an untyped
receiver is not in the graph, and the column title is the only place that
says so. `?as=` rides the helpers built from the live URL, and a navigation to
a new place drops it on purpose.

**A folder is a frame only where it is not already a box.** Above
`GROUP_THRESHOLD` (40) a scope folds its files into folder *boxes* with a
count, which is how a big scope gets small; a folder *frame* is the opposite —
every file keeps its box and the folder is drawn around it, nested, so an edge
that crosses a folder wall is visible as exactly that, which is the whole value
against an IDE's tree. The same directory cannot be both, so `?folders=1`
applies only below the threshold, and the gesture is opening a folder box
rather than a third diagram. The tree is `nestByFolder` in `view/folders.ts`,
pure and tested: a folder holding one file is still a frame (webapp-h26's
`Controllers` and `Models` hold one file each and are the wall the picture is
about — 4 of the 12 frames at that root; astrup's `app/api` is nine boxes all
called `route.ts`, and the eight one-box frames are the only thing that tells
them apart); a folder holding nothing but one subfolder collapses into it and
its name joins the label (`wwwroot/js`), the same walk `descend` does at the
scope; a folder holding *every* drawn box draws no frame, because that is the
canvas with a border. `MAX_FOLDER_DEPTH` is 4 and is a guard, not the design —
past it nothing below is framed and those boxes fall to the deepest frame
above. A box is labelled relative to the frame holding it, so a folder that
draws no frame is not lost: it reappears in the labels of its own files.
Frames never count toward `LIST_ABOVE`; boxes do.

**The arrangement is refused where a folder is not the structure, and the echo
says which.** Under `diagram=components` and under `?category=`, because a
category is not in a folder — every category measured spans more than one
directory and more than one top-level directory, and the lowest common ancestor
folder of each of astrup's eleven is the project root, so a category frame that
respected a folder wall would be the whole project eleven times over. Under a
focus, which is a neighbourhood rather than a place in the tree and whose
bundles stand for files from many folders at once. Above `GROUP_THRESHOLD`,
where the folder is already the box. And on a list, which has rows and no
frames. Each drops `folders` from the echoed spec, the way `diff` is dropped
when only one graph was handed over, so the page reads the echo rather than the
URL and the View menu greys the item with the reason.

**A refusal is decided before a single label is rewritten**, and the list is
the one that has to reach for `presentationOf` to know. Dropping the frames
afterwards is not a refusal: under the arrangement a box is named relative to
the frame that holds it, so a list built with the frames and stripped of them
kept 14 of astrup's `components` rows reading `EChart.tsx`, `build-option.ts`,
`index.ts` — the directory gone from the row and no frame on screen to say it,
while the echo said the arrangement had been refused. `scopeView` therefore
labels flat, builds its echo, and only then asks `presentationOf(echoed,
boxes)` whether there is a diagram to frame; `diffView` already did it in that
order. The rule: whatever decides an arrangement must decide it before
anything is drawn in its terms.

**Two frame systems, one at a time.** A folder frame and a category frame are
both drawn by `frameClusters`, and the page hands it one list or the other:
under `?folders=1` the folders, otherwise the categories. Drawn together over a
folder layout, three of astrup's eleven categories survive `withoutOverlaps`
and one of them is an 8544px rectangle around 172 boxes of which 167 are not in
it. `?category=` and the component diagram are how a category is seen whole,
and the Categories panel still lists every one of them.

**A category is a scope.** `?category=<storedId>` shows a stored, accepted
category's files the way `?scope=` shows a directory's — list or diagram by
the same rule — because "show me the Data Pipeline" is the question the
categories exist to answer, and nothing answered it. The stored id, never the
cluster id, which embeds the member count. Members are never folded into
folders and are labelled by whole path; membership is honoured after the
filter, so `totalFiles` is how many survived. `categoryOf` is one lookup the
view falls back from and the route refuses with, so the two cannot disagree:
a rejected category is a stored memory that this is *not* a piece of the
architecture, and is refused by name. `category` wins over `scope`; `focus`
wins over it. The crumb carries `category` and wears the package icon.

**Below the threshold a scope diagram draws its lines faint.** Every line at
0.25 opacity, and the lines touching the hovered, inspected or picked box
drawn whole — `.canvas-faint` / `.edge-near`, a DOM class the page toggles on
the line elements with no render, because a hover that renders re-renders
every edge. Never in a focus, where the lines are the answer, and never in a
diff; the following lens's 0.15 wins.

**The structural diff is a diff of two graphs.** `diffGraphs(before, after)`
in `src/graph/diff.ts` is set arithmetic over ids: symbols added and removed,
files touched — same id, and the declaration moved or an edge *from* it came
or went; an edge *to* a file does not touch it — edges added and removed, by
(from, kind, to). `contains` is not diffed: a symbol's container is spelled in
its id. `src/view/diffview.ts` draws the boxes that differ and only those:
added ones from `after`, removed ones as **ghosts** from `before` — the only
place a file no longer on disk still exists, which is the ghost this file once
said could not be drawn — touched ones with the rows `before` had appended and
struck, every changed edge as a line lifted onto files, and a far end the diff
does not name as context (`external`, no `change`). `sinceMs` and `onlyChanged`
are lifted, coverage is not joined. `selectView` draws a diff only when handed
the before graph, its seventh argument; handed one graph it draws the ordinary
slice and drops `diff` from the echo — never the working tree under a diff's
name. Both ends resolve through `resolveDiffEnds` in `server/diff.ts`, shared
with `/api/diff` so the canvas and the lists cannot disagree: `base` is the
session's git base, resolved to a sha *before* it reaches `graphAt`; a commit
is a hex id as `?at=` takes it; frozen, the diff is between two commits.
Scope, focus and category are dropped from the echo. `diff.from.sha` on the
reply is what a ghost's panel reads `/api/detail?at=` from. Always a diagram —
a diff is small by construction, which is the point of one — and it redraws
on every save, because the diff changed. The one hole is `~2`, under Known
limitations. **`?folders=1` applies here too**, and it is the second view worth
having it on: a diff's boxes come from everywhere, so "web/src ×20,
src/project ×9, src/server ×5" is the shape of a change at a glance — measured
on this repository's own commits, 41 to 49 boxes across 8 to 11 folders. **A
ghost's folder is a ghost too**, and it needs no rule: a removed file is a path
like any other, so a folder that exists only in `before` gets a frame holding
only ghosts, drawn dashed with its name struck. `ViewFolder` carries no
`change` — the page derives that from its boxes, rather than two places
deciding what a ghost is.

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

**The component diagram is a view, and it rides the URL beside `at`.** The way in
is the `Components` crumb at the end of the breadcrumb row, View › Components
(checked, so the palette has it) and the canvas menu. Filters, edge kinds and the
commit survive the flip; scope, focus and depth are dropped, because a category
is a fact about the whole project and a URL still naming a directory would
describe a picture that is not on screen. A navigation into a place — a focus, a
scope, a ⌘K pick, a double-click on a relation row — leaves it: a place is the
class diagram's to draw. The server builds it from `session.clustersOf(graph)`,
the same clusters `/api/clusters` answers with, so a frozen component diagram is
the commit's categories under today's names. A component box is its own React
Flow node type, never a BoxNode: it lists what it provides, not members, and has
no scope, so double-click is not bound. Click opens the panel on Provides (the
server's twelve, `≥ total`), the lines that touch it, and its files. A named box
wears its category's colour, joined off `/api/clusters` by stored id — slate when
none was chosen; an unnamed one is plain; the no-category box is dimmed. No
frames are drawn on it: an outer category's leaves are the boxes, and its name is
only in the Categories section.

- Above 40 files in scope, boxes stand for directories, and edges between them are
  aggregated with a weight. In a *focus* view, neighbours past a threshold collapse
  into a **bundle** — one box carrying a count and the ids it stands for, so 278
  boxes become 3. Sourcetrail's judgement, taken with it: bundling is skipped when
  the focused node is a file, because then the neighbours *are* the answer.
- **The window is an input to the layout.** A dagre rank taller than the canvas
  folds into further columns; 127 boxes in one unreadable column was the symptom.
  And `onlyRenderVisibleElements` is on: 23 508 DOM elements became 412 on a
  1 129-box view, and the update 142 ms became 52.
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
widens back to everything. Keep `toSpec` and `toSocketSpec` apart. `diagram` is
one key both read under the same name, because the page sends the socket
the spec the server echoed; a socket that sent it was pushed component boxes,
and a reader that dropped it would push the class diagram to a page drawing
components. `as`, `category` and `diff` are the other three: optional on
`ViewSpec` — absent, never null, so a spec written before they existed is
still a spec and JSON drops nothing — and read for both formats by one
`optionalKeys(raw)` in `app.ts`. The price of optional is that a reader which
forgets one compiles, so it is checked by sending the server's own echo back
over the socket, not by the type.

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
- **Source Control has a "Structural diff · since HEAD  +12 −3" row** between
  the base picker and the file list — symbols added and removed, from
  `/api/diff`, refetched whenever the graph moves, the base changes or the
  commit on screen does. Clicking it opens `?diff=`, and it holds the
  list-selection fill while the diagram is one. The base picker applies to
  it: the diff is against whatever the working tree is compared with. Frozen
  at `?at=`, the diff is against the commit's first parent from the log, and
  the row and View › Structural diff are greyed with the reason for a root
  commit, a commit past the 300-commit log, or a project with no git. The
  front page's Changes section draws the same row from the same numbers.

## Architectural groups

The graph finds groups of files that lean on each other more than on anything else —
label propagation over the import graph, deterministic, no model involved. A person,
or an agent, gives them names — or a model suggests one and a person accepts it; or,
where the imports found nothing worth naming, a model **proposes** a grouping and a
person accepts that, which stores it as one they drew. See non-negotiable decision 5
for the rule that governs membership, and *Asking about the categories* for the two
paid presses.

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
- **`evidenceFor(graph, files)` judges a set the graph did not choose.** Any set —
  a proposal, a hand-drawn frame — gets the same cohesion a `Cluster` carries, the
  `inside`/`leaving` counts it is a ratio of, who reaches in and what it reaches,
  the members that are tests, and the proposed paths this project has no file for.
  `fileLinks(graph)` is the one home of "what couples two files" (not `contains`,
  not `depends`, never a test at either end), and `undirectedNeighbours` is built
  from it — so the number the clustering computes and the number a proposal is
  judged by cannot drift apart.

## The rest of the page

- **The left bar** is Repository › Source Control › Categories › Detail, 300px,
  and the right bar is Following › Activity, 330px. Left is what the project
  *is* — everything you go and open; right is what is happening to it, which is
  what you glance at. Detail and Activity changed places on 2026-09-08, and
  `panes.ts`'s `LAYOUT_VERSION` went to 2 for it: both bars kept their length,
  so a stored stack would have been read by position and would have handed one
  pane's height to the other in silence.
  The Repository panel absorbed the hook banner: hook, MCP and port file are rows,
  and "Install hook" is a button under them, hidden once installed. Activity
  describes *now* even while the diagram is frozen: the agent is still working in
  the working tree.
- **Activity says who wrote each change, or says plainly that nobody claimed it.**
  A `who` column, drawn only once something has claimed a change — in a project
  where nothing does it would be one word repeated eighty times — and a change
  the watcher merely noticed reads `unknown`. Never a blank and never a guess:
  the watcher cannot tell an agent from a build script from a person in an
  editor. `docs/AGENTS.md` is how another tool gets its own name on the map.
- **A category on the page is a group in the code.** The section, its menu items
  and the frame on the canvas say "category" — the user's word. The file stays
  `.codemap/groups.json`, the API stays `/api/clusters` and `/api/groups`, the MCP
  tools stay `list_groups` / `name_group`, the CSS classes stay `.group-*`. Do not
  "fix" either side toward the other.
- **Under the Categories tree sits Ask, and it is two presses, not one.** A
  question reads the categories and answers about them; "Propose a grouping"
  reads the files and the imports and says how the project could divide, for
  the project where the tree above is empty. Each says its price before it is
  pressed. A proposal is drawn to be judged — the name, the sentence, then
  **our** numbers and every one of its files — and accepting it is the ordinary
  create, so the category is marked "by hand" everywhere. Neither press writes
  anything on its own.
- **The Categories section is VS Code's tree.** Every category is a 22px row with
  a chevron, folded by default and not persisted, that hides its files and never a
  category nested in it; a suggested name sits on that row with its ✓ and ✕, so
  accepting never needs unfolding; editing unfolds, renaming does not; ← folds
  and → unfolds the focused row, and the header has Collapse all / Expand all.
- **The status bar.** 22px at the bottom: branch, ahead/behind, the "Changes" count
  that toggles the filter, then boxes and files, "N tests hidden" (a button that
  shows them) while `tests=0`, "N files with syntax errors" and "not read: …" for
  what the tool cannot fully read, the language summary and the agent's
  connection. Every item is information or runs something. Under a diff the
  boxes read `+A −R ~T since <base>` — added, removed (the ghosts), changed in
  shape — and on the front page it shows files only, there being no boxes.
- **The menu bar.** Two rows: menus and project on top, breadcrumb and filter chips
  below. **Nothing in a menu is decoration.** Every item runs something the app can
  already do, and an item that needs a selection is greyed with the reason in its
  tooltip rather than silently doing nothing. View › "Hide tests" is a checked item
  that drives `tests=0`; View › "Re-layout" (⇧⌘L) is the only way after the first
  layout to run dagre again. Above 150 boxes in focus mode a chip in the breadcrumb
  row says "N boxes — depth 1 is quicker" and sets depth 1. View › "Components"
  is checked while the component diagram is on; "Control flow of the selection…"
  opens the flow overlay, greyed with where to pick a symbol when the selection
  is a box; "Association edges (has-a)" and "Dependency edges (named in a
  signature)" are checked items greyed with "No class or interface in view to
  draw one from" when every box is a file box without one — unless already on,
  when the item is the way back off. The breadcrumb row ends in the `Components`
  crumb, which holds the accent while on. View › "Show as list" is a checked
  item — also in the canvas menu and the palette — greyed on the front page
  ("already a list") and under a diff; View › "Structural diff" is checked
  while `?diff=` is on and greyed with the reason where nothing can be
  compared; Go › "Draw the whole project" opens the root diagram. Zoom, Fit,
  Re-layout, Expand and ⌘F are greyed on the front page and while a list is up,
  each with the way out in its tooltip. Three more chips in the breadcrumb
  row: "N boxes — shown as a list" (click draws it anyway), "⚠ N boxes — drawn
  anyway ✕" (✕ drops `as`), "shown as a list ✕"; and "Structural diff since
  HEAD ✕" beside the frozen chip while a diff is on.
- **The front page** (`web/src/Overview.tsx`) is what `/` shows instead of the
  root diagram: `GET /api/overview`, refetched on `revision`, `groupsRevision`,
  the newest agent call and a project switch, its row order held across
  refetches. Sections in the side bars' own shape: the project (root, files
  with tests counted, languages, what cannot be read, syntax errors); entry
  points — the manifests' with the reason on every row, folded by reason at
  nine or more, because 57 rows on astrupdata is the hairball as a list — then
  the graph's own roots, twelve with the total; the named categories with size
  and cohesion or "by hand", the unnamed and the orphans counted; changes
  against the base, with the structural diff row; the agent. **Every row is a
  link**: an entry point to `?focus=`, a category to `?category=`, the changes
  to `?changed=1`, the unnamed to the Categories section, the diff to
  `?diff=`, "Draw the whole project" to `?scope=&as=diagram` with the box
  count on it. A number that leads nowhere is furniture, and the two that do —
  a language, a root past the twelfth — say so in their titles. It covers the
  canvas at z-index 8, under the welcome screen's 20, never the window.
- **The welcome screen.** Shown from Help, and when there is genuinely no
  project to draw. **Not** when a filter emptied the view, and not for a
  project that has nothing but a front page. It covers the canvas, not the
  window — it used to position against the viewport and painted over the menu bar,
  both side bars and the status bar, which buried every way back out.
- **Search.** ⌘K searches the **whole graph**, not the slice on screen — the
  commit's graph while frozen. Matching is a subsequence, the way editors do it:
  `gst` finds `GraphStore`; ranking is exact name, then code before test, fixture
  and `.d.ts`, then match quality, then the shorter path. The keyboard owns the
  active row; the mouse only hovers and clicks.
- **⌘F is the other half of the pair, and the difference is the whole reason both
  exist.** ⌘K searches the project and takes you somewhere; ⌘F searches what is
  *drawn* and takes you nowhere — it lights the matching boxes and member rows,
  Enter and ⇧Enter step the camera through them, and it rides no URL, because a
  highlight is not a view. It refuses to open on an empty diagram, the same
  state that greys it in the menu and in the palette.
- **⇧⌘P runs anything the menu bar can.** The palette is built *from* the menus,
  so it can never offer an action a menu does not, and a greyed command appears
  greyed with its reason rather than being hidden — being told why is the point.
  Both palettes are one Tab stop: rows are `tabIndex -1` and Tab is trapped, so
  focus cannot wander out of a modal that claims `aria-modal`.
- **Every list is one Tab stop, not one per row.** `listkeys.ts` — arrows move,
  Home and End jump, Enter is left to the browser because every row is already a
  button. Before it, getting past Source Control meant 300 presses. The stop
  follows the *focused row* and not a remembered index, or a file arriving above
  it on an agent's save would move the stop to its neighbour.
- **Call, association and dependency edges** are off by default (`?calls=1`,
  `?associates=1`, `?depends=1`). A call or an association *replaces* the import
  between the same pair rather than being drawn beside it; a dependency is drawn
  beside it, being too weak to stand in for one. Each is a chip in the
  breadcrumb row that removes only itself.
- **The side panel.** A followed method or field prints the graph's coverage
  sentence and "known used by N", never "0 in". A relation row prints the graph's
  phrase, never the kind — `composed of`, `aggregates` or `holds` for an
  association by the rule that draws its diamond, `depends on` for a dependency,
  which the panel lists under uses and used by although the hook does not say it.
  Click inspects, double-click navigates. `zoomOnDoubleClick` is
  off and must stay off: d3-zoom handles a double click on the pane and stops it
  bubbling, so `onNodeDoubleClick` never fires and the view silently zooms instead.
- **The flow overlay** covers the canvas, not the window, like the welcome screen.
  A flow is fetched only on a press — a member row's menu, the panel's button,
  View › Control flow of the selection… — because it is a parse; while open it is
  re-read on every save, because the file may have changed; above 40 boxes it is
  refused until "Draw anyway"; and it closes on navigation, since a link means
  "show me this" and the overlay would hide exactly that. Escape's layers, topmost
  first: a menu, a palette (⌘K or ⇧⌘P, never both), the flow overlay or the
  welcome screen (both cover the canvas at z-index 20, never together), the find
  bar, then the page — the selection, the following lens, a frozen commit.
- **The change feed** is the session's own history, the last 200 batches in memory,
  discarded with the session. It is *not* session history: phase 1's diff is a
  diff of two graphs and keeps nothing, and persisted history, if it comes,
  gets a schema designed for it rather than a ring buffer promoted into one.

## Live updates

Every connected client is sent a view **computed for its own spec**. The behaviour is
*mark, do not move*:

- **A mark outlasts a glance.** A written box holds the amber border and title
  for **two minutes**, weakening once at twenty seconds; a box the agent asked
  about holds blue for one minute, weakening at ten. Both numbers, and the
  banding, live in `web/src/marks.ts` with their test. They used to be one
  number, 2 500 ms, and that was the whole of a real bug report: the socket
  pushed correctly the entire time, and the mark was gone before anyone looked
  up from their terminal, so the diagram simply had one more box than it had —
  which reads as "nothing appeared until I refreshed".
- **A box that was not there a moment ago says so**, with a `new` tag in its
  title for as long as the mark stands. It is decided on the client, from the
  files the incoming view has that the outgoing one did not, because nothing in
  the graph carries a birthday and git's `A` is against a base rather than
  against a minute ago. It is sticky: a file that appeared and was then edited
  twice is still, to somebody coming back, a new file.
- **The pulse is not the mark.** The 1.1s×2 border animation announces, for the
  reader watching right now, and is skipped entirely when a batch would light
  more than `PULSE_MAX` (8) boxes — a `git checkout` or a codemod. Forty things
  flashing at once is a fault light, not information; the marks still land on
  all forty, the amber reads as a heat map, and the list of what arrived is
  Activity's job.
- **The minimap is the arrow to work off screen.** A marked node is drawn in its
  mark's colour there, so a diagram wider than the window still says where the
  heat is, and a click on a minimap node centres the camera on it at the zoom
  the reader chose. `pannable` alone only moves the camera by dragging the
  viewport rectangle, so the heat could be seen and not reached — half an
  arrow. That is deliberately not a second mechanism beside the "N changes
  outside" badge, which counts what has no box at all, names the files and
  their writers in its title, and clears itself when it is clicked. The camera
  never moves on its own; a click is a person asking.

- **dagre runs for a view's first layout — once its clusters have arrived — and
  for View › Re-layout, and for nothing else. A person is the third thing that
  moves a box, and a hand placement wins over every computed position.** A save that adds a box keeps every
  existing box where it stands and puts the new one beside its most connected
  neighbour: to the right on a 40px grid, first free slot, below when the row is
  full; a box connected to nothing starts a new row under the diagram
  (`keepLayout` in `web/src/layout.ts`, tested). Frames are redrawn with
  `frameClusters` around wherever the boxes now are. The one existing box that
  moves is the column under a box that expanded, by its growth. Five reviewers
  named the shuffle-on-save as the thing that broke "mark, do not move"; do not
  bring back a layout key that re-runs dagre when the box set changes. The
  component diagram keeps the same rule: a named box is keyed on `storedId` and
  stays put; an unnamed one is keyed on the cluster id, which embeds the member
  count and shifts when membership drifts, exactly as a frame does.
- **Shutting a folder frame is the third thing that lays a view out afresh, and
  it does not bend the rule above: that rule is about a save.** A fold is a
  person pressing a chevron while looking at the picture, the box set changes
  because they asked it to, and their hand placements still win — those are
  applied over whatever dagre answers. The fold set is in the layout key and in
  nothing else: it is page state, not a URL key, because which folders a reader
  has shut is where they are in reading a picture rather than which picture it
  is, and it is dropped whenever the view changes.
- **Under the folder arrangement a save has to land a new box inside its own
  folder.** `keepLayout` takes the frames and looks for the neighbour only
  among the boxes in that frame, falls back to the frame's own bottom-most box
  rather than to the row under the diagram, and takes a slot only where every
  frame still holds only its own boxes. Verified live: a new `Controllers` file
  whose one import is a model lands beside `HomeController.cs` inside
  `Controllers`, and every other box stays where it stood. Without it the box
  goes beside the model and the `Controllers` frame drawn afterwards is 904px
  wide with `Models/Item.cs` in it — the folder view saying a file is in a
  folder it is not in. A category frame spans directories by definition and
  wants none of this, so the flat arrangement hands over no frames and places
  exactly as it always did.
- **Dragging a frame locks it**, the way pulling a corner does; the lock button only
  releases. A frame that had to be locked before it could be moved was the wrong
  order, and it was reported as such.
- **A box is moved by its title bar, and sized by its side.** `nodesDraggable`
  is on and every box carries `dragHandle: '.box-title'` — the way a window
  moves by its title bar and a frame moves by its label. Not the whole box:
  every member row is already a control, and the three buttons in the title
  wear `nodrag` so a press on one stays a press. Dragging one of several
  picked boxes moves them all, which is React Flow's own gesture and the same
  selection "Create category from selection…" reads. **A click is a drag of no
  distance** — d3 fires its start and its end for a press that never moved —
  so a placement is written only when the reported position differs from where
  the box is drawn; without that, every box somebody clicked to inspect was
  pinned where it already stood.
- **Width is the only size a box has, and height stays derived.** A box's
  height is a header plus a row per member, so a stretched one would claim
  symbols the file has not got; width says nothing about content and shows
  more of a long path. Two `NodeResizeControl` lines, left and right,
  `resizeDirection="horizontal"`, bounded by `MIN_BOX_WIDTH` 160 and
  `MAX_BOX_WIDTH` 720. Somebody who wants a taller box wants more members, and
  `+N more` and Expand every box already do that. The canvas is controlled, so
  React Flow reports a resize and applies nothing: the width is held in state
  on every frame of the pull and written to the browser once, when the edge is
  let go.
- **A hand placement lives in the browser, never in the project.** All the
  arithmetic is `web/src/placement.ts`, tested beside itself: `localStorage`
  under `codemap.placements`, keyed by project root and by view — the diagram,
  the focus, the category, the scope and whether a diff is on, and *not* the
  filters, the depth, the commit or `as`, because those change which boxes are
  drawn and not where the drawn ones belong. A list gets no key at all, so
  `?as=list` cannot store anything by construction. A frame's geometry goes in
  `.codemap/groups.json` because a category is a piece of architecture; one
  person's arrangement of one view on one screen is not, and writing it into a
  repository somebody opened only to read is the objection the `.codemap/`
  consent gate exists for. A placement is kept until it is dropped, never
  until its box is off screen: hiding tests, filtering to changes, navigating
  away and an agent deleting a file all cost nothing, and a box that comes
  back is where it was left.
- **`applyPlacements` runs after the layout and before the frames**, and the
  applied positions are what the layout cache records. After the layout,
  because a placement wins over dagre, over `keepLayout` and over the growth
  push a box that expanded gives the column under it. Before the frames,
  because a frame is drawn tight around where its members actually landed — a
  locked frame is a placement of its own and still wins. Recorded, because
  `keepLayout` places the next new box beside its most connected neighbour and
  has to be told where that neighbour actually is: measured on astrupdata, a
  new file importing a box somebody had dragged to (1553, 958) landed at
  (1840, 960), which is its right-hand slot on the grid.
- **Two ways back, and both say what they drop.** View › Re-layout (⇧⌘L) reads
  `Re-layout · drops 3 placed boxes` and clears the whole view's placements —
  the whole view and not only the drawn half, or turning a filter off would put
  the arrangement back. A box's own right-click menu offers "Put this box
  back", greyed with "This box is where the layout put it" when it has not been
  moved; it drops the one placement and forgets the box's rectangle, so
  `keepLayout` places it the way it places a box that has just arrived. That
  slot is regularly off screen on a wide diagram, so the camera is moved to it
  — and only then.
- **A list re-sorts nothing under the reader's cursor.** `holdOrder` in
  `web/src/listrows.ts` keeps the order across an update: a count that changed
  changes on its row and the row pulses where it stands, a row that has gone is
  dropped, a new row lands after the nearest standing row the sort puts before
  it. Only a header click or a new view sorts afresh. Measured: lib sorted by
  In, two imports added, 106 rows in the same order with three counts changed
  in place. The front page holds its roots and its changed files the same way.
- A socket whose spec names a commit is not pushed `update` at all — a frozen view
  is frozen — and the page refuses `update` frames while frozen as well. Because
  that push was what bumped `revision`, the page polls changes, git status and the
  log every 3 s while frozen so the left bar keeps describing now.
- A socket whose spec carries `diff` is pushed the ordinary slice with no
  `diff` in its echo, because the hub holds one graph; the page reads the
  mismatch as "the diff changed", refetches `/api/view` and keeps the pulse.
  Measured: route echo `diff: "base"` with 9 nodes, hub push `undefined` with
  12. The proper push is item 3 under "What to build next".
- A `groups` write pushes `update` to a client scoped to a category as well as
  to one drawing components: a groups.json write can move a category's members.
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

**And the app writes that file too, on a press, the way it writes the hook.**
Both channels were built and only one of them was one button away, which is how
a project with a working `settings.json` and no `.mcp.json` looked connected
while the agent had no tools at all — measured, once, and it was one file.
`project/mcp-install.ts` detects, previews and merges: every other MCP server in
the file keeps its entry, an unparseable config is refused rather than
overwritten, and the packaged `.app` — which ships `dist/` without
`scripts/mcp.mjs` — greys the button and names the directory it looked in.
**`installed` is a claim about a script that is really on disk**, resolved
against the project root because that is the working directory Claude Code
spawns a server in: so codemap's own committed `["scripts/mcp.mjs"]` reads as
current and the identical line copied into another project reads as not
installed, which is exactly the failure the button exists for. The one thing no
button can do is said in the button's own words before it is pressed — **Claude
Code reads `.mcp.json` when a session starts, so the agent must be restarted
once.**

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
lightbulb is for when no agent is running, says on the button what a press
costs, and
never decides who belongs.

```
list_groups     the clusters, named and unnamed; "by hand" for a drawn one,
                never a cohesion; nested ones under their parent; stored
                names that match nothing as "stored, matches nothing"
name_group      accept one with a name
describe_file   declares / used by / uses
search_symbols  subsequence search over the whole project
describe_changes  what the shape did since a commit — files, symbols and the
                file pairs coupling crossed, off /api/diff. `since` is a commit
                id or the session's own base; the other end is always the
                working tree, because "what have I done" has no second date
list_dependents what leans on a file (/api/detail) or a symbol (/api/symbol),
                grouped by file. `path#name` for a member is resolved through
                the file's box when the owner was not written — no other tool
                hands out a member's id, and the refusal lists the real ones
describe_blind_spots  where the map of one file stops: unresolved imports and
                calls off the box in /api/view, and the parse error flag
note_change     the agent says what it just changed, and why — at most 200
                characters, session memory, never .codemap/
```

**Every answer says what it does not know, and that is not decoration.** The
three read-only tools above print the graph's own `importedByNote`,
`coverageNote` and diff `caveat` verbatim rather than a summary of them, so a
method with no callers reads "an empty list means unknown, not none" and never
"0 in" — the same failure the explain prompt was fixed for. Lists are capped
and the cap says how many were dropped: a truncated list nobody is told is
truncated is read as the whole answer. `describe_blind_spots` is the one that
exists only to admit a gap, and it is worth more than it sounds — it is what
tells a box with few edges apart from coupling the tool lost.

**One tool call is one row in the timeline.** A tool that has to ask twice —
`list_dependents` resolving `path#name` against the file's box — marks the
first request only, because a second row under the same name reads as the agent
asking the same thing twice. See *Seeing the agent*.

It holds no graph of its own; it talks to a running codemap over HTTP and finds it
through the same `.claude/codemap.port` file the hook reads.

## Explaining what the graph found

The graph says a symbol is called by four things. It cannot say what it is *for*.
`src/project/explain.ts` spawns `claude -p` with the source and the graph's own
relations, and asks for a role rather than a walkthrough. Answers land in
`.codemap/explain.json`, beside `groups.json` — for the user to commit when they
choose; this repository's copy is untracked today.

**It spends the user's money, so nothing is implicit — and "nothing is
implicit" is about the press, not about a receipt.** A run happens only on a
press, and a control that will spend says so before it is pressed. What a run
*cost* afterwards is not drawn: the number was asked for and removed on
2026-09-08, because a price beside every answer is noise in a panel a person
reads for the answer. The cost is still measured and still on the wire, for
anything that wants it. The panel says what a reading now stands to: `current`, `stale` (the source was rewritten — the fingerprint is
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

## Asking about the categories

Two paid presses under the Categories section, in one panel, and **they are two
jobs and must never be drawn as one**. A question is answered *from the
categories that exist*; propose is asked *how the project divides* when they do
not. `src/project/ask.ts` holds both invocations, `src/server/ask.ts` both
routes, `web/src/Ask.tsx` the panel and `web/src/ask.ts` its pure half.

**Neither writes anything.** Decision 4 keeps the model out of the graph;
decision 5, on the reading above, keeps it out of who belongs: a model may
propose and may never store. Every write on this path is the one a person
already had — `POST /api/clusters` for a name, `POST /api/groups` for a group.

**The conversation.** `ask()` is explain's measured invocation — the four
load-bearing flags, `cwd: os.tmpdir()` — with two differences: `--json-schema`
is given up, because prose is the answer and a schema would make the CLI hold
it until the end, and `--resume` carries the CLI's own session so a follow-up
does not send the categories again. Measured on this repository's eleven
categories: **$0.0257 a first question, $0.0112 a follow-up.** It is told what
the component diagram draws — the categories, their files, cohesion, what each
provides, the weighted edges between them — and **no source at all**.

- The words **stream**, and that is the design. First characters at 1.8–2.3 s,
  the first word of the *answer* at 6–22 s, so the model's own thinking is
  streamed on its own delta kind and drawn — dim, monospace, capped — until
  the answer starts, then steps aside. It is never drawn *as* the answer.
- `POST /api/ask` answers **202** and the words arrive on the socket
  (`ask`, `ask-delta`); a 3 s poll of the GET is the fallback that also
  notices a run another tab started, and a project switch, which closes the
  conversation rather than carrying it to another project's categories.

**Proposing a grouping.** The project this exists for is the one with no
categories — the user's own, which had one and rejected it, so there was
nothing to talk about and nothing to name. `propose()` is a *separate*
invocation, not a turn of the conversation and not `suggest.ts` (which names
the clusters the algorithm already found and proposes no membership).

- **What is sent** is `ProposeContext`: every non-test file, which category
  already holds each, and every reference between two files from `fileLinks`.
  That is what a person would need to group by hand and nothing more — no
  source, no symbols, no coverage, no git. `--json-schema` is kept, because
  nobody watches a list stream, and `--no-session-persistence` because nothing
  resumes it.
- **The evidence is ours, and that is the whole defence.** `judge()` attaches
  `evidenceFor` and the overlap with every accepted category, read off one
  graph. The page draws the cohesion as the two counts it is a ratio of — "5 of
  45 references stay inside (11%)" — in the warning colour below `MIN_COHESION`,
  the cut the clustering itself uses. Measured on a real Next.js project, haiku
  proposed four groupings at 0%, 1%, 4% and 0% with sentences beside them that
  read like architecture. **The number is what stops that being believed**, and
  it does not stop the accept: a person may know something the imports do not.
- **What a proposal carries, and the panel shows all of it**: the files, exactly
  — the paths, never "the parser files"; the name and the sentence; the
  cohesion and who reaches in; the overlap, because covering unclaimed files
  and re-cutting an accepted category are different acts; and `invented`, the
  paths the answer named that this project has no file for, which are never
  hidden. `dropped` counts the proposals that named too few real files to be
  worth judging.
- **Too big is a refusal, before a cent is spent.** Above 600 files or 3 000
  references `tooBigToPropose` answers 400 with a sentence. A grouping is only
  true if it was made from all of the coupling; a model handed a tenth of the
  graph would confidently group that tenth.
- **Nothing streams**, so the panel says what it is reading and that it will
  sit still: measured **$0.040 and 37 s** for a nine-file project through the
  page, and $0.074 / 104 s, $0.129 / 120 s and $0.129 / 140 s over three real
  projects at 9, 307 and 119 groupable files. Size barely moves it, so the
  button's estimate is one number — and the run prints what it **really** cost
  under the answer, the way a turn of the conversation and an explain run do.
  The run is session state on the server, so it survives a
  reload and dies with a project switch; `{ action: 'drop-proposal' }` throws it
  away and leaves nothing behind.
- **Accepting is the create that already exists.** `groupAction({ action:
  'create', name, files })` — `origin: 'manual'`, marked "by hand" on the frame,
  in the panel, on the front page and on the component diagram. If the project
  has no `.codemap/` the server's consent question is raised and answered
  exactly as it is for a hand-drawn category, and the proposal row says it is
  not stored yet.

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

- **Pin what the graph draws, not only what a function returns.** Every unit test
  passed while five invented edges lived in zod, twelve false imports in flask
  and a symbol list omitted four public methods, because each function was right
  and the composition lied. `scripts/baseline.mjs` records files, nodes and edges
  by kind, guessed edges, unresolved counts, the root view and the clusters for
  express, zod, cobra and flask — four languages, so a change to one resolver
  moves one project and leaves the others alone. **The comparison is
  directional**: a count moving towards more resolved prints and passes, one
  moving the other way fails and names the project and the count. A test that
  failed on every improvement would be deleted within the week.
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
- **The corpus baseline is checked in; the clones are not.** `src/oracle/baseline.json`
  holds what the engine makes of express, zod, cobra and flask at pinned commits —
  four languages, so a resolver that quietly stops answering for one of them is not
  hidden by the other three — and `src/oracle/baseline.test.ts` runs
  `scripts/baseline.mjs` against them. **The comparison is the design**: a count that
  moves towards more resolved passes and prints what changed, a count that moves the
  other way fails and names the project and the count, and `--accept` is how a better
  baseline is written down. A test must never clone from the network, so the clones
  are optional and skip with their fetch command printed; the oracle's own fixture is
  in the same file and measured on every run, which is what keeps this from being a
  suite nobody notices skipping.
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

- **The folder arrangement says something only where the tree has depth.** Over
  four real projects, taking every directory as a scope and counting the 110
  that draw as a diagram at all: 29 draw at least one frame and 79 have no
  subfolder to frame. The collapse rule (a folder holding nothing but one
  subfolder) fires on 7 folders in all of them and 0 times on the largest, so a
  design that leans on it will look fine here and do nothing there.
  `MAX_FOLDER_DEPTH` has never bound on real code — the deepest drawable scope
  measured is this repository's `src/lang/fixtures` at four levels, and
  `?tests=0` hides it.
- **A folder arrangement does not fold a tall rank, so it can be much taller
  than the window.** `wrapTallRanks` re-spaces a column by rank alone, without
  the border nodes dagre uses to keep clusters apart, so a fold splits a folder
  across columns and the frame stretches over other folders' boxes — 28 such
  frames over astrup's drawable scopes, 3 670 over the whole project, and 0
  with the fold off. Measured live: astrup's `components` forced to a diagram
  is 65 boxes in one tall column at zoom 0.2, where the flat arrangement of the
  same scope folds into three columns at 0.74. A tall picture beats a false
  one; folding whole frames rather than whole ranks is the fix and is not
  built.
- **A save under the folder arrangement can still stretch a frame.**
  `keepLayout`'s strict pass gives up after `REACH` when a folder is boxed in
  on every side; the loose pass then keeps the new box out of another folder's
  frame, but cannot keep its own frame off their boxes. How often that fires on
  a real save is not measured — the one case driven live (a new file in a
  one-box `Controllers` folder) landed inside its own frame with nothing else
  moving.
- **A folder frame has no gestures but the fold.** A directory cannot be
  renamed, coloured, deleted or dragged from a diagram, so it offers none of
  what a category frame offers; clicking one selects nothing and the panel says
  nothing about it. A shut folder box is double-clicked to go inside, like the
  folder box above the grouping threshold that it is.
- **A mark is this page's memory and nothing else's.** It lives in `App.tsx`
  state, so a reload loses every mark and a project switch clears them on
  purpose; two tabs on one project mark independently. The server's change feed
  is what survives, and it is the session's, not the project's. A file the
  agent wrote while the page was on another project is never marked at all.
- **A component box wears the two signals as booleans**, not as bands, and gets
  no `new` tag and no pulse: `ComponentNode` reads `changed` / `queried`, and a
  component stands for a pile of files rather than for one. So on the component
  diagram a write from two minutes ago and one from two seconds ago look the
  same.
- **`new` is new to the diagram, not new to the project.** It is decided from
  the view the page held a moment ago, so a file that arrives in a batch the
  page could not place against a previous view — a structural diff, an `update`
  that raced a navigation — is marked as an edit. There is nothing dishonest in
  it, but it is not a birthday.
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
  (`path#name~2`), so their ids shift if their relative order changes — and
  the diff reads the first of two overloads removed as the second removed and
  the first moved, and a swap as every edge moved. Pinned in
  `graph/diff.test.ts`, stated as `caveat` on every `/api/diff` reply, and
  not yet said anywhere on the canvas.
- A file with a syntax error still loses symbols — tree-sitter is error-tolerant —
  but the box carries a warning badge and the status bar counts them
  (`ParsedFile.hasError`). The flag is the grammar's word, not the compiler's:
  tree-sitter-typescript 0.23.2 marks TS 5.0 `export type * from` and TS 4.7
  `in`/`out` variance annotations as errors, so a barrel written that way wears
  the badge until the grammar is upgraded.
- A directory named `target` is skipped everywhere (`IGNORED_DIRECTORIES`), because
  Cargo's build output is 2 818 "unreadable" files on this repository alone and
  the scan drew generated `.rs` from it as source. That list needs no git and
  applies first; **what git ignores is dropped after it.** The boot scan removes
  every file `git ls-files --others --ignored --exclude-standard --directory`
  lists under the project (`listIgnored`, `ignoredBy` in `project/git.ts`), and
  the updater asks `git check-ignore` once per batch so a build that runs while
  the watcher is on cannot write it back. The diff made this load-bearing: the
  live scan used to read gitignored build output that `git archive` does not
  hold, so on astrupdata every base → live diff reported `functions/lib/index.js`
  and `next-env.d.ts` as added — 184 symbols, 226 edges — before the session's
  own edits, and the front page listed the bundle as the manifest's `main` while
  the source it was built from showed under roots. A project without git keeps
  every file it has.
- **The diff knows only what the graph knows.** An edit that moves no
  declaration and changes no resolved reference is invisible — 2 of
  astrupdata's 41 modified source files over five commits, a className string
  and a comment; git is the tool for those. A file that lost an edge to a
  deleted file reads as touched though git calls it unchanged. A member row is
  only ever added or removed, never touched. A change in `roles` or `guessed`
  alone is not a change. `/api/diff` answers the whole lists with no cap — 235
  edges for HEAD~1 → live on astrupdata. `?diff=base&at=<sha>` is that commit
  against the session's base, and empty at HEAD. `changed=1` and `since=` do
  nothing under a diff, and their chips show anyway; `?diff=&as=list` reaches
  the list, which wears the diff's letters but pulses nothing. `keepLayout`
  puts a new box beside its most connected neighbour, under a diff often
  outside the camera — Fit to screen was needed to see the ghost after a save.
- **Facts are read once at boot.** An entry point added after opening shows
  under "nothing imports it" until the project is reopened; a removed one is
  filtered out, because the overview reads the graph. Build output named by a
  manifest is dropped, never mapped to `src/`. Not listed: Next's
  `middleware.ts` and `instrumentation.ts`, a Python `__main__` guard (only
  `__main__.py`). Go `func main` is fixture-tested only, no clone being on
  hand. Roots count every edge kind but `contains` as reaching, so a file
  named only in a signature is "reached", while one loaded through a dynamic
  `import()` or `new Worker(url)` is a root — `src/parser/worker.ts` here —
  and its "nothing imports it" is literally true. `rootsTotal` on a types-only
  library is 0.
- **The front page is live only**, and `/?at=<sha>` prints the refusal. The
  changes row is greyed when none of the files named on it has a box, but only
  eight are named, so with more changes and none boxed it still lands on
  "Nothing to show here". Manifest folds are page-local, so Back returns with
  them folded. Going home drops the filters, so a filter set three views ago
  does not survive the trip; the View menu's filter items stay runnable there
  and open the root diagram under that filter. The Categories reveal finds the
  section's title button through the DOM, so a change to that markup makes the
  row scroll and nothing more.
- **The list's in and out are the view's lines and nothing more**: an edge
  kind not switched on is not counted, and the cell prints a bare number, not
  `≥`. Enter on a row is the click; only double-click goes into one, and a
  bundle or component row goes nowhere, as its box does. No coverage column.
  A category deleted from groups.json while a client is scoped to it is
  pushed the root view with `category` absent from the echo while the URL
  still says `?category=`; the next fetch answers 404 — the deleted-focus
  entry's shape. There are no route tests, so that 404 was measured by curl
  and is not pinned.
- **The language boundary is invisible.** A Python backend and a TypeScript front
  end in one tree draw as two islands, correctly — no import crosses, the
  coupling is HTTP — and nothing on screen separates that from a parse that
  failed. langflow's 2711-file frontend sits alone beside "27249 unresolved" in
  the same status bar. There is no edge kind for it and no sentence saying the
  map stopped.
- **tree-sitter-typescript 0.23.2 predates TypeScript 4.7 variance annotations**,
  so `interface $ZodCheck<in T = never>` is a parse error and whatever sat in the
  error region is dropped. That is zod's four `parseErrors` in the baseline, and
  the box carries the warning badge honestly.
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
- An outer group that is exactly the union of its children is not offered beside
  them: the panel asked a person to name one architecture twice, ripgrep as
  twelve rows for ten pieces and serilog as three for two. A nesting that says
  something — zustand's 23 as 10 + 10 + 3 — is untouched.
- **Which single category holds a file is answered twice, and the two answers
  can differ.** `categoryFacts` in `project/hook.ts` sorts every accepted
  category by depth, then size, then name and lets the first claim the file;
  `partitionByCategory` in `view/components.ts` claims in two passes — leaves,
  then outers — and within a pass takes the list in the order it was handed.
  They agree on nesting and disagree on a tie. Reproduced: two hand-drawn
  categories at the same depth both listing `tasky/progress.py`, "Planning"
  (first in the list) and "Ops" (first alphabetically) — the component diagram
  drew the file in Planning while the hook told the agent "It is in the Ops
  category, and reaches into Planning". Both sentences are true of the graph
  and they read as a contradiction, which is what the one-list rule above
  exists to prevent. Unifying them is not a sort: the leaf/outer split is not
  the same order as `depth`, and pass 2 is what gives a rejected leaf's files
  back to the outer that was accepted. Whoever fixes it owns both files.
- **The UML marks stop where the source does.** The near-end multiplicity is
  never drawn; role text stops at three roles and counts the rest, and a folder
  or bundle line concatenates every file line's roles, so two fields named `run`
  on two interface pairs print twice; a line standing for several fields wears a
  diamond only when every stated ownership agrees; a `guessed` line keeps its
  diamond and roles, because they are facts about the field's declaration and the
  dots are about the target. On a TypeScript project nearly every association is
  an interface property with no constructor, so ownership is almost always
  unknown there — 1 of 159 roles on this repository — and a diamond is a Java, C#
  or class-heavy TypeScript thing. An association between two classes in one
  file is in the graph and the panel but never on the canvas: the same-file rule.
  Go, Rust and Python record none of `optional`, `composed`, `handedIn` or
  `dependsOn` — Rust's `Option<T>` and Python's `Optional[T]` could give 0..1 and
  do not, and Go has no field initialiser to read composition from; JavaScript
  records no `dependsOn`, and a JS field handed in but never built
  (`this.#view = repo`) has no `typeName`, so no line. `handedIn` needs a bare
  constructor parameter on the right: `this.x = Objects.requireNonNull(x)`,
  `this.x = x ?? new X()` and `this.x = opts.x` say nothing. `dependsOn` names
  `Promise`, `Map` and `String` too, which resolve to nothing outside the project
  and draw nothing, silently. Java's `Optional` and `@Nullable` are matched by
  simple name; C# 12 primary-constructor parameters on a class are not fields.
- **The component diagram draws leaves, and every test is in "no category".** A
  category with categories inside it is not a box; its leaves are, and its name
  is only in the Categories section. Tests do not vote in the clustering, so they
  are always uncategorised: on this repository with tests shown that box is 64
  files, 49 of them tests, carrying a 72-pair import line into the engine; with
  `tests=0` it is 15 files and the line is gone, and the label does not say how
  many of its files are tests. A drawn category entirely inside a found one is no
  box at all — this repository's "Lang decoder", 7 files inside "Prog.lang
  decoder"'s 12, the same call the overlapping-frame rule makes — and a partial
  overlap shrinks the later box while its cohesion still describes the whole
  cluster. Provides is a floor, read off calls, extends, implements and
  associates: a call through an untyped receiver is not an edge, and an import
  names no symbol, so a type used only in type positions is not listed. The list
  is the server's twelve, and "+N more" is a count with no way in; the panel
  holds the same twelve. A pair can carry both an imports line and a calls line,
  because a call replaces the import between the same two *files*. A frozen
  component diagram keeps the name it was drawn with until reload; a hand edit
  of groups.json is seen by the next `/api/view` and by the two write routes, not
  by the socket push after a save. The clustering itself can flip on an unrelated
  edit (DECISIONS.md has the one that was watched); the leaves held still across
  it, the outer level did not. The status bar still says "7 boxes", not
  components, and a component has no Explain: a category is not a graph node.
- **The flow of one function draws what the tree says and names the rest.** A
  callback's or nested function's body is one box with a note, so
  `items.forEach(x => { if … })` shows no branch; `await` is not a branch; an
  exception thrown by a call is not an edge, only a written `throw` is; a ternary
  or arrow-switch inside a larger expression is counted, not drawn; a throw
  inside a try with several catch clauses goes to end, because the clause is
  chosen by type and the walker knows no types; Go's `goto` is not followed and
  `defer` is drawn where written; an unreachable statement after a return is
  drawn with nothing into it. Node ids are per answer (`n<index>`, `start`,
  `end`) and not stable across edits, so a re-read on a save re-lays out the
  whole diagram, and while the overlay is open every save costs one flow parse
  through the pool. The size warning gates the drawing, not the parse, which has
  already run. `derive` at 116 boxes is legible only zoomed in, and its back
  edges cross the body where a loop is wide. The overlay's "selection" is the
  panel's open symbol or one followed symbol, never a box — a box is a file, and
  the greyed item says where to pick one; the canvas way in depends on BoxNode
  stamping `data-member-id` on each row. C#, Rust and Python get a greyed item or
  the engine's sentence, never a diagram.
- **The table mark is EF Core's `DbSet<T>` and nothing else yet.** A table
  reached only through fluent configuration — dotnet/eShop's `requests` and
  `orderstatus`, 2 of its ordering schema's 7 — is a plain class; an owned type
  (`OwnsOne`: eShopOnWeb's Address, CatalogItemOrdered) is drawn as the
  association it is and not folded into its owner; a `[NotMapped]` property is
  a row like any other. A project declaring its own `DbSet<T>` would wear the
  mark falsely, the way its own `List<T>` would read as a collection. JPA's
  `@Entity`, TypeORM's `@Entity`, SQLAlchemy's `__tablename__` and Django's
  `models.Model` state the same fact and are not read yet — each is one
  reader's change; Drizzle, Mongoose and Prisma are not, because a top-level
  `const` is not a node and `.prisma` has no language. The mark is on the box
  and in `/api/view` only: `view/diffview.ts` builds its own rows and drops
  it under a structural diff, and `view/detail.ts` does not say it in the
  panel.
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
- **A proposal's sentence is unchecked, and only its numbers are ours.** "Core
  infrastructure that classifies on-chain events" beside a verified 1% is
  prose nothing verified sitting next to a number that was measured, and a
  reader who reads the sentence and not the number is misled. The prompt
  forbids counts in it; a real run still wrote "(5 references total)" into one,
  and two of the three verification runs put counts in prose anyway — one of
  them wrong, a note claiming "seven groups cover 105 of 119 files" over seven
  groups that hold 104. This is the same failure explain has, and the same
  answer: the number is in front of them first.
- **A low cohesion is not proof a grouping is false, and the page cannot tell
  the two apart.** Measured on this repository: `src/graph/*` came back at
  **8.7%** (8 references inside, 84 leaving) and `src/parser/*` at **10.9%** —
  both of them modules this file names in its own Layout, both drawn in the
  warning colour under a tooltip saying the clustering would not have offered
  them. They are true, and they are *hubs*: everything imports
  `graph/types.ts`. On astrup the same colour and the same sentence sat under
  "Theme & Color Management", 9 inside and 222 leaving — nine unrelated leaf
  utilities with a tidy name. Nothing on screen separates a core everything
  depends on from a pile of files that share a topic, and the reach line does
  not either: both are "many reach in, one or two reached out to". The warning
  is still right to be there; it is the second case it is for.
- The reach line counts no test file. `reachedFrom` and `reaches` come from
  `fileLinks`, which drops a test at either end, so a group three suites
  import reads "1 file reaches in". It is exactly the set of edges the
  cohesion is a ratio of — consistent rather than wrong — but it is not the
  answer to "who uses this".
- A proposal is judged **once**, when the answer lands. Accepting one changes
  what the next overlaps and the line does not know — the row's own
  "added · by hand" is what says the state moved on, and the line's title says
  when it was counted. The summary above the list also counts what came back,
  not what is still on screen after a dismiss.
- A proposal's own accept mark is matched **by name**: a category of that name
  in the list means added. Two categories that share a name would mark each
  other, which nothing prevents and nobody has hit.
- The propose size caps (600 files, 3 000 references) are a judgement with room
  above the largest project measured (305 files, 1 092 references), not a
  measurement. Nothing that big has actually been sent, so whether an answer at
  600 files is still coherent is unknown; the refusal above it is the part that
  is stood behind.
- `propose` has no cancel: dismissing a run in flight refuses the answer, and
  the money is already spent — the same as explain and suggest. Two presses can
  spend at once, because the question and the proposal are separate runs and
  neither blocks the other.
- Nothing stops two proposals claiming the same file, and the model does it:
  the first real run on astrup put `lib/route-colors.ts` in both "Routes &
  Party Navigation" and "Theme & Color Management". The prompt asks for at
  most one group per file; when it is disobeyed both are shown and each is
  judged on its own, which is honest and reads oddly — and accepting both
  writes one file into two categories, which `groups.json` allows.
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
