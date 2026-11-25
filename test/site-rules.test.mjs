import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, resolveRule, domainRule, ruleMatches } from '../extension/site-rules.js';

test('a parent domain rule applies to dated subdomains and the root, without matching lookalikes', () => {
  const rules = { 'https://new-deaf.one': { ...DEFAULT_SETTINGS, enabled: true, rangeDb: 10 } };
  for (const host of ['new-deaf.one', '15nov.new-deaf.one', '16nov.new-deaf.one']) {
    const result = resolveRule(`https://${host}`, rules);
    assert.equal(result.domain, 'new-deaf.one');
    assert.equal(result.settings.enabled, true);
    assert.equal(result.settings.rangeDb, 10);
  }
  for (const host of ['evilnew-deaf.one', 'new-deaf.one.example.com']) assert.equal(resolveRule(`https://${host}`, rules).settings.enabled, false);
});

test('existing per-origin choices are retained and gain new timing defaults', () => {
  const result = resolveRule('https://15nov.new-deaf.one', { 'https://15nov.new-deaf.one': { enabled: true, rangeDb: 9 } });
  assert.deepEqual(result.settings, { ...DEFAULT_SETTINGS, enabled: true, rangeDb: 9 });
  assert.equal(result.domain, '15nov.new-deaf.one');
});

test('more specific rules win; unrelated schemes and ports retain their own settings', () => {
  const rules = {
    'https://new-deaf.one': { ...DEFAULT_SETTINGS, enabled: true, rangeDb: 10 },
    'https://15nov.new-deaf.one': { ...DEFAULT_SETTINGS, rangeDb: 8 }
  };
  assert.equal(resolveRule('https://15nov.new-deaf.one', rules).settings.rangeDb, 8);
  assert.equal(resolveRule('https://16nov.new-deaf.one', rules).settings.rangeDb, 10);
  assert.equal(ruleMatches('http://15nov.new-deaf.one', 'https://new-deaf.one'), false);
  assert.equal(ruleMatches('https://15nov.new-deaf.one:8443', 'https://new-deaf.one'), false);
});

test('editable domains are normalized and must belong to the current site', () => {
  assert.equal(domainRule(' New-Deaf.ONE ', 'https://15nov.new-deaf.one'), 'https://new-deaf.one');
  assert.equal(domainRule('localhost', 'http://localhost:4321'), 'http://localhost:4321');
  for (const input of ['', '*.new-deaf.one', 'example.com', 'new-deaf.one/path', 'user@new-deaf.one']) assert.throws(() => domainRule(input, 'https://15nov.new-deaf.one'));
});
