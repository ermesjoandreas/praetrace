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
that rewrite later.

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

