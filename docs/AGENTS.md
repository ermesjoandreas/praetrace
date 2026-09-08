# Telling codemaps who is writing

codemaps draws a project while an agent changes it. When a change lands, the map
can say **who wrote it** — but only when something told it. This is how to be
that something.

Everything here is a plain HTTP POST to a server on localhost. There is no
authentication, no SDK, and nothing to install.

---

## What codemaps can actually know

Three sources reach the graph, and they know three different amounts.

| Source | What it can say about who wrote a file |
|---|---|
| The Claude Code `PostToolUse` hook | Claude Code, which tool, which session, which subagent |
| A tool that posts to `/api/hook` itself | Whatever name it puts in the request |
| The file watcher | **Nothing at all** |

The third row is the one that matters. A file that changed on disk looks
identical whether Cursor, Gemini, Copilot, a build script, a `git checkout` or a
person in an editor wrote it. There is no timestamp, path or burst shape that
separates them, so codemaps does not try: a change nobody claimed is drawn as
**unattributed**, and it says so in those words.

That is a promise as much as a limitation. codemaps will never print a product's
name over a change that product did not claim. If you want your tool's name on
the map, it has to say so — which is the whole of what this document is for.

---

## The request

Find the port. A running codemaps writes it into the project it has open:

```
<project>/.claude/codemap.port      # e.g. "4400"
```

The file exists only while `.claude/` does and only while the server is running.
No file means no codemaps is watching this project, and there is nothing to
tell — which is not an error, and your tool should carry on silently.

Then, after each file you write:

```http
POST http://127.0.0.1:<port>/api/hook
Content-Type: application/json

{
  "agent": "Cursor",
  "tool_input": { "file_path": "/absolute/path/to/the/file/you/wrote.ts" }
}
```

Two fields, and that is the whole contract.

- **`tool_input.file_path`** — the file you just wrote, created or deleted.
  Absolute, or relative to the project root. codemaps works out which of the
  three it was by looking at whether the file is there.
- **`agent`** — what to call you on the map. Optional. Anything up to 40
  characters; it is trimmed, and it is shown as written. Leave it out and the
  change is accepted exactly as before and drawn as unattributed.

`tool_input` is nested because the endpoint's original and primary caller is
Claude Code's `PostToolUse` hook, which posts its own payload unchanged. One
shape, one door: a second accepted spelling would be a second thing to keep
true.

### What comes back

```json
{
  "accepted": true,
  "agent": "Cursor",
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "src/graph/store.ts is imported by 4 files — …"
  }
}
```

- **`accepted`** — whether the path named a source file inside the open project.
  `false` is ordinary: the file was outside the project, in an ignored
  directory, or of a type codemaps does not read. Nothing went wrong.
- **`agent`** — the name this change will be shown under. Absent means the
  change will be drawn as unattributed. Check this once when wiring your
  integration up; it is the only confirmation your name was read.
- **`hookSpecificOutput.additionalContext`** — what the graph knows about the
  file you just wrote: which files import it, and which of its symbols something
  outside it reaches, in one or two sentences. Present only when there is
  something worth saying. If your agent can take text back after a tool call,
  this is worth handing to it; if not, ignore the field.

### It never fails you

**The route answers `200` for every payload it can use and every payload it
cannot** — an empty body, the wrong shape, a path outside the project, a name
that is not a string. A tool that breaks an agent's edit because a visualiser
was not listening would be worse than no tool, so this one cannot.

Two failures are still possible and both are Fastify refusing before the route
is reached: a body over 1 MiB (`413`) and a missing or unrecognised
`Content-Type` (`415`). Send `content-type: application/json` and do not post
the file's contents.

Time it out at a second or two and ignore the result. Nothing here is worth
delaying a write for.

---

## A worked example

A hook, a shell wrapper, a few lines in your own tool — it does not matter.
This is the shape:

```bash
curl -sf -m 2 -X POST "http://127.0.0.1:$(cat "$PROJECT/.claude/codemap.port")/api/hook" \
  -H 'content-type: application/json' \
  -d "{\"agent\":\"my-tool\",\"tool_input\":{\"file_path\":\"$FILE\"}}"
```

---

## Why a name is believed

codemaps takes `agent` at its word, and records that it was a claim rather than
a fact.

The reasoning is that the alternative is incoherent. This endpoint already
believes the caller about *which file changed* — that is what makes it re-parse
a file and redraw a box. Anything able to do that can already put whatever it
likes on the map. A name is strictly less powerful, so refusing one for reasons
of trust while accepting a path would be protecting nothing.

The rule this project actually holds is not *distrust the caller*. It is **never
invent**. So:

- A name you send is recorded as `declared` — you said this about yourself.
- A payload that names nothing but carries Claude Code's own hook envelope
  (`hook_event_name` together with `session_id`) is recorded as `recognised`.
  That is evidence rather than a guess: it is a wire format Claude Code defines,
  arriving because Claude Code ran a command out of its own settings file. Both
  fields are required, because one alone is a shape another tool could reach by
  accident and the cost of being wrong is this tool printing the wrong name over
  somebody's work.
- Anything else is unattributed, and no amount of looking at the file, the
  clock or the shape of the burst will change that.

If you forward a Claude Code payload without being Claude Code, add your own
`agent` field. A declared name always wins over a recognised envelope, which is
exactly what that case needs.

---

## If you speak MCP

codemaps also ships an MCP server (`scripts/mcp.mjs`) that any agent can use to
query the graph. It reads the name from the `clientInfo` your client sends in
the `initialize` handshake and forwards it, so an agent's *questions* are
attributed with no extra work at all. There is nothing to send.

That covers what an agent asks. It does not cover what an agent writes — an MCP
server is called *by* an agent and cannot watch it work — which is why the POST
above exists.

---

## What the map does with it

A named change is drawn with the name. An unattributed one is drawn as changed,
and described as being of unknown origin.

The name is remembered per file, as of the last change that landed on it, and it
is dropped again the moment a change lands that nobody claimed — a hand edit to
a file your agent wrote is not your agent's. The one exception is about a second
wide, and it exists because a single edit reaches codemaps twice: your POST says
so, and the file watcher sees it independently a few tens of milliseconds
either side. Within that second the two are read as one edit rather than as
somebody taking the file over.
