import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Writing the Claude Code hook for the user, instead of asking them to paste it.
 *
 * The command deliberately contains no port. It reads the one the server leaves
 * in `.claude/codemap.port`, so a single hook definition keeps working across
 * launches that land on different ports — and across a switch between projects,
 * because each project has its own file.
 */
const MATCHER = 'Write|Edit|MultiEdit';

const HOOK_COMMAND =
  `P="\${CLAUDE_PROJECT_DIR:-.}/.claude/codemap.port"; ` +
  `[ -f "$P" ] && curl -s -m 2 -X POST "http://127.0.0.1:$(cat "$P")/api/hook" ` +
  `-H 'content-type: application/json' --data-binary @- >/dev/null 2>&1; true`;

/** Recognises our own entry, in any form, so upgrading replaces rather than duplicates. */
const OURS = '/api/hook';

/**
 * Recognises an entry that can actually reach us. An older hook with a port
 * baked into it points at our endpoint but not at our server, since the OS
 * assigns a different port on every launch — so it counts as not installed and
 * gets offered the upgrade.
 */
const FINDS_THE_PORT = 'codemap.port';

interface HookCommand {
  type?: string;
  command?: string;
  timeout?: number;
}

interface HookEntry {
  matcher?: string;
  hooks?: HookCommand[];
}

interface Settings {
  hooks?: Record<string, HookEntry[] | undefined>;
  [key: string]: unknown;
}

export interface HookStatus {
  settingsPath: string;
  installed: boolean;
  /** True when a settings file exists and could not be parsed. */
  unreadable: boolean;
  /** Exactly what would be written, so nothing is a surprise. */
  preview: string;
}

function ourEntry(): HookEntry {
  return {
    matcher: MATCHER,
    hooks: [{ type: 'command', timeout: 5, command: HOOK_COMMAND }],
  };
}

function isOurs(entry: HookEntry): boolean {
  return (entry.hooks ?? []).some((hook) => (hook.command ?? '').includes(OURS));
}

function isCurrent(entry: HookEntry): boolean {
  return (entry.hooks ?? []).some((hook) => (hook.command ?? '').includes(FINDS_THE_PORT));
}

function settingsPathFor(root: string): string {
  return path.join(root, '.claude', 'settings.json');
}

async function readSettings(
  root: string,
): Promise<{ settings: Settings; existed: boolean; unreadable: boolean }> {
  const raw = await readFile(settingsPathFor(root), 'utf8').catch(() => null);
  if (raw === null) return { settings: {}, existed: false, unreadable: false };

  try {
    const parsed = JSON.parse(raw) as Settings;
    // A settings file that is valid JSON but not an object cannot be merged into.
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { settings: {}, existed: true, unreadable: true };
    }
    return { settings: parsed, existed: true, unreadable: false };
  } catch {
    return { settings: {}, existed: true, unreadable: true };
  }
}

/**
 * Merge rather than overwrite: a project may already run hooks that have nothing
 * to do with us, and losing them would be a far worse bug than not installing.
 */
function merge(settings: Settings): Settings {
  const hooks = { ...(settings.hooks ?? {}) };
  const postToolUse = [...(hooks['PostToolUse'] ?? [])];

  const existing = postToolUse.findIndex(isOurs);
  if (existing === -1) postToolUse.push(ourEntry());
  else postToolUse[existing] = ourEntry();

  hooks['PostToolUse'] = postToolUse;
  return { ...settings, hooks };
}

export async function readHookStatus(root: string): Promise<HookStatus> {
  const { settings, unreadable } = await readSettings(root);
  const installed = !unreadable && (settings.hooks?.['PostToolUse'] ?? []).some(isCurrent);

  return {
    settingsPath: settingsPathFor(root),
    installed,
    unreadable,
    preview: `${JSON.stringify(merge(settings), null, 2)}\n`,
  };
}

export async function installHook(root: string): Promise<HookStatus> {
  const { settings, unreadable } = await readSettings(root);
  if (unreadable) {
    throw new Error(`${settingsPathFor(root)} is not valid JSON; fix or remove it first`);
  }

  await mkdir(path.join(root, '.claude'), { recursive: true });
  await writeFile(settingsPathFor(root), `${JSON.stringify(merge(settings), null, 2)}\n`, 'utf8');

  return readHookStatus(root);
}
