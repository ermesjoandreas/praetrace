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

**The direction changed on 2026-09-01.** The tool reads TypeScript, JavaScript,
Java, Go, C#, Rust and Python. Anyone can point it at their repository. VISION.md's
"language sprawl" line is overridden by this section, and its reasoning — a
mediocre parser for seven languages is worse than an excellent one for a single
language — is answered by the rule below rather than dismissed.

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
for the try's `return` was a path no run takes. ER diagrams are out of
scope. A package diagram is the root diagram, `?scope=&as=diagram`, and exists;
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
npm run codemap -- <dir>          # the same graph as text
npm run codemap -- <dir> --json   # raw nodes + edges
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
    hook.ts       a Claude Code PostToolUse payload -> the same FileChange
    hook-install.ts  detect, preview and merge the hook into settings.json
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
    session.ts    one project: store, pool (exposed, for the flow), watcher,
                  updater, git, an LRU of 16 past commits' graphs (graphAt —
                  hand it a sha, never a ref name: its `spelled` cache pins a
                  spelling to the sha it resolved to first, right for a sha
                  and wrong for HEAD), the stored group names (groups,
                  refreshGroups, clustersOf — held in memory like coverage,
                  re-read by the view route for a component diagram or a
                  category scope and by the two routes that write
                  groups.json), and the last suggest run. Swapped whole
    app.ts        Fastify: static web build, and the API below; `optionalKeys`
                  reads `as`, `category` and `diff` for both wire formats
    flow.ts       GET /api/flow, registered from app.ts; asks the session for
                  root, store and pool
    diff.ts       GET /api/diff, and resolveDiffEnds — the one place `base`
                  and a commit become two graphs, shared with the view route
    overview.ts   GET /api/overview, live only
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
  src/Sidebar.tsx the right side bar: Following (with its readings) and Detail
  src/Categories.tsx   the left bar's third section, a tree: one folded row per
                       group with its count and cohesion or "by hand", the files
                       under it once unfolded, the editor (name, colour, members,
                       delete), the create-from-selection form, and the model's
                       suggested name on the group's own row with accept / dismiss
  src/Repository.tsx   the left bar's first section: project, remote, the Claude
                       Code hook and MCP, and the buttons that act on them
  src/SourceControl.tsx  Changes (the per-file list, the base picker) and Graph
  src/GitGraph.tsx     the commit graph: lane numbers into pixels, refs, ages
  src/Activity.tsx     what the agent is doing, and where — describes now, always
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
  src/AgentStatus.tsx  what the agent is doing, and how long ago
  src/layout.ts   dagre for a view's first layout, keepLayout for every save after;
                  componentHeight, and layoutFlow / flowBoxSize for the flow
                  (tested in flow.test.ts)
  src/api.ts      fetch + the shared types, imported from src/ — and one value,
                  flow.ts's language table, which bundles because it reads a
                  tree and nothing else
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
                        `diff=`), 404 for an unknown commit or no git. The
                        view carries `presentation`: list or diagram
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
POST /api/hook          the PostToolUse payload. Always 200, and answers with
                        what the file just written is coupled to, as
                        `hookSpecificOutput.additionalContext`
POST /api/note          the agent's own words about what it just changed
GET  /api/coverage      what the test suite executed, or { coverage: null }
     /live              the websocket. Besides views it carries `agent`,
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
limitations.

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
  bring back a layout key that re-runs dagre when the box set changes. The
  component diagram keeps the same rule: a named box is keyed on `storedId` and
  stays put; an unnamed one is keyed on the cluster id, which embeds the member
  count and shifts when membership drifts, exactly as a frame does.
- **Dragging a frame locks it**, the way pulling a corner does; the lock button only
  releases. A frame that had to be locked before it could be moved was the wrong
  order, and it was reported as such.
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
