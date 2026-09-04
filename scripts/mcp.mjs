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
import { fileURLToPath } from 'node:url';
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
  const candidates = [
    process.env['CLAUDE_PROJECT_DIR'],
    process.cwd(),
    // scripts/mcp.mjs -> the repository holding it.
    path.dirname(path.dirname(fileURLToPath(import.meta.url))),
  ].filter((value) => typeof value === 'string' && value !== '');

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
 * Every call carries which tool asked and what about, so codemap can show the
 * agent's questions beside its edits. Headers rather than a separate report:
 * one request, and nothing to keep in sync.
 */
async function api(pathname, init, mark) {
  const response = await fetch(`${await serverOrigin()}${pathname}`, {
    ...init,
    headers: {
      ...init?.headers,
      ...(mark
        ? { 'x-codemap-tool': mark.tool, ...(mark.target ? { 'x-codemap-arg': mark.target } : {}) }
        : {}),
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`codemap replied ${response.status}: ${body.slice(0, 200)}`);
  }
  return response.json();
}

/** Every tool answers in text; a thrown error becomes the text the agent sees. */
function reply(text) {
  return { content: [{ type: 'text', text }] };
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
