import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isTestFile } from './tests.js';

test('every convention in the list is recognised by the path alone', () => {
  for (const file of [
    'src/view/lanes.test.ts',
    'src/app.spec.js',
    'web/src/Button.stories.tsx',
    'cobra/command_test.go',
    'test/app.js',
    'test/acceptance/auth.js',
    'src/__tests__/useQuery.tsx',
    'packages/query-core/src/__tests__/utils.ts',
    'src/test/java/com/example/AppTest.java',
    'tests/integration.rs',
    'src/main/java/AppTest.java',
    'src/main/java/AppTests.java',
    'Project.Tests/ThingTests.cs',
    'src/lib/tests.rs',
    'internal/testdata/golden.go',
    'src/__tests__/fixtures/react-query.ts',
    'fixtures/sample.ts',
  ]) {
    assert.equal(isTestFile(file), true, file);
  }
});

test('source that merely mentions the word is not a test', () => {
  for (const file of [
    'src/view/lanes.ts',
    'src/testing-library.ts',
    'src/contest/index.ts',
    'lib/tester.go',
    'src/main/java/com/example/Testament.java',
    'src/attest.rs',
    'src/fixture-loader.ts',
    'src/storybook.ts',
    'test.ts',
    'spec.js',
    'src/latest/app.ts',
  ]) {
    assert.equal(isTestFile(file), false, file);
  }
});
