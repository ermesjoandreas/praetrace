# codemaps

**codemaps draws the structure of a repository live, while an AI coding agent edits
it.** Nothing in the graph comes from a model — the boxes and the lines are read out
of syntax trees, every edge records how it knows, and a reference that resolved to
nothing is counted rather than quietly dropped.

It runs on your machine. No account, no cloud, no telemetry: a local server on
`127.0.0.1`, a page in front of it, and a file watcher.

Screenshots and the longer pitch: **[praetrace-site.vercel.app](https://praetrace-site.vercel.app)**

---

## What you see

- **A front page, not a hairball.** `/` is a list: what the project is, where it
  starts, what it is made of, what changed, what the agent is doing. A scope past 30
  boxes stays a list. A map of everything never works — the diagram is somewhere you
  go, not somewhere you land.
- **One symbol and its neighbours.** The diagram you go to is a focus view: a file,
  what reaches it and what it reaches, one hop out by default.
- **What the agent changed in the *shape*.** A structural diff between two graphs —
  what came, what went, what moved, with a deleted file drawn as a ghost. Git shows
  lines; this shows architecture.
- **UML as far as the source states it.** Class boxes with the visibility and
  `static` the code actually wrote, associations carrying role names and
  multiplicity, an ownership diamond only where the source says who owns the part.
- **The repository's own history.** The commit graph, and the whole diagram frozen at
  any commit.

## What you need

- **macOS on Apple silicon** (M1 or later) for the app. There is no Intel build and
  no Windows or Linux build. An Intel Mac cannot run the `.dmg` — the sidecar inside
  it is an `arm64` binary.
- **Node 20.19 or newer** if you run it from source instead — that is the floor the
  dependencies declare; what is actually measured is Node 24.11.1. The server is plain
  Node and nothing in it is macOS-specific, but it has only ever been run on macOS.
  Treat other platforms as untested rather than as supported.
- **Git** is optional. Without it you lose the change list, the commit graph and the
  structural diff; the map itself works fine.

## Run it, two ways

### The app

Download the `.dmg` from the [latest release](https://github.com/ermesjoandreas/praetrace/releases),
open it, and drag codemaps to Applications.

**This build is not signed or notarised.** A file you downloaded carries macOS's
quarantine flag, so the first launch is refused — often with "the application is
damaged", which it is not. Clear the flag once:

```bash
xattr -dr com.apple.quarantine /Applications/codemaps.app
```

That is the honest state of things today, not a step we like. A Developer ID
signature is what removes it, and this build does not have one.

The app opens a native folder picker, starts its own server on a port the OS
assigns, and draws the project.

### From source

This is the whole tool too — the app is the same server in a window.

```bash
git clone https://github.com/ermesjoandreas/praetrace
cd praetrace
npm install
npm run build

npm run serve -- ~/your-project        # http://127.0.0.1:4400, and it watches
```

`npm run serve` loads `dist/`, so after changing the source, build again — a server
left running from an earlier session will happily keep serving the old code.

The same graph as text, with no browser involved:

```
$ npm run codemap -- ~/scratch

codemap  /Users/you/scratch
2 files · 7 nodes · 10 edges · 47 ms

nodes  file 2 · class 2 · method 2 · field 1
edges  contains 5 · calls 3 · imports 1 · associates 1

edges
  associates src/store.ts#Store -> src/logger.ts#Logger
  calls      src/store.ts#Store.save -> src/logger.ts#Logger.write
  imports    src/store.ts -> src/logger.ts
```

`npm run codemap -- <dir> --json` prints the raw nodes and edges.

## Point it at your agent

The watcher alone is enough to keep the map current. Connecting Claude Code buys two
more things:

- **The hook.** codemaps hears about an edit the moment the agent makes it, and
  answers with what the file just written is coupled to — importers, and the symbols
  actually reached from outside. The Repository panel in the left bar has an
  **Install hook** button that merges it into the project's `.claude/settings.json`.
- **MCP.** `scripts/mcp.mjs` lets the agent query the graph: `describe_file`,
  `search_symbols`, `list_groups`, `name_group`, `note_change`. Put an `.mcp.json` in
  your project pointing at it by absolute path — `node /path/to/praetrace/scripts/mcp.mjs`.
  It holds no graph of its own; it finds the running codemaps through the port file
  the server leaves in your project's `.claude/`, so codemaps has to be running.

Two features spend money, and only when pressed: **Explain** (a reading of what one
symbol is for) and the **suggest names** lightbulb. Both shell out to `claude -p`,
both show what the run cost, and neither ever writes to the graph.

## What it reads

Twelve languages across 25 extensions, detected from the file extension — you are
never asked to declare one, because real repositories are mixed:

TypeScript · JavaScript · Java · Go · C# · Rust · Python · Kotlin · PHP · C/C++ ·
Vue · Svelte — plus Razor, which is a view rather than a language and is read by a
line scanner.

A language ships only once its edges have been checked against a real repository.
Parsing is the easy half; deciding which file a reference actually lands in is the
half that decides whether the picture is true. The status bar says plainly when a
project contains files no reader claims.

## What it does not do

The tool's whole claim is that the picture does not lie, so the gaps are stated
rather than hidden. These are the ones you will meet first:

- **A call through a receiver whose type is not written down is not an edge.** The
  "used by" list of a method is a floor, never a ceiling — an empty one means
  *unknown*, not *nothing*. The panel says so on every method and field.
- **A member a class inherits is not found.** A call to a method declared on a base
  class reaches nothing; only the owner's own declarations are looked at.
- **Enums are not parsed.** Not warned about — simply absent.
- **A types-only library draws as unconnected boxes.** `.d.ts` is skipped because it
  restates what the source declares, which is right for an application and wrong for
  a package of pure types.
- **The language boundary is invisible.** A Python backend and a TypeScript front end
  in one repository draw as two correct islands — no import crosses, the coupling is
  HTTP — and nothing on screen separates that from a parse that stopped.
- **The project's manifests are read once, at boot.** An entry point added after you
  opened the project shows as "nothing imports it" until you reopen it.
- **An explanation can be confidently wrong, and nothing checks it.** Explain is a
  model reading one symbol's source; it guesses about *when* code runs. It never
  feeds the graph, and it is one click from being forgotten.
- **Two symbols with the same name in one file** are told apart by document order, so
  swapping them looks like a change to both.

Not built, and deliberately not drifted into: architecture rules that fail a build,
blast-radius analysis, and any hosted or multi-user version.

The full list, with the measurements behind each one, is in
[CLAUDE.md](CLAUDE.md#known-limitations); the reasoning is in
[DECISIONS.md](DECISIONS.md).

## Building the app yourself

```bash
node scripts/prepare-sidecar.mjs   # once: builds the Node sidecar binary
CI=true npm run tauri build        # .app + .dmg under src-tauri/target/release/bundle/
```

**`CI=true` is not optional.** Without it the build dies at the last step in
`bundle_dmg.sh`, which drives Finder through AppleScript, and a failed build leaves a
mounted `rw.*.dmg` that blocks the next attempt — `hdiutil detach` it before retrying.

## Licence

MIT. See [LICENSE](LICENSE).

---

codemaps is made by [Praetrace](https://praetrace-site.vercel.app).
