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
// distribution needs a real identity, and this is the only place it can be
// applied.
//
// Tauri signs the *bundle*, and it signs it without `--deep` — the flags in the
// CLI binary are `--force --options runtime --keychain --entitlements` and
// nothing else. A nested executable therefore keeps whatever signature it
// arrived with, and an ad-hoc one is exactly what the notary service rejects.
// So the sidecar is signed here, before Tauri ever copies it in.
//
// APPLE_SIGNING_IDENTITY holds a certificate's *name*, which is public and is
// the same variable Tauri itself reads; the private key stays in the keychain
// and is never handled by this script.
const identity = process.env.APPLE_SIGNING_IDENTITY;

if (process.platform === 'darwin' && identity) {
  // `--options runtime` is what notarisation requires, and it is also what makes
  // the entitlements necessary rather than decorative. Each of the three in
  // src-tauri/entitlements-sidecar.plist is something the hardened runtime would
  // otherwise stop dead:
  //
  //   allow-jit, allow-unsigned-executable-memory — V8 writes machine code at
  //     run time. Without them the sidecar never starts, so the app opens on a
  //     window that never gets a port.
  //   disable-library-validation — dist-app/node_modules holds tree-sitter's
  //     prebuilt .node addons, third-party binaries nobody here signed. Library
  //     validation refuses a dylib signed by another team, so every file would
  //     fail to parse one at a time, on a stderr stream the desktop app has
  //     nobody reading.
  //
  // The reasoning is here rather than in the plist because a plist handed to
  // codesign may not contain XML comments: AMFI's parser rejects them
  // ("AMFIUnserializeXML: syntax error"), codesign exits 1, and the binary is
  // left signed with neither the runtime flag nor the entitlements.
  execFileSync('codesign', [
    '--force',
    '--timestamp',
    '--options',
    'runtime',
    '--entitlements',
    path.join(repoRoot, 'src-tauri', 'entitlements-sidecar.plist'),
    '--sign',
    identity,
    target,
  ]);
  console.log(`signed for distribution: ${identity}`);
} else if (process.platform === 'darwin') {
  execFileSync('codesign', ['--force', '--sign', '-', target]);
  console.log('ad-hoc signed — set APPLE_SIGNING_IDENTITY for a distributable build');
}

const megabytes = (statSync(target).size / 1024 / 1024).toFixed(0);
console.log(`sidecar ready: src-tauri/binaries/node-${triple} (${megabytes} MB, from ${process.execPath})`);
