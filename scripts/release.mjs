#!/usr/bin/env node
/**
 * One command from this checkout to a .dmg somebody else can download.
 *
 *   node scripts/release.mjs
 *
 * The steps were always there — `npm run build`, prepare-sidecar,
 * prepare-resources, `CI=true npm run tauri build` — chained by `&&` inside
 * tauri.conf.json and by hand everywhere else. `&&` only knows whether a
 * command exited 0. It does not know whether the sidecar came out ad-hoc
 * signed, whether a grammar went missing from the staged payload, or whether
 * the .dmg on disk is the one this run produced rather than one from last week.
 * Every step here is followed by a check on what it was supposed to leave
 * behind, and the run stops at the first one that did not happen.
 *
 * SIGNING AND NOTARISATION ARE OPT-IN, AND THEY ARE OPT-IN THROUGH THE
 * ENVIRONMENT, NEVER A FILE:
 *
 *   APPLE_SIGNING_IDENTITY   the certificate's *name*, e.g.
 *                            "Developer ID Application: Jane Doe (AB12CD34EF)".
 *                            A name is public; the private key stays in the
 *                            keychain and nothing here ever reads it. This is
 *                            the same variable Tauri's own bundler reads.
 *   APPLE_NOTARY_PROFILE     the name of a notarytool keychain profile the user
 *                            created with `xcrun notarytool store-credentials`.
 *                            Also just a name. The app-specific password it
 *                            stands for lives in the keychain and is never seen
 *                            by this script, printed, or written anywhere.
 *
 * With neither set the build is unsigned, and the summary says so in the
 * loudest terms this file has. That is deliberate. An unsigned .dmg dressed up
 * as a signed one is the exact kind of authoritative-looking lie this project
 * exists to refuse — and unlike a wrong edge in the graph, the person who finds
 * it out is a stranger whose Mac has just told them the download is damaged.
 *
 * Deliberately NOT supported: APPLE_CERTIFICATE / APPLE_CERTIFICATE_PASSWORD,
 * which Tauri accepts as a base64 certificate plus its password. That is a
 * secret in an environment variable, and a release run by a person on their own
 * Mac has a keychain, which is the better place for it.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const bundleDir = path.join(repoRoot, 'src-tauri', 'target', 'release', 'bundle');

const startedAt = Date.now();
/** Nothing older than this can be something this run produced. */
const startedAtMs = startedAt - 2000;

const identity = process.env.APPLE_SIGNING_IDENTITY?.trim() || null;
const notaryProfile = process.env.APPLE_NOTARY_PROFILE?.trim() || null;

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
  process.exit(0);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));

async function main() {
  preflight();

  step('Build the server and the web page', () => run('npm', ['run', 'build']));
  expectFiles('the compiled app', [
    'dist/server/main.js',
    'dist/cli/index.js',
    'dist/web/index.html',
  ]);

  step('Prepare the Node sidecar', () => run('node', ['scripts/prepare-sidecar.mjs']));
  const sidecar = checkSidecar();

  step('Stage the app payload', () => run('node', ['scripts/prepare-resources.mjs']));
  checkPayload();

  // tauri.conf.json's beforeBuildCommand runs those three again. That is
  // duplicated work and it is kept on purpose: a plain `npm run tauri build`
  // has to keep working on its own, and the three steps are idempotent. What
  // this run gets that the chain cannot give it is a check after each one.
  step('Bundle the app and the disk image', () =>
    run('npm', ['run', 'tauri', 'build'], { CI: 'true' }),
  );

  const app = findFresh(path.join(bundleDir, 'macos'), (name) => name.endsWith('.app'), 'app bundle');
  const dmg = findFresh(path.join(bundleDir, 'dmg'), (name) => name.endsWith('.dmg'), 'disk image');
  checkBundledSidecar(app);

  const signed = identity ? verifySigned(app) : reportUnsigned(app);
  const notarised = signed && notaryProfile ? notarise(dmg) : false;

  summary({ app, dmg, sidecar, signed, notarised });
}

// ---------------------------------------------------------------- preflight

function preflight() {
  if (process.platform !== 'darwin') {
    fail(`this builds a macOS .app and .dmg; this machine is ${process.platform}`);
  }

  for (const tool of ['npm', 'node', 'cargo', 'rustc']) {
    if (spawnSync('which', [tool]).status !== 0) fail(`\`${tool}\` is not on PATH`);
  }

  // The version is printed on a release page and burned into the .dmg's file
  // name. Two manifests carry it and they have disagreed before (0.0.1 against
  // 0.1.0), which is not something a build can notice on its own.
  const pkg = readJson('package.json');
  const conf = readJson('src-tauri/tauri.conf.json');
  if (pkg.version !== conf.version) {
    fail(
      `package.json says ${pkg.version} and src-tauri/tauri.conf.json says ${conf.version}. ` +
        'Make them agree before releasing — the version ends up in the .dmg file name.',
    );
  }

  const triple = hostTriple();
  if (!triple.startsWith('aarch64')) {
    warn(
      `this host is ${triple}, so the artefacts will not run on Apple silicon. ` +
        'The published release is Apple silicon only.',
    );
  }

  // The documented trap: a bundle_dmg.sh that died leaves a read-write image
  // behind, still mounted, and the next build fails on it. Clearing it is the
  // first thing a person does by hand, so do it here and say so.
  clearStrayImages();

  const dirty = capture('git', ['status', '--porcelain']).trim();
  const commit = capture('git', ['rev-parse', '--short', 'HEAD']).trim();
  console.log(`codemaps ${pkg.version} from ${commit}${dirty ? ' (working tree is dirty)' : ''}`);
  if (dirty) warn('uncommitted changes are in this build; the commit above does not describe it');

  console.log(
    identity
      ? `signing as: ${identity}`
      : 'signing: OFF — set APPLE_SIGNING_IDENTITY to a Developer ID Application certificate name',
  );
  console.log(
    notaryProfile
      ? `notarising through keychain profile: ${notaryProfile}`
      : 'notarising: OFF — set APPLE_NOTARY_PROFILE to a notarytool keychain profile name',
  );
  if (notaryProfile && !identity) {
    fail(
      'APPLE_NOTARY_PROFILE is set but APPLE_SIGNING_IDENTITY is not. ' +
        'Apple will not notarise an unsigned build, so this run would waste the upload.',
    );
  }
  console.log('');
}

/**
 * Detach and delete any `rw.*.dmg` left in our own bundle directory. Scoped to
 * this repository's path on purpose — `hdiutil info` lists every disk image the
 * user has mounted, and detaching somebody else's is not this script's business.
 */
function clearStrayImages() {
  const macosDir = path.join(bundleDir, 'macos');
  if (!existsSync(macosDir)) return;
  const strays = readdirSync(macosDir).filter((name) => name.startsWith('rw.') && name.endsWith('.dmg'));
  if (strays.length === 0) return;

  const mounted = mountedDevicesUnder(macosDir);
  for (const device of mounted) {
    spawnSync('hdiutil', ['detach', device, '-force'], { stdio: 'inherit' });
  }
  for (const stray of strays) {
    rmSync(path.join(macosDir, stray), { force: true });
  }
  warn(
    `cleared ${strays.length} leftover read-write image(s) from a build that died in bundle_dmg.sh` +
      `${mounted.length ? `, ${mounted.length} still mounted` : ''}`,
  );
}

/** The /dev/diskN entries `hdiutil info` attributes to images under `dir`. */
function mountedDevicesUnder(dir) {
  const info = capture('hdiutil', ['info']);
  const devices = [];
  for (const block of info.split('================================================')) {
    const imagePath = /^image-path\s*:\s*(.+)$/m.exec(block)?.[1]?.trim();
    if (!imagePath?.startsWith(dir)) continue;
    for (const match of block.matchAll(/^(\/dev\/disk\d+)\s/gm)) devices.push(match[1]);
  }
  return devices;
}

// ------------------------------------------------------------ step checking

function checkSidecar() {
  const triple = hostTriple();
  const target = path.join(repoRoot, 'src-tauri', 'binaries', `node-${triple}`);
  if (!existsSync(target)) fail(`prepare-sidecar.mjs left no binary at src-tauri/binaries/node-${triple}`);

  // A universal binary here means `lipo` did not run, and the .dmg would carry
  // an extra 60 MB of an architecture that is never executed.
  const described = capture('file', ['-b', target]);
  if (described.includes('universal')) fail('the sidecar is still a universal binary; `lipo` did not thin it');

  const signature = capture('codesign', ['-dv', '--verbose=2', target], { mergeStderr: true });
  const adhoc = signature.includes('Signature=adhoc');
  if (identity && adhoc) {
    fail(
      'APPLE_SIGNING_IDENTITY is set but the sidecar came out ad-hoc signed. ' +
        'Tauri signs the app bundle without --deep, so this binary keeps this signature ' +
        'into the .dmg and the notary service will reject it.',
    );
  }
  if (identity) checkHardened(target, 'the sidecar');

  const megabytes = (statSync(target).size / 1024 / 1024).toFixed(0);
  return { path: target, megabytes, adhoc };
}

/**
 * The staged payload, checked against the manifest prepare-resources.mjs just
 * wrote rather than against a second copy of the dependency list. A grammar
 * that is staged but whose native addon was pruned away fails one file at a
 * time on a stderr stream nobody reads, so the check is that every runtime
 * dependency is actually on disk.
 */
function checkPayload() {
  const staging = path.join(repoRoot, 'dist-app');
  expectFiles('the staged payload', ['dist-app/dist/server/main.js', 'dist-app/package.json']);

  const manifest = readJson('dist-app/package.json');
  const missing = Object.keys(manifest.dependencies ?? {}).filter(
    (name) => !existsSync(path.join(staging, 'node_modules', name)),
  );
  if (missing.length > 0) {
    fail(`the staged payload is missing ${missing.length} runtime package(s): ${missing.join(', ')}`);
  }
  console.log(`  ${Object.keys(manifest.dependencies ?? {}).length} runtime packages staged`);
}

/** The one file in `dir` matching `matches`, and it must be from this run. */
function findFresh(dir, matches, what) {
  if (!existsSync(dir)) fail(`the build left no ${what}: ${path.relative(repoRoot, dir)} does not exist`);
  const found = readdirSync(dir).filter(matches);
  if (found.length === 0) fail(`the build left no ${what} in ${path.relative(repoRoot, dir)}`);
  if (found.length > 1) {
    fail(`${found.length} candidates for the ${what} in ${path.relative(repoRoot, dir)}: ${found.join(', ')}`);
  }

  const full = path.join(dir, found[0]);
  if (statSync(full).mtimeMs < startedAtMs) {
    fail(`${path.relative(repoRoot, full)} is older than this run — the build did not replace it`);
  }
  return full;
}

/**
 * The sidecar as it ended up inside the .app. Tauri copies it in, and a bundle
 * whose Contents/MacOS holds only the Rust binary is an app that opens a window
 * and never gets a port.
 */
function checkBundledSidecar(app) {
  const nested = path.join(app, 'Contents', 'MacOS', 'node');
  if (!existsSync(nested)) fail(`${path.relative(repoRoot, app)} has no sidecar at Contents/MacOS/node`);
  if (!existsSync(path.join(app, 'Contents', 'Resources', 'app', 'dist', 'server', 'main.js'))) {
    fail(`${path.relative(repoRoot, app)} has no server at Contents/Resources/app/dist/server/main.js`);
  }
  if (identity) {
    const signature = capture('codesign', ['-dv', '--verbose=2', nested], { mergeStderr: true });
    if (signature.includes('Signature=adhoc')) {
      fail('the sidecar inside the .app is ad-hoc signed; the notary service will reject the bundle');
    }
    checkHardened(nested, 'the sidecar inside the .app');
  }
}

/**
 * The hardened runtime, and the entitlements that make it survivable.
 *
 * Both halves are checked because codesign can leave a binary with neither and
 * still look like it worked. A plist containing an XML comment is rejected by
 * AMFI's parser rather than by codesign's argument handling, and what comes out
 * the other side is signed with `flags=0x0(none)` — no runtime, no
 * entitlements — which the notary service accepts and macOS then kills.
 */
function checkHardened(binary, what) {
  const signature = capture('codesign', ['-dv', '--verbose=2', binary], { mergeStderr: true });
  if (!/flags=\S*runtime/.test(signature)) {
    fail(`${what} is signed without the hardened runtime; the notary service will reject it`);
  }

  const declared = capture('codesign', ['-d', '--entitlements', '-', binary], { mergeStderr: true });
  const required = [
    'com.apple.security.cs.allow-jit',
    'com.apple.security.cs.disable-library-validation',
  ];
  const missing = required.filter((key) => !declared.includes(key));
  if (missing.length > 0) {
    fail(
      `${what} is missing ${missing.join(' and ')}. Under the hardened runtime that ` +
        'notarisation requires, the first stops V8 from starting and the second stops ' +
        'tree-sitter\'s addons from loading. See src-tauri/entitlements-sidecar.plist.',
    );
  }
}

// -------------------------------------------------------- signing verdicts

function verifySigned(app) {
  console.log('Verifying the signature');
  const verify = spawnSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], {
    encoding: 'utf8',
  });
  if (verify.status !== 0) {
    fail(`codesign refused the bundle it just signed:\n${(verify.stderr || verify.stdout).trim()}`);
  }

  const details = capture('codesign', ['-dv', '--verbose=4', app], { mergeStderr: true });
  const authority = /^Authority=(.+)$/m.exec(details)?.[1] ?? '(none)';
  const team = /^TeamIdentifier=(.+)$/m.exec(details)?.[1] ?? 'not set';

  if (!authority.startsWith('Developer ID Application')) {
    fail(
      `the bundle is signed by "${authority}", which cannot be distributed. ` +
        'A downloadable build needs a Developer ID Application certificate — an Apple ' +
        'Development certificate signs only for your own registered devices.',
    );
  }
  // Without the hardened runtime the notary service rejects the upload, and it
  // is easier to find out here than after the round trip.
  if (!details.includes('runtime')) fail('the bundle is signed without the hardened runtime (--options runtime)');

  console.log(`  ${authority}, team ${team}, hardened runtime on`);
  return true;
}

function reportUnsigned(app) {
  const details = capture('codesign', ['-dv', '--verbose=4', app], { mergeStderr: true });
  const signature = /^Signature=(.+)$/m.exec(details)?.[1] ?? 'none';
  console.log(`Signature on the bundle: ${signature} (nothing was signed for distribution)`);
  return false;
}

function notarise(dmg) {
  console.log(`\nSubmitting to the notary service through keychain profile "${notaryProfile}"`);
  console.log('This uploads the disk image to Apple and waits; several minutes is normal.');

  // --keychain-profile names credentials the user stored themselves. Nothing
  // secret is passed on this command line, and nothing secret comes back.
  const submit = spawnSync(
    'xcrun',
    ['notarytool', 'submit', dmg, '--keychain-profile', notaryProfile, '--wait'],
    { stdio: 'inherit' },
  );
  if (submit.status !== 0) {
    fail(
      'notarytool refused the submission. `xcrun notarytool log <submission-id> ' +
        `--keychain-profile ${notaryProfile}` +
        '` says what Apple objected to — most often an unsigned nested binary.',
    );
  }

  // Stapling is what makes the ticket travel with the file, so a first launch
  // works without a network round trip.
  if (spawnSync('xcrun', ['stapler', 'staple', dmg], { stdio: 'inherit' }).status !== 0) {
    fail('the disk image was notarised but could not be stapled');
  }

  const assessment = spawnSync('spctl', ['-a', '-vvv', '-t', 'open', '--context', 'context:primary-signature', dmg], {
    encoding: 'utf8',
  });
  console.log((assessment.stderr || assessment.stdout).trim());
  if (assessment.status !== 0) fail('Gatekeeper still rejects the stapled disk image');
  return true;
}

// ------------------------------------------------------------------ summary

function summary({ app, dmg, sidecar, signed, notarised }) {
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(0);
  const dmgBytes = statSync(dmg).size;
  const sha = capture('shasum', ['-a', '256', dmg]).split(/\s+/)[0];

  console.log('');
  console.log(`Built in ${seconds}s`);
  console.log(`  ${path.relative(repoRoot, app)}  ${dirSize(app)}`);
  console.log(`  ${path.relative(repoRoot, dmg)}  ${(dmgBytes / 1024 / 1024).toFixed(0)} MB`);
  console.log(`  sidecar ${sidecar.megabytes} MB, ${hostTriple()}`);
  console.log(`  sha256  ${sha}`);
  console.log('');

  if (notarised) {
    console.log('SIGNED AND NOTARISED. A downloaded copy opens on a double click.');
  } else if (signed) {
    banner([
      'SIGNED BUT NOT NOTARISED.',
      '',
      'macOS will still warn about a downloaded copy: Gatekeeper asks Apple whether',
      'this build was notarised, and it was not. Set APPLE_NOTARY_PROFILE and run',
      'again — the signature is the expensive half and it is already done.',
    ]);
  } else {
    banner([
      'THIS BUILD IS NOT SIGNED. DO NOT PUBLISH IT AS IF IT WERE.',
      '',
      'A copy downloaded from the web carries the quarantine flag, and macOS refuses',
      'an unsigned quarantined app — usually with "the application is damaged and',
      'cannot be opened", which is false, but it is what the person sees. They get',
      'past it with:',
      '',
      '    xattr -dr com.apple.quarantine /Applications/codemaps.app',
      '',
      'If you publish this file, the download page has to say that, in those words.',
      'Set APPLE_SIGNING_IDENTITY to a Developer ID Application certificate name and',
      'run again to remove the step instead of documenting it. docs/RELEASING.md has',
      'the whole path.',
    ]);
  }
}

function banner(lines) {
  const width = Math.max(...lines.map((line) => line.length)) + 4;
  console.log('='.repeat(width));
  for (const line of lines) console.log(`  ${line}`);
  console.log('='.repeat(width));
}

// ------------------------------------------------------------------ plumbing

function step(what, body) {
  console.log(`\n== ${what}`);
  body();
}

function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  });
  if (result.status !== 0) {
    fail(`\`${command} ${args.join(' ')}\` exited ${result.status ?? result.signal}`);
  }
}

function capture(command, args, { mergeStderr = false } = {}) {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: 'utf8' });
  // codesign writes everything it knows to stderr, including on success.
  return mergeStderr ? `${result.stdout ?? ''}${result.stderr ?? ''}` : (result.stdout ?? '');
}

function expectFiles(what, relatives) {
  const missing = relatives.filter((relative) => !existsSync(path.join(repoRoot, relative)));
  if (missing.length > 0) fail(`${what} is incomplete; missing ${missing.join(', ')}`);
}

function readJson(relative) {
  return JSON.parse(readFileSync(path.join(repoRoot, relative), 'utf8'));
}

function hostTriple() {
  const match = /^host:\s*(\S+)$/m.exec(execFileSync('rustc', ['-vV'], { encoding: 'utf8' }));
  if (!match?.[1]) fail('could not read the host triple from `rustc -vV`');
  return match[1];
}

function dirSize(dir) {
  return capture('du', ['-sh', dir]).split('\t')[0].trim();
}

function warn(message) {
  console.log(`  warning: ${message}`);
}

function fail(message) {
  console.error(`\nrelease stopped: ${message}`);
  process.exit(1);
}
