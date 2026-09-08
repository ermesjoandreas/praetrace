#!/usr/bin/env node
// Codemap as tools an agent can call.
//
// The direction matters: MCP servers are called *by* an agent, never the other
// way round. The app cannot reach the agent already working in the project, so
// this is how that agent names groups — for free, unprompted, whenever it
// chooses to — along with the parts of the graph it has no other way to see.
// The app's own `claude -p` (src/project/suggest.ts) can only propose a name;
// a person accepts it, through the same write name_group makes.
//
// It speaks to a running codemap over HTTP rather than holding a graph of its
// own, and finds it through the same port file the Claude Code hook uses, since
// the OS assigns that port fresh on every launch.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

/**
 * Which project this speaks for.
 *
 * CLAUDE_PROJECT_DIR is not expanded inside .mcp.json's `args`, so the config
 * cannot pass it and the variable is only sometimes in the environment. Falling
 * back through the working directory and then this script's own repository means
 * the server works however it was started.
 */
function findProjectRoot() {
  // The checkout holding this script is deliberately NOT a candidate. It used
  // to be the third one, and it wins whenever the opened project has no port
  // file — which is the ordinary state of a project with no .claude/, because
  // the server refuses to create that directory uninvited. An agent working in
  // one project then got answers about codemap's own repository, with nothing
  // saying so. Answering about the wrong project is worse than not answering:
  // serverOrigin's error names the file it wanted and how to start it.
  const candidates = [process.env['CLAUDE_PROJECT_DIR'], process.cwd()].filter(
    (value) => typeof value === 'string' && value !== '',
  );

  // A directory that already has a port file is certainly the right one.
  return (
    candidates.find((candidate) => existsSync(path.join(candidate, '.claude', 'codemap.port'))) ??
    candidates[0]
  );
}

const projectRoot = findProjectRoot();

async function serverOrigin() {
  const portFile = path.join(projectRoot, '.claude', 'codemap.port');
  const raw = await readFile(portFile, 'utf8').catch(() => null);
  const port = Number(raw?.trim());

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(
      `codemap is not running for ${projectRoot} (no ${portFile}). Start it with \`npm run serve\` or open the app.`,
    );
  }
  return `http://127.0.0.1:${port}`;
}

/**
 * Which agent is on the other end of this stdio pipe, in its own words.
 *
 * MCP clients name themselves in the `initialize` handshake — Claude Code
 * sends `claude-code` — and that is the only thing this process can honestly
 * say about who is using it: it is a child of whichever agent launched it and
 * has no other way to find out. Undefined before the handshake, and undefined
 * for a client that sent no name, in which case codemap shows the call with no
 * agent rather than assuming one.
 */
function clientName() {
  const info = server.server.getClientVersion();
  return typeof info?.name === 'string' && info.name !== '' ? info.name : undefined;
}

/**
 * Every call carries which tool asked and what about, so codemap can show the
 * agent's questions beside its edits. Headers rather than a separate report:
 * one request, and nothing to keep in sync.
 *
 * The agent's name rides on every call, mark or no mark: `note_change`
 * deliberately sends no tool mark, and it is the one call where knowing who
 * spoke matters most.
 */
async function api(pathname, init, mark) {
  const agent = clientName();
  const response = await fetch(`${await serverOrigin()}${pathname}`, {
    ...init,
    headers: {
      ...init?.headers,
      ...(agent ? { 'x-codemap-agent': agent } : {}),
      ...(mark
        ? { 'x-codemap-tool': mark.tool, ...(mark.target ? { 'x-codemap-arg': mark.target } : {}) }
        : {}),
    },
  });
  if (!response.ok) {
    const body = await response.text();
    // The status rides on the error because "codemap has never heard of this"
    // and "codemap is unhappy" want different answers, and a caller that had
    // to read it out of the sentence would break the moment the sentence
    // changed. Every existing caller ignores it and gets what it always got.
    const failed = new Error(`codemap replied ${response.status}: ${body.slice(0, 200)}`);
    failed.status = response.status;
    throw failed;
  }
  return response.json();
}

/** Every tool answers in text; a thrown error becomes the text the agent sees. */
function reply(text) {
  return { content: [{ type: 'text', text }] };
}

/**
 * The file half of a node id — `path`, `path#Name`, `path#Class.member`.
 *
 * An id's separator is a `#`, and a path cannot contain one on any system
 * this runs on, so the head is the file. Used to say which two *files* an
 * edge crossed: an agent acts on files, and "which symbol pair" is a longer
 * answer to a question nobody asked.
 */
function fileOf(id) {
  const cut = id.indexOf('#');
  return cut === -1 ? id : id.slice(0, cut);
}

/**
 * At most `limit` lines, and a line saying how many were left out.
 *
 * Every list here is capped, and the count of what was dropped is the half
 * that matters: a truncated list nobody is told is truncated is read as the
 * whole answer, which is the failure this whole file is careful about.
 */
function capped(lines, limit, indent = '  ') {
  if (lines.length <= limit) return lines;
  return [...lines.slice(0, limit), `${indent}… and ${lines.length - limit} more`];
}

/** `Task.mark_done (method)`, or `mark_done (method)` when nothing owns it. */
function labelOf(entry) {
  const owned = entry.owner === undefined || entry.owner === null ? entry.name : `${entry.owner}.${entry.name}`;
  return `${owned} (${entry.kind})`;
}

async function run(work) {
  try {
    return reply(await work());
  } catch (error) {
    return { content: [{ type: 'text', text: String(error.message ?? error) }], isError: true };
  }
}

const server = new McpServer({ name: 'codemap', version: '0.1.0' });

server.registerTool(
  'list_groups',
  {
    title: 'List architectural groups',
    description:
      'Groups of files that depend on each other more than on anything else, found by clustering the import graph. Unnamed ones are waiting for a name. Membership is decided by the graph and must not be changed. A group marked "by hand" was drawn by a person, not found by the imports; one marked "stored, matches nothing" is a name in groups.json that no current group fits.',
    inputSchema: {},
  },
  () =>
    run(async () => {
      const { clusters, orphans = [] } = await api('/api/clusters', undefined, { tool: 'list_groups' });
      const live = clusters.filter((group) => group.state !== 'rejected');
      if (live.length === 0 && orphans.length === 0) return 'No groups found in this project.';

      const nameOf = new Map(clusters.map((group) => [group.id, group.name]));

      const blocks = live.map((group) => {
        const label = group.name ? `"${group.name}"` : 'UNNAMED';
        // A hand-drawn group describes no cluster, so it has no cohesion to
        // report. Printing "0% cohesion" told the agent the imports had found a
        // group with no coupling — the one promise the feature makes, broken
        // for the one consumer most likely to be misled by it.
        const how = group.origin === 'manual' ? 'by hand' : `${Math.round(group.cohesion * 100)}% cohesion`;
        const parentName = group.parent === null ? null : nameOf.get(group.parent);
        const inside =
          group.parent === null ? '' : `, inside ${parentName ? `"${parentName}"` : `the unnamed group ${group.parent}`}`;
        const indent = '  '.repeat(group.depth ?? 0);
        return [
          `${indent}${label} — ${group.files.length} files, ${how}${inside}`,
          ...group.files.map((f) => `${indent}  ${f}`),
        ].join('\n');
      });

      // Stored names the graph no longer finds a group for. Listed rather than
      // dropped: three committed groups were invisible everywhere, and a name
      // that vanishes without a word cannot be fixed or deleted.
      for (const orphan of orphans) {
        blocks.push(
          [
            `"${orphan.name}" — ${orphan.files.length} files, stored, matches nothing`,
            ...orphan.files.map((f) => `  ${f}`),
          ].join('\n'),
        );
      }

      return blocks.join('\n\n');
    }),
);

server.registerTool(
  'name_group',
  {
    title: 'Name an architectural group',
    // The same brief as buildPrompt in src/project/suggest.ts — change both, or
    // a name from one source stops reading like one from the other.
    description:
      'Give a group a short name describing what it is — two or three words, the kind a developer would use in conversation. Pass the exact file list from list_groups.',
    inputSchema: {
      files: z.array(z.string()).describe('The group members, exactly as list_groups returned them'),
      name: z.string().describe('A short name, for example "Parsing" or "HTTP surface"'),
    },
  },
  ({ files, name }) =>
    run(async () => {
      await api(
        '/api/clusters',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ files, name, state: 'accepted' }),
        },
        { tool: 'name_group', target: name },
      );
      return `Named ${files.length} files "${name}". It now shows as an accepted group in codemap.`;
    }),
);

server.registerTool(
  'describe_file',
  {
    title: 'Describe a file in the graph',
    description:
      'What a file declares, what it imports, and — the part grep cannot answer cheaply — which files import it. That last list is a floor and never a census: a file handed on by something that declares nothing of its own is depended on further away than its own imports say.',
    inputSchema: {
      path: z.string().describe('Path relative to the project root, for example src/graph/store.ts'),
    },
  },
  ({ path: target }) =>
    run(async () => {
      const detail = await api(`/api/detail?path=${encodeURIComponent(target)}`, undefined, {
        tool: 'describe_file',
        target,
      });
      if (detail.kind === 'folder') {
        return [`${detail.path} — ${detail.files.length} files`, ...detail.files.map((f) => `  ${f}`)].join('\n');
      }
      // "used by (5)" is the one line here an agent acts on without checking,
      // and it read as a census: a constructor change went out naming 5 of 26
      // files because of it. The heading says "at least" whichever way the
      // graph answers — there is no state in which the number is everything —
      // and the note under it says what the count is missing.
      // An alias is a second name for a body already listed — express writes
      // `res.set = res.header = function`. Both names are printed, because an
      // agent looking for `res.header` must find it, and only the bodies are
      // counted, because "24 symbols" over 22 functions is the inflated number
      // this round set out to remove.
      const bodies = detail.symbols.filter((s) => s.aliasOf === undefined).length;
      return [
        `${detail.path} — ${bodies} symbols, ${detail.lineCount} lines`,
        '',
        'declares:',
        ...detail.symbols.map(
          (s) => `  ${s.kind} ${s.name} (line ${s.line})${s.aliasOf === undefined ? '' : ` = ${s.aliasOf}`}`,
        ),
        '',
        `used by (at least ${detail.importedBy.length}):`,
        ...detail.importedBy.map((f) => `  ${f}`),
        // A server still running the build it booted with sends no note. The
        // heading is the half that must not depend on which build answered.
        ...(detail.importedByNote ? [`  — ${detail.importedByNote}`] : []),
        '',
        `uses (${detail.imports.length}):`,
        ...detail.imports.map((f) => `  ${f}`),
      ].join('\n');
    }),
);

server.registerTool(
  'search_symbols',
  {
    title: 'Find a file or symbol',
    description:
      'Subsequence search over every file path and symbol name in the project, the way an editor quick-open works.',
    inputSchema: { query: z.string().describe('Part of a file or symbol name') },
  },
  ({ query }) =>
    run(async () => {
      const { hits } = await api(`/api/search?q=${encodeURIComponent(query)}`, undefined, {
        tool: 'search_symbols',
        target: query,
      });
      if (hits.length === 0) return `Nothing matches "${query}".`;
      return hits.map((hit) => `${hit.kind} ${hit.name} — ${hit.path}:${hit.line}`).join('\n');
    }),
);

/**
 * What a structural diff cannot see, said every time rather than when it
 * bites. `diffGraphs` compares declarations and resolved references, so a
 * rewritten function body with the same signature and the same calls is not
 * a change here — and an agent that read this list as "everything I did"
 * would skip the file it spent the afternoon in.
 */
const SHAPE_ONLY =
  'Not shown: an edit that moves no declaration and changes no reference codemap resolved reads as unchanged here. ' +
  'This is the shape; `git diff` is the tool for the text.';

server.registerTool(
  'describe_changes',
  {
    title: 'What changed in the shape',
    description:
      'Which files, symbols and edges have appeared or vanished since a commit — a class that gained three methods, an import that started crossing between two directories. The shape, not the text: run `git diff` for the lines. Compares against the working tree as it stands now, so it answers "what have I done to the structure".',
    inputSchema: {
      since: z
        .string()
        .optional()
        .describe(
          'A commit id, abbreviated or full. Omit for the base codemap is already comparing against — HEAD, HEAD~1 or the merge base, whichever the user has set.',
        ),
    },
  },
  ({ since }) =>
    run(async () => {
      const asked = since === undefined ? '' : since.trim();
      // `to=live` is spelled out rather than left to the default, because
      // this tool only ever answers about now: an agent asking what it
      // changed means the working tree, and a second end would be a
      // code-archaeology question with no caller.
      const diff = await api(`/api/diff?from=${encodeURIComponent(asked)}&to=live`, undefined, {
        tool: 'describe_changes',
        target: asked === '' ? 'base' : asked,
      });

      const head = `${diff.from.asked}${diff.from.sha === null ? '' : ` (${diff.from.sha.slice(0, 8)})`} → the working tree`;
      const { files, symbols, edges } = diff.counts;
      if (files.added + files.removed + files.touched + symbols.added + symbols.removed + edges.added + edges.removed === 0) {
        return `${head}\n\nNothing in the shape changed.\n\n${SHAPE_ONLY}`;
      }

      // One bucket per file, so a reader sees "this file gained a method"
      // rather than 43 rows of symbols they have to group themselves.
      const buckets = new Map();
      const bucketFor = (filePath) => {
        const found = buckets.get(filePath) ?? { state: 'changed', added: [], removed: [] };
        buckets.set(filePath, found);
        return found;
      };
      for (const node of diff.added) {
        if (node.kind === 'file') bucketFor(node.file).state = 'new';
        else bucketFor(node.file).added.push(node);
      }
      for (const node of diff.removed) {
        if (node.kind === 'file') bucketFor(node.file).state = 'gone';
        else bucketFor(node.file).removed.push(node);
      }
      for (const node of diff.touched) bucketFor(node.file);

      const lines = [head, ''];
      lines.push(
        `files: +${files.added} −${files.removed}, ${files.touched} changed inside`,
        `symbols: +${symbols.added} −${symbols.removed}`,
        `edges: +${edges.added} −${edges.removed}${byKind(diff.addedEdges, diff.removedEdges)}`,
      );

      // A whole new file's symbols are the file's contents, and listing them
      // is asking the agent to read a file listing instead of the file. What
      // it cannot get anywhere else is which symbols moved in a file that
      // already existed, so that is the half that is spelled out.
      const wholeFiles = [...buckets]
        .filter(([, bucket]) => bucket.state !== 'changed')
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([filePath, bucket]) => {
          const isNew = bucket.state === 'new';
          const count = isNew ? bucket.added.length : bucket.removed.length;
          return `  ${isNew ? '+' : '−'} ${filePath} — ${isNew ? 'new file' : 'file gone'}, ${count} symbols`;
        });
      if (wholeFiles.length > 0) lines.push('', 'files added or gone', ...capped(wholeFiles, 25));

      const declared = [...buckets]
        .filter(([, bucket]) => bucket.state === 'changed' && bucket.added.length + bucket.removed.length > 0)
        .sort(([a], [b]) => a.localeCompare(b));
      if (declared.length > 0) {
        // Capped by file, then by symbol inside it. "… and 12 more" has to
        // mean twelve more files, or a reader counts a dropped symbol row as
        // a dropped file and goes looking for the wrong thing.
        const shown = declared.slice(0, 20).flatMap(([filePath, bucket]) => [
          `  ${filePath}`,
          ...capped(
            [
              ...bucket.added.map((node) => `    + ${labelOf(node)}`),
              ...bucket.removed.map((node) => `    − ${labelOf(node)}`),
            ],
            10,
            '    ',
          ),
        ]);
        lines.push(
          '',
          'symbols moved in a file that stayed',
          ...shown,
          ...(declared.length > 20 ? [`  … and ${declared.length - 20} more files`] : []),
        );
      }

      // A file listed as touched by an edge alone gained or lost a reference
      // and no declaration. Naming it is the point — it is the change git's
      // line count hides best.
      const onlyEdges = [...buckets]
        .filter(([, bucket]) => bucket.state === 'changed' && bucket.added.length + bucket.removed.length === 0)
        .map(([filePath]) => `  ${filePath}`);
      if (onlyEdges.length > 0) {
        lines.push('', 'files whose references moved, declaring nothing new', ...capped(onlyEdges.sort(), 20));
      }

      for (const [heading, list] of [
        ['coupling added', diff.addedEdges],
        ['coupling removed', diff.removedEdges],
      ]) {
        const { pairs, inside } = coupling(list);
        if (pairs.length === 0 && inside === 0) continue;
        lines.push('', heading, ...capped(pairs, 15));
        // "more" would be a lie when nothing was listed above it, and that
        // is the common case for a change entirely inside one file.
        if (inside > 0) lines.push(`  (${inside} not listed: between symbols inside one file)`);
      }

      lines.push('', SHAPE_ONLY, diff.caveat);
      return lines.join('\n');
    }),
);

/** ` (imports +8, calls +16, imports −1)` — only the kinds that actually moved. */
function byKind(added, removed) {
  const parts = [];
  for (const [list, sign] of [
    [added, '+'],
    [removed, '−'],
  ]) {
    const counted = new Map();
    for (const edge of list) counted.set(edge.kind, (counted.get(edge.kind) ?? 0) + 1);
    for (const [kind, n] of counted) parts.push(`${kind} ${sign}${n}`);
  }
  return parts.length === 0 ? '' : ` (${parts.join(', ')})`;
}

/**
 * Edges folded onto the file pairs they cross, because that is the answer to
 * "what is coupled to what now that was not before". Edges inside one file
 * are counted rather than listed: a call between two symbols of the same file
 * is not coupling, and on a real change there are far more of them than of
 * the lines worth reading.
 */
function coupling(edges) {
  const pairs = new Map();
  let inside = 0;
  for (const edge of edges) {
    const from = fileOf(edge.from);
    const to = fileOf(edge.to);
    if (from === to) {
      inside += 1;
      continue;
    }
    const key = `${from} → ${to}`;
    const kinds = pairs.get(key) ?? new Map();
    kinds.set(edge.kind, (kinds.get(edge.kind) ?? 0) + 1);
    pairs.set(key, kinds);
  }
  return {
    inside,
    pairs: [...pairs].map(
      ([pair, kinds]) =>
        `  ${pair}  ${[...kinds].map(([kind, n]) => (n === 1 ? kind : `${kind} ×${n}`)).join(', ')}`,
    ),
  };
}

server.registerTool(
  'list_dependents',
  {
    title: 'What depends on this',
    description:
      'What leans on a file or a symbol, to be asked before changing it: the files that import a file, and the symbols that call, extend, implement or name a symbol. The answer is always a floor and never a census — codemap says in its own words what it could not see, and for a method an empty list means unknown rather than none.',
    inputSchema: {
      target: z
        .string()
        .describe(
          'A file path (src/graph/store.ts), or a symbol as path#Name — path#Class.member for a method or field. path#name alone is resolved if the file declares exactly one thing by that name.',
        ),
    },
  },
  ({ target }) =>
    run(async () => {
      const asked = target.trim();
      const mark = { tool: 'list_dependents', target: asked };

      if (!asked.includes('#')) {
        const detail = await api(`/api/detail?path=${encodeURIComponent(asked)}`, undefined, mark);
        const what =
          detail.kind === 'folder'
            ? `${detail.path} — directory, ${detail.files.length} files`
            : `${detail.path} — file, ${detail.lineCount} lines, ${detail.symbols.length} symbols`;
        return [
          what,
          '',
          `imported by at least ${detail.importedBy.length} ${detail.importedBy.length === 1 ? 'file' : 'files'}:`,
          ...(detail.importedBy.length === 0 ? ['  (nothing)'] : capped(detail.importedBy.map((f) => `  ${f}`), 40)),
          '',
          `How the graph looked — ${detail.importedByCoverage}: ${detail.importedByNote}`,
        ].join('\n');
      }

      const links = await symbolLinks(asked, mark);
      const byFile = new Map();
      for (const relation of links.usedBy) {
        const found = byFile.get(relation.filePath) ?? [];
        found.push(`    ${relation.phrase}  ${relation.name} (${relation.kind}, line ${relation.line})`);
        byFile.set(relation.filePath, found);
      }
      // Grouped by file, and capped by file: an agent acts on files, and the
      // count it is told was dropped has to be in the same currency.
      const files = [...byFile];
      const grouped = files
        .slice(0, 30)
        .flatMap(([filePath, rows]) => [`  ${filePath}`, ...capped(rows, 8, '    ')]);

      return [
        `${links.id} — ${links.kind} ${links.name}`,
        '',
        links.usedBy.length === 0
          ? 'Nothing in the graph reaches it.'
          : `reached by at least ${links.usedBy.length}, in ${files.length} ${files.length === 1 ? 'file' : 'files'}:`,
        ...grouped,
        ...(files.length > 30 ? [`  … and ${files.length - 30} more files`] : []),
        '',
        `How the graph looked — ${links.coverage}: ${links.coverageNote}`,
      ].join('\n');
    }),
);

/**
 * One symbol's relations, given an id an agent wrote by hand.
 *
 * Nothing else codemap offers hands out a member's id: `search_symbols` and
 * `describe_file` both print a member's bare name, and the id it lives under
 * is `path#Owner.name`. So an agent asking about a method it just found will
 * write `path#name` and get "nothing known about" — a dead end produced
 * entirely by our own spelling. One extra request on that path turns it into
 * an answer, and when the name is ambiguous or absent the refusal lists the
 * ids the file actually declares, which is the one thing that lets the agent
 * ask again and be right.
 *
 * The retry sends no mark: it is the same question, and a second row in the
 * timeline would read as the agent asking twice.
 */
async function symbolLinks(asked, mark) {
  try {
    return await api(`/api/symbol?id=${encodeURIComponent(asked)}`, undefined, mark);
  } catch (error) {
    if (error.status !== 404) throw error;
    return api(`/api/symbol?id=${encodeURIComponent(await resolveMember(asked))}`);
  }
}

/** `path#name` -> the id the graph holds it under, or a refusal naming what the file does hold. */
async function resolveMember(asked) {
  const filePath = fileOf(asked);
  const name = asked.slice(filePath.length + 1);
  const box = await focusBox(filePath);
  if (box === null) throw new Error(`codemap has no file "${filePath}", so it has no "${asked}".`);

  const members = box.members ?? [];
  const matches = members.filter((member) => member.name === name);
  if (matches.length === 1) return matches[0].id;
  if (matches.length > 1) {
    throw new Error(
      `${filePath} declares "${name}" ${matches.length} times. Ask for one: ${matches.map((m) => m.id).join(', ')}`,
    );
  }
  throw new Error(
    `${filePath} declares no "${name}". It declares: ${capped(members.map((m) => m.id), 40, '').join(', ')}`,
  );
}

/**
 * The box codemap draws for one file, with every symbol's real id on it.
 *
 * `/api/view?focus=` is the only endpoint that carries both — the members
 * with their ids and owners, and the counts of what the file named and the
 * graph could not follow. depth=1 because 1 is the smallest the route
 * accepts; the neighbours it also returns are thrown away here. Null when
 * the graph has no such file, which is the honest answer for a path that
 * does not exist and for one whose extension no language claims alike.
 */
async function focusBox(filePath, mark) {
  const asked = `/api/view?focus=${encodeURIComponent(filePath)}&depth=1`;
  const answer = await api(asked, undefined, mark).catch((error) => {
    if (error.status === 404) return null;
    throw error;
  });
  if (answer === null) return null;
  const box = answer.view.nodes.find((node) => node.id === filePath);
  // The route refuses a focus that is not a file, and a focused file is
  // always drawn as itself, so this is unreachable today. It is still a
  // `null` rather than a spread of nothing: a box built out of missing
  // fields would report "syntax error: yes" about a file nobody read.
  return box === undefined ? null : { ...box, view: answer.view };
}

server.registerTool(
  'describe_blind_spots',
  {
    title: 'What codemap could not follow in a file',
    description:
      'Where this tool\'s map of one file stops: imports naming a module the scan never saw, calls naming something no declaration in reach answers to, and whether the parse hit a syntax error. None of it is drawn, because a line to nothing is not a line — so a box with few edges is either code with little coupling or coupling codemap lost, and this is the only way to tell those apart. Worth asking before you trust an empty answer from list_dependents.',
    inputSchema: {
      path: z.string().describe('Path relative to the project root, for example src/graph/store.ts'),
    },
  },
  ({ path: target }) =>
    run(async () => {
      const asked = target.trim();
      const box = await focusBox(asked, { tool: 'describe_blind_spots', target: asked });
      if (box === null) {
        return (
          `codemap has no box for "${asked}". Either nothing is at that path, or its extension belongs to no ` +
          'language codemap reads — and in that case nothing the file declares is in the graph at all, which is ' +
          'the largest blind spot there is. search_symbols will find it if the path is only spelled differently.'
        );
      }

      const { view } = box;
      const language = view.languages.find((entry) => entry.id === box.language);
      const lost = box.unresolved ?? { imports: 0, calls: 0 };
      const clean = lost.imports === 0 && lost.calls === 0 && box.parseError === false;

      return [
        `${asked} — read as ${language === undefined ? (box.language ?? 'an unknown language') : language.label}, ${(box.members ?? []).length} symbols.`,
        '',
        // Clean is the common answer, and it earns one line. The paragraph
        // below explains a number this file has not got, and printing it
        // anyway is how a tool teaches an agent to stop reading it.
        ...(clean
          ? ['Every name this file writes, codemap followed, and the parse hit no syntax error.']
          : [
              `imports that went nowhere: ${lost.imports}`,
              `calls that went nowhere: ${lost.calls}`,
              `syntax error in the parse: ${box.parseError ? 'yes — symbols inside the broken region are missing' : 'no'}`,
              '',
              // The number is only what the project could plausibly hold — a
              // built-in or a package it does not contain resolved to nothing
              // too, and nothing is missing there. Saying so is what keeps
              // the count from reading as "codemap is broken" on a file that
              // imports react.
              'A reference that went nowhere is counted and never drawn: there is no node to draw a line to, and ' +
                'codemap does not keep which name it was. Only what this project could plausibly hold is counted — ' +
                'a package it does not contain, and a language built-in, resolved to nothing too and nothing is ' +
                'missing there. So this is coupling codemap lost, and every list of dependents for this file, or ' +
                'for a symbol in it, is a floor.',
            ]),
        '',
        `Whole project: ${view.unresolved.imports} imports and ${view.unresolved.calls} calls went nowhere across ` +
          `${view.fileCount} files, and ${view.parseErrors} files have a syntax error.`,
      ].join('\n');
    }),
);

server.registerTool(
  'note_change',
  {
    title: 'Say what you just changed, and why',
    description:
      'Leave a one-line note beside the edits you just made. codemap draws what changed; only you know why, and the note appears in the timeline next to the file changes it explains. Write it in your own words, at most 200 characters. Nothing reads it back to you — it is for the person watching.',
    inputSchema: {
      files: z
        .array(z.string())
        .describe('The files the note is about, relative to the project root'),
      note: z.string().describe('One line: what changed and why'),
    },
  },
  ({ files, note }) =>
    run(async () => {
      // The only tool that does not mark its request. The mark is two headers,
      // and a sentence with an agent's punctuation in it does not belong in
      // one — so /api/note records the call itself, and marking here as well
      // would put the same note in the timeline twice.
      const { clipped } = await api('/api/note', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ files, note }),
      });
      const where = files.length === 1 ? files[0] : `${files.length} files`;
      return clipped
        ? `Noted against ${where}, clipped to 200 characters.`
        : `Noted against ${where}.`;
    }),
);

await server.connect(new StdioServerTransport());
