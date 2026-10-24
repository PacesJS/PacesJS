import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextVersion } from './next-version.mjs';

test('publishes the package.json version when nothing is on npm yet', () => {
  assert.equal(nextVersion('0.1.0', undefined), '0.1.0');
});

test('bumps the patch when the same minor line is already published', () => {
  assert.equal(nextVersion('0.1.0', '0.1.0'), '0.1.1');
  assert.equal(nextVersion('0.1.0', '0.1.7'), '0.1.8');
});

test('a higher minor in package.json starts a new line at its own version', () => {
  assert.equal(nextVersion('0.2.0', '0.1.7'), '0.2.0');
});

test('a higher major in package.json starts a new line at its own version', () => {
  assert.equal(nextVersion('1.0.0', '0.9.3'), '1.0.0');
});

test('never goes backwards when npm is ahead of package.json', () => {
  assert.equal(nextVersion('0.1.0', '0.3.2'), '0.3.3');
});

test('rejects a version that is not major.minor.patch', () => {
  assert.throws(() => nextVersion('0.1', undefined), /not a plain/);
  assert.throws(() => nextVersion('0.1.0', '1.0.0-beta.1'), /not a plain/);
});
