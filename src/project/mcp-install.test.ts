import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  argFor,
  installMcp,
  merge,
  readMcpStatus,
  reaches,
  scriptArgOf,
  scriptFrom,
} from './mcp-install.js';

/** Where this test was compiled to: dist/project, beside the module it tests. */
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const CHECKOUT = path.resolve(MODULE_DIR, '..', '..');

async function inTempProject(work: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codemap-mcp-'));
  try {
    await work(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('the path we would write is a file that is really there', () => {
  // The whole feature is one path, and it is arithmetic on this module's own
  // location. Wrong by one directory and every install writes a config naming
  // a file that does not exist — which fails in the agent's session, not here.
  assert.equal(scriptFrom(MODULE_DIR), path.join(CHECKOUT, 'scripts', 'mcp.mjs'));
  assert.equal(existsSync(scriptFrom(MODULE_DIR)), true);
});

test('the script is relative inside its own checkout and absolute anywhere else', () => {
  const script = scriptFrom(MODULE_DIR);
  // codemap opened on itself: what is already committed here, unchanged.
  assert.equal(argFor(CHECKOUT, script), path.join('scripts', 'mcp.mjs'));
  // Any other project: there is no relation between the two directories to
  // write down, and `..` climbing out of someone's repository is not one.
  assert.equal(argFor('/tmp/some-other-project', script), script);
});

test('the script argument is found past whatever else is on the command line', () => {
  assert.equal(scriptArgOf({ command: 'node', args: ['scripts/mcp.mjs'] }), 'scripts/mcp.mjs');
  assert.equal(
    scriptArgOf({ command: 'node', args: ['--enable-source-maps', '/opt/codemap/scripts/mcp.mjs'] }),
    '/opt/codemap/scripts/mcp.mjs',
  );
  assert.equal(scriptArgOf({ command: 'uvx', args: ['some-other-server'] }), null);
  assert.equal(scriptArgOf({ command: 'node' }), null);
});

test('the same relative entry reaches us here and reaches nothing elsewhere', async () => {
  // This is the bug the button exists for. `["scripts/mcp.mjs"]` is correct in
  // this repository, because Claude Code spawns an MCP server with the project
  // as its working directory. Copied into another project it resolves to a file
  // that is not there: the server never starts and the agent gets no tools,
  // while the config on screen looks exactly right.
  const entry = { command: 'node', args: ['scripts/mcp.mjs'] };
  assert.equal(reaches(CHECKOUT, entry), true);
  await inTempProject(async (root) => {
    assert.equal(reaches(root, entry), false);
  });
});

test('merging keeps every other server, and the file’s own keys', () => {
  const before = {
    $schema: 'https://example.invalid/mcp.json',
    mcpServers: {
      github: { command: 'docker', args: ['run', 'ghcr.io/github/mcp'] },
      codemap: { command: 'node', args: ['old/path/mcp.mjs'] },
    },
  };
  const after = merge(before, { command: 'node', args: ['/opt/codemap/scripts/mcp.mjs'] });

  assert.deepEqual(after['$schema'], before['$schema']);
  assert.deepEqual(after.mcpServers?.['github'], before.mcpServers.github);
  assert.deepEqual(after.mcpServers?.['codemap'], {
    command: 'node',
    args: ['/opt/codemap/scripts/mcp.mjs'],
  });
  // The input is not touched: the status route previews a merge of a config it
  // has only read.
  assert.deepEqual(before.mcpServers.codemap, { command: 'node', args: ['old/path/mcp.mjs'] });
});

test('a project with no .mcp.json is not installed, and one write fixes it', async () => {
  await inTempProject(async (root) => {
    const before = await readMcpStatus(root);
    assert.equal(before.installed, false);
    assert.equal(before.unreadable, false);
    assert.equal(before.configPath, path.join(root, '.mcp.json'));
    assert.equal(before.reason, null);
    assert.equal(before.script, scriptFrom(MODULE_DIR));
    assert.match(before.preview ?? '', /"codemap"/);

    const after = await installMcp(root);
    assert.equal(after.installed, true);

    const written = JSON.parse(await readFile(path.join(root, '.mcp.json'), 'utf8')) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    assert.deepEqual(written.mcpServers['codemap'], {
      command: 'node',
      args: [scriptFrom(MODULE_DIR)],
    });
  });
});

test('installing into a project that already runs other servers keeps them', async () => {
  await inTempProject(async (root) => {
    await writeFile(
      path.join(root, '.mcp.json'),
      JSON.stringify({ mcpServers: { linear: { command: 'npx', args: ['-y', 'linear-mcp'] } } }),
      'utf8',
    );

    const before = await readMcpStatus(root);
    assert.deepEqual(before.others, ['linear']);
    assert.equal(before.installed, false);

    const after = await installMcp(root);
    assert.equal(after.installed, true);
    assert.deepEqual(after.others, ['linear']);

    const written = JSON.parse(await readFile(path.join(root, '.mcp.json'), 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    assert.deepEqual(written.mcpServers['linear'], { command: 'npx', args: ['-y', 'linear-mcp'] });
  });
});

test('an entry naming a script that is not there is offered the write', async () => {
  await inTempProject(async (root) => {
    await writeFile(
      path.join(root, '.mcp.json'),
      JSON.stringify({ mcpServers: { codemap: { command: 'node', args: ['scripts/mcp.mjs'] } } }),
      'utf8',
    );
    const status = await readMcpStatus(root);
    assert.equal(status.installed, false);
    assert.deepEqual(status.others, []);
  });
});

test('a .mcp.json that is not valid JSON is refused rather than overwritten', async () => {
  await inTempProject(async (root) => {
    await writeFile(path.join(root, '.mcp.json'), '{ "mcpServers": ', 'utf8');
    const status = await readMcpStatus(root);
    assert.equal(status.unreadable, true);
    assert.equal(status.installed, false);
    // Nothing would be written, so nothing is previewed. A merge into `{}` is
    // what the preview would otherwise show — a file holding only codemap,
    // over a config whose servers we could not read.
    assert.equal(status.preview, null);

    // Someone's project file, and the parse failure is theirs to fix: merging
    // into what we could not read means writing over servers we cannot see.
    await assert.rejects(installMcp(root), /not valid JSON/);
    assert.equal(await readFile(path.join(root, '.mcp.json'), 'utf8'), '{ "mcpServers": ');
  });
});

test('valid JSON that is not an object is unreadable too', async () => {
  await inTempProject(async (root) => {
    await writeFile(path.join(root, '.mcp.json'), '["not", "a", "config"]', 'utf8');
    assert.equal((await readMcpStatus(root)).unreadable, true);
  });
});
