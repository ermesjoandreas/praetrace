import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HOOK_COMMAND, isCurrentHook } from './hook-install.js';

/** What this repository's own settings.json held before the endpoint answered. */
const DISCARDING =
  'P="${CLAUDE_PROJECT_DIR:-.}/.claude/codemap.port"; [ -f "$P" ] && ' +
  'curl -s -m 2 -X POST "http://127.0.0.1:$(cat "$P")/api/hook" ' +
  "-H 'content-type: application/json' --data-binary @- >/dev/null 2>&1; true";

/** And what it held before the port file existed at all. */
const BAKED_IN_PORT =
  "curl -s -m 2 -X POST http://127.0.0.1:4400/api/hook -H 'content-type: application/json' --data-binary @-";

test('our own command passes our own recogniser', () => {
  // The one that matters. These are the same decision written twice, and when
  // they drift every install reads as current while no answer ever arrives.
  assert.equal(isCurrentHook(HOOK_COMMAND), true);
});

test('a hook that throws the answer away is offered the upgrade', () => {
  // It finds the port, reaches the server and discards what it says, which is
  // indistinguishable from not being installed for everything downstream.
  assert.equal(isCurrentHook(DISCARDING), false);
  assert.equal(isCurrentHook(`${HOOK_COMMAND.replace('2>/dev/null', '')} >/dev/null`), false);
  assert.equal(isCurrentHook(`${HOOK_COMMAND.replace('2>/dev/null', '')} &>/dev/null`), false);
  assert.equal(isCurrentHook(`${HOOK_COMMAND.replace('2>/dev/null', '')} 1> /dev/null`), false);
});

test('silencing stderr alone is not throwing the answer away', () => {
  // `2>` is the channel nobody reads; the current command uses it, and a
  // recogniser that could not tell it from `>` would reject every install.
  assert.equal(isCurrentHook('curl -f "$(cat .claude/codemap.port)" 2>/dev/null'), true);
});

test('a hook that would print an error body is offered the upgrade', () => {
  // /api/hook answers 200 on purpose, but Fastify answers before the route
  // does — 413 over its 1 MiB body limit, 415 on a content-type it will not
  // parse — and curl prints that JSON on the one channel Claude Code reads the
  // hook's answer from. So an Edit large enough would put `{"statusCode":413}`
  // into the agent's context wearing the graph's voice.
  assert.equal(isCurrentHook(HOOK_COMMAND.replace('-sf', '-s')), false);
  // The flag that keeps the body is not the flag that suppresses it.
  assert.equal(isCurrentHook(HOOK_COMMAND.replace('-sf', '-s --fail-with-body')), false);
  // Spelled long, or unbundled, it is the same flag.
  assert.equal(isCurrentHook(HOOK_COMMAND.replace('-sf', '-s --fail')), true);
  assert.equal(isCurrentHook(HOOK_COMMAND.replace('-sf', '-s -f')), true);
});

test("the shell's own file test is not curl's fail flag", () => {
  // `[ -f "$P" ]` opens our command three tokens before curl is named, so a
  // pattern that looked anywhere in the line would vouch for every hook ever
  // written — including the one this flag exists to replace.
  assert.equal(isCurrentHook(HOOK_COMMAND.replace('-sf', '-s')), false);
  assert.equal(isCurrentHook('[ -f "$P" ] && curl -s "$(cat .claude/codemap.port)"'), false);
});

test('a hook naming a port is not a hook that can find one', () => {
  assert.equal(isCurrentHook(BAKED_IN_PORT), false);
});
