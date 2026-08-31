import { rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * The Claude Code hook has to reach a server whose port the OS assigns fresh on
 * every launch, and a hook definition in a settings file cannot know it. So the
 * port is left in the project, where a one-line shell hook can read it.
 *
 * It goes in `.claude/`, beside the settings that reference it — and only when
 * that directory already exists. The server does not create Claude Code's
 * directory uninvited; installing the hook is what creates it.
 */
export function portFilePath(root: string): string {
  return path.join(root, '.claude', 'codemap.port');
}

export async function writePortFile(root: string, port: number): Promise<boolean> {
  const directory = path.join(root, '.claude');
  const usable = await stat(directory).then((s) => s.isDirectory(), () => false);
  if (!usable) return false;

  await writeFile(portFilePath(root), `${port}\n`, 'utf8');
  return true;
}

export async function removePortFile(root: string): Promise<void> {
  // A stale file only costs the hook a failed connection, but leaving one behind
  // pointing at a port something else may later occupy is worse than tidying up.
  await rm(portFilePath(root), { force: true }).catch(() => undefined);
}

/** Keeps exactly one project pointed at this server. */
export function createPortFile(port: number) {
  let current: string | null = null;

  return {
    async pointAt(root: string): Promise<void> {
      if (current !== null && current !== root) await removePortFile(current);
      current = root;
      await writePortFile(root, port);
    },

    async clear(): Promise<void> {
      if (current !== null) await removePortFile(current);
      current = null;
    },
  };
}
