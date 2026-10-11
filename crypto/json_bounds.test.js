import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JSON_MAX_DEPTH, jsonNestingOk, parseBoundedJson } from './json_bounds.js';

describe('json bounds', () => {
  it('accepts a flat object and rejects a nest past the cap', () => {
    assert.equal(jsonNestingOk('{"a":1,"b":[2]}'), true);
    assert.equal(parseBoundedJson('{"ok":true}').ok, true);
    const deep = `${'['.repeat(JSON_MAX_DEPTH + 1)}${']'.repeat(JSON_MAX_DEPTH + 1)}`;
    assert.equal(jsonNestingOk(deep), false);
    assert.throws(() => parseBoundedJson(deep), (err) => err.code === 'json_cap');
    const edge = `${'['.repeat(JSON_MAX_DEPTH)}${']'.repeat(JSON_MAX_DEPTH)}`;
    assert.equal(jsonNestingOk(edge), true);
    assert.equal(jsonNestingOk('{"s":"[[[]]"}'), true);
    assert.equal(jsonNestingOk('{"s":"\\""}'), true);
  });
});
