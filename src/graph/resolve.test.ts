import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveImport, resolveModulePath } from './resolve.js';

const files = new Set([
  'index.js',
  'lib/express.js',
  'lib/router/index.js',
  'lib/utils.js',
  'test/app.js',
  'test/res/send.js',
  'src/store.ts',
  'src/index.ts',
]);

test('a specifier naming the root directory resolves to its index', () => {
  // `require('..')` and `require('../')` are how every express test reaches the
  // package; the first normalises to `.` and the second to `./`, and neither
  // is a file.
  assert.equal(resolveImport('test/app.js', '..', files), 'index.js');
  assert.equal(resolveImport('test/app.js', '../', files), 'index.js');
  assert.equal(resolveImport('test/res/send.js', '../..', files), 'index.js');
  assert.equal(resolveImport('test/res/send.js', '../../', files), 'index.js');
});

test('a specifier naming a directory resolves to its index, from anywhere', () => {
  assert.equal(resolveImport('lib/express.js', './router', files), 'lib/router/index.js');
  assert.equal(resolveImport('lib/express.js', './router/', files), 'lib/router/index.js');
  assert.equal(resolveImport('lib/router/index.js', './', files), 'lib/router/index.js');
  assert.equal(resolveImport('lib/router/index.js', '.', files), 'lib/router/index.js');
});

test('a trailing slash means the directory, never a file of that name', () => {
  // `lib/utils.js` exists, but `./utils/` can only mean `lib/utils/index.*`.
  assert.equal(resolveImport('lib/express.js', './utils', files), 'lib/utils.js');
  assert.equal(resolveImport('lib/express.js', './utils/', files), null);
});

test('a file beats a directory of the same name, and TypeScript beats JavaScript', () => {
  assert.equal(resolveImport('lib/express.js', './utils', files), 'lib/utils.js');
  assert.equal(resolveModulePath('src', files), 'src/index.ts');
  assert.equal(resolveModulePath('src/store.js', files), 'src/store.ts');
});

test('a bare specifier is not a path', () => {
  assert.equal(resolveImport('test/app.js', 'supertest', files), null);
  assert.equal(resolveImport('test/app.js', 'node:fs', files), null);
});

test('a directory with no index resolves to nothing rather than to a neighbour', () => {
  assert.equal(resolveImport('test/app.js', './res', files), null);
  assert.equal(resolveImport('test/app.js', '../lib', files), null);
});
