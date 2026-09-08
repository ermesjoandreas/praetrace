# Releasing codemaps

What stands between this checkout and a `.dmg` a stranger can download and open.

The release is **macOS on Apple silicon only**, MIT licensed, published as a
GitHub release. The `.dmg` carries an `arm64` Node binary as its sidecar, so an
Intel Mac cannot run it — that has to be said on the download page rather than
discovered.

One command does the build:

```bash
node scripts/release.mjs
```

It runs every step in order, checks what each one was supposed to leave behind,
and stops at the first one that did not happen. It signs and notarises **only**
when the environment supplies what those need, and when it does not, it says so
in the loudest terms it has. Everything below is either how to give it what it
needs, or what to do when it refuses.

---

## Once, before the first signed release

Two things only a person with the Apple Developer account can do. Neither is
scriptable, and neither should be handed to anyone — including an agent — to do
on your behalf.

### 1. A Developer ID Application certificate

**An Apple Development certificate cannot do this.** That is the one that signs
builds for your own registered devices, and it is what a new Xcode account
setup gives you. Distribution outside the App Store needs a *Developer ID
Application* certificate, which needs paid Apple Developer Program membership.

In Xcode:

> Xcode → Settings → Accounts → select your Apple ID → **Manage Certificates…**
> → the **+** button at the bottom left → **Developer ID Application**

Then check what the keychain holds:

```bash
security find-identity -v -p codesigning
```

The output lists identity *names* — public strings, safe to read, safe to paste
into a script or a CI variable. You are looking for a line beginning
`Developer ID Application:`. If every line says `Apple Development:`, the
certificate was not created and signing will not work yet.

Measured on this machine, 2026-09-08: the keychain holds
`Developer ID Application: Andreas Ermesjø (AV26DNQ5SC)`. The certificate
exists; nothing else is required for the signing half.

### 2. A notarytool keychain profile

Notarisation needs an app-specific password. **It must never be typed into a
chat, committed, or put in an environment variable.** `notarytool` stores it in
the keychain once and refers to it by a profile name afterwards, and a profile
name is all this repository's scripts ever see.

Get an app-specific password at
[appleid.apple.com](https://appleid.apple.com) → Sign-In and Security →
App-Specific Passwords. Then, **in your own terminal**, run:

```bash
xcrun notarytool store-credentials
```

With no arguments it prompts for each field in turn — profile name, Apple ID,
team ID, then the password, which it reads without echoing. Name the profile
`codemaps-notary`; the rest of this document assumes that name.

The non-interactive form exists and is written here only so you can recognise
it. Prefer the prompting form: this one puts the password in your shell history.

```bash
xcrun notarytool store-credentials "codemaps-notary" \
  --apple-id "you@example.com" \
  --team-id "AV26DNQ5SC"
# omit --password and it prompts for it
```

Check it afterwards with a submission history request, which needs no upload:

```bash
xcrun notarytool history --keychain-profile "codemaps-notary"
```

---

## Every release

```bash
# 1. The tests must pass. release.mjs does not run them.
npm test

# 2. The version, in both manifests. They have disagreed before, and
#    release.mjs refuses to build until they agree.
#      package.json          "version"
#      src-tauri/tauri.conf.json   "version"
#    Commit the bump; a dirty tree only earns a warning, but the commit hash
#    printed in the build summary is what identifies the artefact.

# 3. Signing and notarisation, by name only. Both values are public.
export APPLE_SIGNING_IDENTITY="Developer ID Application: Andreas Ermesjø (AV26DNQ5SC)"
export APPLE_NOTARY_PROFILE="codemaps-notary"

# 4. Build.
node scripts/release.mjs
```

The whole run takes a few minutes, most of it Apple's notary service. Leaving
both variables unset builds an unsigned `.dmg` — see *The unsigned path* below
for what that costs and what the download page then has to say.

The build leaves:

```
src-tauri/target/release/bundle/macos/codemaps.app
src-tauri/target/release/bundle/dmg/codemaps_<version>_aarch64.dmg
```

and prints the `.dmg`'s size and `sha256`. Put the checksum in the release
notes; a stranger downloading an app has no other way to check what they got.

### 5. Publish

Creating the tag, the GitHub release, and uploading the asset are left to you
deliberately — nothing in this repository publishes anything.

```bash
git tag v<version> && git push origin v<version>
gh release create v<version> \
  src-tauri/target/release/bundle/dmg/codemaps_<version>_aarch64.dmg \
  --title "codemaps <version>" --notes-file <your notes>
```

**The release notes must say two things**, whatever else they say:

- **Apple silicon only.** No Intel build, no Windows, no Linux.
- **If the build is unsigned, that it is unsigned**, and the exact command that
  gets past Gatekeeper. A download page that promises less friction than the
  file delivers is the failure this whole project exists to refuse.

---

## What the script checks, and what each refusal means

`release.mjs` stops rather than continues. In the order it checks:

| It refuses when | Because |
|---|---|
| `package.json` and `tauri.conf.json` disagree on the version | The version is burned into the `.dmg` file name and printed on the release page. |
| `npm run build` leaves no `dist/server/main.js`, `dist/cli/index.js` or `dist/web/index.html` | The sidecar would ship with nothing to run. |
| The sidecar is still a universal binary | `lipo` did not thin it, and the download carries 60 MB of an architecture that is never executed. |
| The sidecar is ad-hoc signed *while* `APPLE_SIGNING_IDENTITY` is set | Tauri signs the bundle without `--deep`, so a nested binary keeps the signature it arrived with. The notary service rejects an ad-hoc one. |
| The sidecar lacks `allow-jit` or `disable-library-validation` | Under the hardened runtime notarisation requires, the first stops V8 from starting and the second stops tree-sitter's addons from loading. See `src-tauri/entitlements-sidecar.plist`. |
| A staged runtime package is missing from `dist-app/node_modules` | A grammar that is not in the bundle fails one file at a time, on a stderr stream the desktop app has nobody reading. The language simply never appears in the graph. |
| The `.app` or `.dmg` is older than this run | The build did not replace it, and you are about to publish last week's. |
| The `.app` has no `Contents/MacOS/node`, or no server under `Contents/Resources/app` | The app opens a window that never gets a port. |
| `codesign --verify --deep --strict` fails | The bundle it just signed is not valid. |
| The signing authority is not `Developer ID Application` | An Apple Development certificate signs only for your own registered devices. |
| The bundle is signed without the hardened runtime | Apple rejects the upload; better to find out before the round trip. |
| `APPLE_NOTARY_PROFILE` is set but `APPLE_SIGNING_IDENTITY` is not | Apple will not notarise an unsigned build. |

It also clears, before building, any read-write disk image left in
`bundle/macos/` by a `bundle_dmg.sh` that died — detaching it first if it is
still mounted. That is scoped to this repository's own path; other disk images
you have mounted are not touched.

---

## The unsigned path

It works, and it is what you get with neither variable set. What it costs:

A file downloaded from the web carries the `com.apple.quarantine` attribute.
macOS refuses to launch an unsigned quarantined app, and the message it shows
is usually *"the application is damaged and can't be opened"* — which is false,
and is what the person sees. The old right-click → Open escape was withdrawn in
macOS 15; what is left in the interface is System Settings → Privacy & Security
→ "Open Anyway". (Apple's change, not measured here — nothing on this machine
was quarantined to test it.) The way past it from a terminal is:

```bash
xattr -dr com.apple.quarantine /Applications/codemaps.app
```

That command belongs on the download page, in those words, next to the link.
`README.md` already carries it as one self-contained block so it can be deleted
in one edit the day a signed build ships.

Measured on the unsigned build of 2026-09-08:

```
$ codesign -dv --verbose=4 codemaps.app
Signature=adhoc          # the Rust linker's, not ours
TeamIdentifier=not set
Sealed Resources=none

$ spctl -a -vvv codemaps.app
code has no resources but signature indicates they must be present

$ spctl -a -vvv -t open --context context:primary-signature codemaps_0.1.0_aarch64.dmg
rejected
source=no usable signature
```

---

## Verifying what you built

Signature and Gatekeeper, on the `.app`:

```bash
APP=src-tauri/target/release/bundle/macos/codemaps.app
codesign -dv --verbose=4 "$APP"          # Authority, TeamIdentifier, runtime flag
codesign --verify --deep --strict "$APP" # silence is a pass
spctl -a -vvv "$APP"
codesign -d --entitlements - "$APP/Contents/MacOS/node"   # the sidecar's three
```

Then that the thing actually runs, out of the disk image rather than out of the
build directory:

```bash
DMG=src-tauri/target/release/bundle/dmg/codemaps_0.1.0_aarch64.dmg
hdiutil attach "$DMG" -mountpoint /tmp/codemaps-dmg -nobrowse -readonly
cp -R /tmp/codemaps-dmg/codemaps.app /tmp/
hdiutil detach /tmp/codemaps-dmg

# CODEMAP_PROJECT skips the folder picker, so this needs no clicking.
CODEMAP_PROJECT=/path/to/any/repo /tmp/codemaps.app/Contents/MacOS/codemaps
```

The sidecar takes an OS-assigned port and writes it to `.claude/codemap.port`
inside the project — but only when that project already has a `.claude/`
directory. With one, this is the whole check:

```bash
PORT=$(cat /path/to/any/repo/.claude/codemap.port)
curl -s "http://127.0.0.1:$PORT/api/project"
curl -s "http://127.0.0.1:$PORT/api/repo"   # `languages.found` proves the grammars loaded
```

`languages.found` is the one worth reading. It is the only check that catches a
grammar pruned out of the bundle by `scripts/prepare-resources.mjs`, because
that failure is silent by construction.

Quitting the app closes the sidecar's stdin, which is what
`--exit-on-stdin-close` listens for, so the sidecar shuts down and removes its
port file. An empty `.claude/` afterwards is the confirmation.

---

## When it goes wrong

**`error running bundle_dmg.sh`, at the very last step.** `CI=true` was not
set. `bundle_dmg.sh` drives Finder through AppleScript to arrange the disk
image window, which needs macOS automation permission; `CI` makes Tauri pass
`--skip-jenkins`, which skips the cosmetics. `release.mjs` sets it. If you are
running `npm run tauri build` by hand, you must.

**The next build fails on a busy image.** The failure above leaves a mounted
`rw.*.dmg` behind. `release.mjs` clears it; by hand it is
`hdiutil detach /dev/diskN` and then deleting the file from `bundle/macos/`.

**notarytool rejects the submission.** Ask what Apple objected to — the
submission id is in the output:

```bash
xcrun notarytool log <submission-id> --keychain-profile "codemaps-notary"
```

The usual answer is a nested binary that is not signed with a Developer ID, or
an executable without the hardened runtime. The nested binary here is the Node
sidecar, and `scripts/prepare-sidecar.mjs` is where its signature is applied —
before Tauri ever copies it into the bundle, because Tauri signs the app bundle
without `--deep` and would leave whatever is already there.

**`Failed to parse entitlements: AMFIUnserializeXML: syntax error`.** An
entitlements plist handed to `codesign` may not contain XML comments. Measured:
with a comment in it, `codesign` exits 1 and leaves the binary signed
`flags=0x0(none)` — no hardened runtime and no entitlements at all, which is a
failure that looks like a success everywhere except in a `codesign -dv` you
thought to run. That is why `src-tauri/entitlements-sidecar.plist` is bare and
the reasoning for each key lives in `scripts/prepare-sidecar.mjs`, and why
`release.mjs` checks the runtime flag as well as the keys.

**The app opens and the window stays empty.** The sidecar did not start. Run
the executable from a terminal, as under *Verifying* above, and read its
stderr — inside a launched `.app` nobody is reading it.

---

## Known limits of this path

Stated rather than smoothed over:

- **The `.dmg` is what gets stapled, not the `.app` inside it.** The signature
  covers both and one notarisation submission covers both, but only the disk
  image carries the ticket in its own bytes. Stapling the `.app` too would need
  a second submission and a disk image built after the staple, which Tauri's
  bundler does not leave room for without rebuilding — and a rebuild replaces
  the `.app` and drops the staple. Not attempted here.
- **The signed path has not been run.** Everything above the signing step was
  measured on 2026-09-08; the signing and notarising branches of `release.mjs`
  are written from Apple's and Tauri's documented behaviour and from reading
  the flags in Tauri's own CLI binary, and have never executed. The first
  signed run should be treated as the test it is.
- **Apple silicon only, and the script only warns.** On an Intel Mac it builds
  an x86_64 artefact and says the published release is not that. It does not
  cross-compile, and there is no universal build.
