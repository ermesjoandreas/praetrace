# Codemap — product vision and roadmap

This document describes where the product is going. `CLAUDE.md` describes what to
build right now. When the two disagree, `CLAUDE.md` wins — this file is the
destination, not the current sprint.

## The thesis

Agent-driven coding is faster than a human can track. A developer delegates a task,
the agent touches fourteen files, and the developer's mental model of their own
codebase quietly goes stale. Reading the diff afterwards does not restore it.

Codemap maintains that model continuously — and then does four things with it that
a static diagram cannot.

The insight that shapes everything below: **the graph is not the product.** The graph
is infrastructure. The product is what you do with a live, accurate structural model
of a codebase while an agent is actively changing it.

---

## Capability 1 — Architecture drift detection

**The problem.** An agent solves the task it was given. It does not hold the
architectural intent of the project. So it reaches across layers, imports the
database client into a UI component, or bypasses the service layer — because that
was the shortest path to a working solution. Each shortcut is individually
reasonable. Together they rot the codebase, and nobody notices until it is
expensive.

**What we build.** A rule file the developer owns, checked against the graph on
every change:

```yaml
rules:
  - forbid: { from: "ui/**", to: "db/**" }
    reason: "UI must go through the service layer"
  - forbid: { from: "domain/**", to: "node_modules/**" }
    reason: "Domain layer stays dependency-free"
  - require: { from: "api/**", through: "services/**", to: "db/**" }
```

Every rule is a query over edges in the graph. We already have the edges, so the
engine is small — the work is in the rule language and the reporting.

**Why it matters.** This is the only capability here that stops a bad thing from
happening rather than describing it. It turns the tool from a map into a guardrail.

**The strong version.** Because Claude Code exposes a `PreToolUse` hook that can
block a tool call outright (exit code 2), a violation does not have to be reported
after the fact — it can be refused before the edit lands, with the reason fed back
so the agent corrects course itself. Ship the reporting version first; blocking is
a setting the developer opts into once they trust the rules.

---

## Capability 2 — Session diff

**The problem.** The developer steps away, the agent works for twenty minutes, and
they come back to a forty-file git diff. Git shows *lines changed*. It does not show
*what happened to the architecture*.

**What we build.** A structural diff scoped to an agent session:

- New nodes highlighted, removed nodes shown as ghosts
- New edges emphasised — especially edges that cross module boundaries
- A short summary: "3 new modules, 1 new cross-layer dependency, 2 files removed"
- A timeline scrubber to replay how the structure evolved across the session

**Why it matters.** This is probably the most-used feature in daily practice. It is
also cheap to build: stable node IDs and incremental graph updates are already
required by the MVP, so the diff is a byproduct rather than new machinery.

---

## Capability 3 — Blast radius

**The problem.** Before changing something, you want to know what depends on it. The
agent usually does not check, and the developer cannot check fast enough to keep up.

**What we build.** For any node in the graph, a reverse-dependency view: what calls
this, what imports it, how far the impact propagates. Surfaced two ways:

1. **In the UI** — click any node, see its dependents highlighted.
2. **In the agent's context** — on `PreToolUse` for a file edit, inject a short
   note: "This module has 14 dependents across 6 modules." The agent gets to be
   careful because it was told to be, not because it guessed.

**Why it matters.** It is the difference between an agent editing confidently and an
agent editing blindly. Cheap to compute from a graph we already maintain.

---

## Capability 4 — The graph as an MCP server

**The problem — and the inversion.** Everything above treats the tool as something
that watches the agent. But we are building a precise structural model of a codebase
that the agent itself does not have. The agent navigates by grep and filename
guessing. We can just tell it.

**What we build.** Expose the graph as an MCP server the agent can query:

- `who_calls(symbol)` — every call site, with file and line
- `impact_of(symbol)` — the blast radius from capability 3, as structured data
- `find_by_role(description)` — "where does authentication live"
- `module_boundary(path)` — what this module exposes and what it depends on
- `check_rules(proposed_change)` — would this violate architecture rules

**Why it matters.** This is the capability that makes an AI-oriented developer stop
and pay attention. The tool is no longer an observer of the agent — it makes the
agent measurably better at navigating an unfamiliar codebase. Every other feature
here is about protecting the human's understanding. This one improves the machine's.

It also costs less than it sounds: the graph, the reverse-dependency index, and the
rule engine all already exist for capabilities 1–3. The MCP server is a thin
protocol layer over data we have.

---

## Distribution — a downloadable application

The end state is a real desktop application, not a `localhost` URL. This is a
deliberate positioning choice: a tool a developer downloads and installs reads as a
product, while a dev-server tab reads as a script someone wrote on a weekend.

**Tauri**, not Electron. The Rust shell is thin and mostly generated — the
application code stays TypeScript. Bundle size lands in single-digit megabytes
rather than the hundred-plus an Electron app carries, which matters for how
professional the download feels.

What the desktop shell buys us beyond packaging:

- **System tray presence** — the tool runs alongside an agent session without
  occupying a terminal or a browser tab
- **Native notifications** — an architecture violation is worth interrupting for
- **Auto-start with a project** — no manual command before the agent session
- **Deep links and file associations** — click a node, open the file in the editor
- **Signed installers** for macOS and Windows, so the download does not trip
  security warnings on first run

**Timing.** Packaging comes after the engine works, not before. Wrapping a
half-finished graph engine in a desktop shell adds friction to exactly the iteration
loop that still needs to move fast. The order is: engine → capabilities → shell.

---

## Sequencing

| Phase | What ships | Why this order |
|---|---|---|
| 0 — MVP | Live class/dependency graph, TypeScript only, browser UI | Everything else reads from this graph. Nothing is possible before it is correct. |
| 1 | Session diff (cap. 2) | Cheapest real feature; stable node IDs make it nearly free. Immediately useful daily. |
| 2 | Architecture drift detection, reporting mode (cap. 1) | The differentiating feature. Reporting first — trust before enforcement. |
| 3 | Blast radius (cap. 3) | Reverse-dependency index; also a prerequisite for the best MCP tools. |
| 4 | MCP server (cap. 4) | Thin layer over everything built in phases 1–3. |
| 5 | Drift detection, blocking mode | Only after the rule engine has proven it does not produce false positives. |
| 6 | Tauri packaging, signed installers | The engine is stable; now make it feel like a product. |

## What we are deliberately not doing

Kept here so the decision is not silently revisited later:

- **Multi-user, hosted, team dashboards.** A different product with auth,
  multi-tenancy, and hosting costs. Not until a real user asks.
- ~~**Language sprawl.** TypeScript until the tool is genuinely good for TypeScript.~~
  **Reversed on 2026-09-01, and Python joined on 2026-09-04.** The tool reads
  TypeScript, JavaScript, Java, Go, C#, Rust and Python, because the graph model
  was already language-neutral and the cost of a language turned out to be one
  file. Python is the one anybody here actually writes, and it was the last to
  arrive; a developer reading this list before it was here would not have tried
  their own repository at all. The concern behind this line — that six
  mediocre parsers beat no parser at all — is answered by a rule rather than by a
  ban: a language ships only when its edges are verified against a real repository.
  See "Many languages" in CLAUDE.md.
- **LLM-generated diagrams.** Still refused, and for the original reasons: too slow
  and too imprecise for a live view, and never the source of truth for structure.
  What changed on 2026-09-02 is that the LLM has a **second narrow role** beside the
  planned dataflow inference — *explaining what the graph already found*. The
  structure stays static analysis; the model says what a symbol is for, on request,
  once the boxes are already on screen. It is asked to read, never to draw and never
  to decide. See "Explaining what the graph found" in CLAUDE.md.
- **Persistence and history beyond the session.** Interesting, but it turns an
  in-memory tool into a database product. Revisit after phase 4.
