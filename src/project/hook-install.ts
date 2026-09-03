import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Writing the Claude Code hook for the user, instead of asking them to paste it.
 *
 * The command deliberately contains no port. It reads the one the server leaves
 * in `.claude/codemap.port`, so a single hook definition keeps working across
 * launches that land on different ports — and across a switch between projects,
 * because each project has its own file.
 *
 * It is also two-way. `/api/hook` answers with what the file just written is
 * coupled to, and curl prints that answer on stdout, which is the one channel a
 * `PostToolUse` hook has back into the agent's context. So the shell stays a
 * pipe and nothing more: stderr is silenced, stdout is not, and `true` keeps
 * the exit code clean whatever happened — a hook must never fail the tool call
 * it fired after.
 *
 * Which is exactly why `-f` is there. Because stdout is the channel, anything
 * curl prints on it is read as the graph's answer, and an HTTP error body is
 * not one.
 */
const MATCHER = 'Write|Edit|MultiEdit';

/**
 * Exported so the test beside this file can check our own command against the
 * recogniser below. The two are one decision written twice, and the failure
 * when they drift is silent: every install reads as current and no answer ever
 * reaches the agent.
 */
export const HOOK_COMMAND =
  `P="\${CLAUDE_PROJECT_DIR:-.}/.claude/codemap.port"; ` +
  `[ -f "$P" ] && curl -sf -m 2 -X POST "http://127.0.0.1:$(cat "$P")/api/hook" ` +
  `-H 'content-type: application/json' --data-binary @- 2>/dev/null; true`;

/** Recognises our own entry, in any form, so upgrading replaces rather than duplicates. */
const OURS = '/api/hook';

/**
 * Recognises an entry that can actually reach us. An older hook with a port
 * baked into it points at our endpoint but not at our server, since the OS
 * assigns a different port on every launch — so it counts as not installed and
 * gets offered the upgrade.
 */
const FINDS_THE_PORT = 'codemap.port';

/**
 * Stdout sent to /dev/null, which every codemap hook written before the
 * endpoint had anything to say does.
 *
 * It reaches the server, gets the answer and throws it away, so it counts as
 * not installed for the same reason a baked-in port does: it looks like ours
 * and does not do what ours does. `2>/dev/null` is stderr and is left alone —
 * the current command uses it.
 */
const DISCARDS_STDOUT = /(?:^|[\s&])(?:1|&)?>\s*\/dev\/null/;

/**
 * `-f`, so an HTTP error prints no body.
 *
 * `/api/hook` answers 200 whatever it made of the payload, but Fastify answers
 * before the route does: a body over its 1 MiB limit is a 413 and an
 * unrecognised content-type a 415. Without `-f` curl prints that JSON on
 * stdout, and stdout is where Claude Code reads the hook's answer — so one
 * large Edit puts `{"statusCode":413,...}` into the agent's context wearing the
 * graph's voice.
 *
 * Matched from `curl` rather than anywhere in the line, because our own command
 * opens with the shell's `[ -f "$P" ]` — a file test, three tokens earlier, that
 * an unanchored pattern would happily accept as curl's. `--fail-with-body` is
 * not accepted: it is the flag that keeps the body.
 */
const FAILS_ON_ERROR = /\bcurl\b[^;|\n]*?(?:\s-[A-Za-z]*f|\s--fail(?![\w-]))/;

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

/**
 * Whether one command is a codemap hook that still does what ours does: finds
 * the port for itself, lets the answer through, and lets nothing else through.
 * Pure, and exported, so the three ways it can be wrong are readable in a test
 * rather than in a settings file nobody opens.
 */
export function isCurrentHook(command: string): boolean {
  return (
    command.includes(FINDS_THE_PORT) &&
    !DISCARDS_STDOUT.test(command) &&
    FAILS_ON_ERROR.test(command)
  );
}

function isCurrent(entry: HookEntry): boolean {
  return (entry.hooks ?? []).some((hook) => isCurrentHook(hook.command ?? ''));
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
