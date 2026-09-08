import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Writing `.mcp.json` for the user, instead of asking them to know a path.
 *
 * Both channels between codemap and an agent are built and neither is
 * discoverable. The hook has had a button since the Repository panel existed;
 * MCP had only a status row, so a project whose `.claude/settings.json` was
 * installed and working still gave the agent no tools at all — one missing file,
 * and nothing on screen said which. This is the other button.
 *
 * It detects, previews and merges exactly as `hook-install.ts` does, for the
 * same reason: a project may already run MCP servers that have nothing to do
 * with us, and losing them would be a far worse bug than not installing.
 *
 * The one thing it cannot fix and therefore says out loud: Claude Code reads
 * `.mcp.json` when a session starts. Writing it mid-session changes nothing
 * until the agent is restarted once.
 */

/**
 * The key in `mcpServers`, and it is `codemap` rather than the package's
 * `codemaps`, because it is the prefix the agent already sees on every tool
 * (`mcp__codemap__list_groups`). Renaming it would orphan the entry this
 * repository has committed and give the same five tools a second set of names.
 */
const SERVER_NAME = 'codemap';

interface McpServerEntry {
  command?: string;
  args?: string[];
  [key: string]: unknown;
}

interface McpConfig {
  mcpServers?: Record<string, McpServerEntry | undefined>;
  [key: string]: unknown;
}

export interface McpStatus {
  configPath: string;
  /** An entry named `codemap` whose script is really on disk. */
  installed: boolean;
  /** True when a config file exists and could not be parsed. */
  unreadable: boolean;
  /** The other servers in the file, by name. Every one of them survives a write. */
  others: string[];
  /**
   * The script the entry would name, written the way it would be written —
   * relative when it is inside this project, absolute otherwise. Null when
   * there is nothing to point at, and then `reason` says where we looked.
   */
  script: string | null;
  /** Why `script` is null. Null when there is a script. */
  reason: string | null;
  /**
   * Exactly what would be written, so nothing is a surprise — and null whenever
   * nothing would be, which is both refusals. A preview shown over a config we
   * could not parse would be a merge into `{}`: it would show the file with
   * only codemap in it, which is the one thing this must never do.
   */
  preview: string | null;
}

/**
 * Where `scripts/mcp.mjs` sits relative to this module once compiled:
 * `dist/project/mcp-install.js` -> `dist/` -> the install root.
 *
 * Exported and pure so the arithmetic is a test rather than a guess, and taken
 * from this module's own location rather than from `process.cwd()`, which is
 * the project being looked at and not the tool looking at it.
 */
export function scriptFrom(moduleDir: string): string {
  return path.join(moduleDir, '..', '..', 'scripts', 'mcp.mjs');
}

/** The one place there is to look. Named in the refusal, so it is fixable. */
const SEARCHED = scriptFrom(path.dirname(fileURLToPath(import.meta.url)));

/**
 * The MCP script, or null with the reason.
 *
 * Two ways codemap runs, and only one of them can write this file. From a
 * checkout — `npm run serve`, `npm run tauri dev` — `scripts/mcp.mjs` is beside
 * `dist/` and its `@modelcontextprotocol/sdk` is in the checkout's
 * `node_modules`. The packaged `.app` ships `dist/` and the runtime
 * dependencies only (`scripts/prepare-resources.mjs`), so neither the script nor
 * the SDK is there and any path written would name a file that does not exist.
 * A wrong path is worse than no button: the agent's session would fail to start
 * a server it was told codemap had installed.
 */
function findScript(): { script: string | null; reason: string | null } {
  if (existsSync(SEARCHED)) return { script: SEARCHED, reason: null };
  return {
    script: null,
    reason:
      `scripts/mcp.mjs is not beside this build — looked in ${SEARCHED}. ` +
      'The packaged app ships dist/ without it, so .mcp.json can only be written ' +
      'by a codemap running from a checkout.',
  };
}

/**
 * How the script is spelled in the file.
 *
 * Absolute for any other project, because there is no relation between the two
 * directories to write down. Relative when the script is inside the project
 * being opened — codemap on itself — so the committed `.mcp.json` stays the
 * portable one it already is instead of being rewritten to this machine's path.
 *
 * Both sides are real paths in practice — `main.ts` resolves the root and node
 * resolves `import.meta.url` — and when they are not, `..` climbing out of the
 * project is refused and the absolute path is written instead. Longer than it
 * needed to be, never wrong.
 */
export function argFor(root: string, script: string): string {
  const inside = path.relative(root, script);
  return inside === '' || inside.startsWith('..') || path.isAbsolute(inside) ? script : inside;
}

/**
 * The argument that names the MCP script, out of whatever else is on the
 * command line. Pure, and exported, because it is half of what "installed"
 * means and the other half is a disk check.
 */
export function scriptArgOf(entry: McpServerEntry): string | null {
  return (entry.args ?? []).find((arg) => arg.endsWith('mcp.mjs')) ?? null;
}

/**
 * Whether an entry can actually start.
 *
 * A relative arg is resolved against the project root, because that is the
 * working directory Claude Code spawns an MCP server in — the same assumption
 * `findProjectRoot` in `scripts/mcp.mjs` already makes of `process.cwd()`. So
 * this repository's own committed `["scripts/mcp.mjs"]` is current, and the
 * identical line copied into another project is not: it resolves to a file that
 * is not there, the server never starts, and the agent gets no tools while the
 * config looks correct. That is the exact failure this button exists for, so it
 * counts as not installed and is offered the write.
 */
export function reaches(root: string, entry: McpServerEntry): boolean {
  const arg = scriptArgOf(entry);
  return arg !== null && existsSync(path.resolve(root, arg));
}

function configPathFor(root: string): string {
  return path.join(root, '.mcp.json');
}

/**
 * `node`, not `process.execPath`.
 *
 * The interpreter running this server would be the exact one that can run the
 * script, and in the packaged app it is the sidecar binary — but `.mcp.json`
 * lives in someone's project and is usually committed, and a version manager
 * moves that path on every `nvm use`. `node` is what Claude Code is itself
 * running on, so it is on the PATH of the process that will spawn this.
 */
function ourEntry(root: string, script: string): McpServerEntry {
  return { command: 'node', args: [argFor(root, script)] };
}

async function readConfig(
  root: string,
): Promise<{ config: McpConfig; unreadable: boolean }> {
  const raw = await readFile(configPathFor(root), 'utf8').catch(() => null);
  if (raw === null) return { config: {}, unreadable: false };

  try {
    const parsed = JSON.parse(raw) as McpConfig;
    // Valid JSON that is not an object cannot be merged into.
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { config: {}, unreadable: true };
    }
    return { config: parsed, unreadable: false };
  } catch {
    return { config: {}, unreadable: true };
  }
}

/**
 * Merge rather than replace. Every other server keeps its entry, and the file's
 * own top-level keys keep theirs — `.mcp.json` is a project's file, not ours.
 */
export function merge(config: McpConfig, entry: McpServerEntry): McpConfig {
  const servers = { ...(config.mcpServers ?? {}) };
  servers[SERVER_NAME] = entry;
  return { ...config, mcpServers: servers };
}

export async function readMcpStatus(root: string): Promise<McpStatus> {
  const { config, unreadable } = await readConfig(root);
  const { script, reason } = findScript();
  const servers = config.mcpServers ?? {};
  const ours = servers[SERVER_NAME];

  return {
    configPath: configPathFor(root),
    installed: !unreadable && ours !== undefined && reaches(root, ours),
    unreadable,
    others: Object.keys(servers).filter((name) => name !== SERVER_NAME),
    script: script === null ? null : argFor(root, script),
    reason,
    preview:
      script === null || unreadable
        ? null
        : `${JSON.stringify(merge(config, ourEntry(root, script)), null, 2)}\n`,
  };
}

export async function installMcp(root: string): Promise<McpStatus> {
  const { config, unreadable } = await readConfig(root);
  if (unreadable) {
    throw new Error(`${configPathFor(root)} is not valid JSON; fix or remove it first`);
  }

  const { script, reason } = findScript();
  if (script === null) throw new Error(reason ?? 'no MCP script to point at');

  await writeFile(
    configPathFor(root),
    `${JSON.stringify(merge(config, ourEntry(root, script)), null, 2)}\n`,
    'utf8',
  );

  return readMcpStatus(root);
}
