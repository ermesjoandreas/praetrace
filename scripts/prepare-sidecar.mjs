// Produces the Node runtime Tauri ships as a sidecar.
//
// The server is NOT bundled into a single executable. tree-sitter and its
// grammars are native addons resolved at runtime by a filesystem scan, and the
// parser pool loads its worker as a sibling file by URL — neither survives Node
// SEA or pkg without patching third-party package internals. Shipping a real
// Node binary beside the app's own dist/ keeps both working untouched.
//
// The binary is large and machine-specific, so it is generated rather than
// committed. Run this before `tauri build`, and once before `tauri dev`.

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const binariesDir = path.join(repoRoot, 'src-tauri', 'binaries');

/** Tauri resolves a sidecar by this exact suffix, so it must match rustc's host. */
function hostTriple() {
  const output = execFileSync('rustc', ['-vV'], { encoding: 'utf8' });
  const match = /^host:\s*(\S+)$/m.exec(output);
  if (!match?.[1]) throw new Error('could not read the host triple from `rustc -vV`');
  return match[1];
}

function isUniversal(binary) {
  const described = execFileSync('file', ['-b', binary], { encoding: 'utf8' });
  return described.includes('universal');
}

const triple = hostTriple();
const target = path.join(binariesDir, `node-${triple}`);

mkdirSync(binariesDir, { recursive: true });
copyFileSync(process.execPath, target);

// macOS ships node as a universal binary. postject refuses it, it doubles the
// download, and only one architecture is ever executed.
if (process.platform === 'darwin' && isUniversal(target)) {
  const arch = triple.startsWith('aarch64') ? 'arm64' : 'x86_64';
  execFileSync('lipo', [target, '-thin', arch, '-output', target]);
  console.log(`thinned to ${arch}`);
}

// Any edit to a Mach-O invalidates its signature, and macOS SIGKILLs an
// unsigned-but-modified binary on launch. Ad-hoc signing is enough locally;
// distribution needs a real identity.
if (process.platform === 'darwin') {
  execFileSync('codesign', ['--force', '--sign', '-', target]);
  console.log('ad-hoc signed');
}

const megabytes = (statSync(target).size / 1024 / 1024).toFixed(0);
console.log(`sidecar ready: src-tauri/binaries/node-${triple} (${megabytes} MB, from ${process.execPath})`);
