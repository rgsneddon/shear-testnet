import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The live docs (27 Oct, BluNotes rename) call the round page DINS and the
// navbar item BluNotes (BLU, blunote.shear.digital). A deploy from this tree
// must not bring back the DINS-DAG or DAG names; the old #/dins-dag link keeps
// working through one alias.
const here = path.dirname(fileURLToPath(import.meta.url));
const content = fs.readFileSync(path.join(here, '../docs/content.js'), 'utf8');

describe('docs content keeps the BluNotes rename', () => {
  it('no DINS-DAG or DAG name and no dag.shear.digital link comes back', () => {
    assert.doesNotMatch(content, /DINS-DAG/);
    assert.doesNotMatch(content, /\bDAG\b/);
    assert.doesNotMatch(content, /dag\.shear\.digital/);
  });

  it('the round page is DINS, the navbar item is BluNotes (BLU), and #/dins-dag is only an alias', () => {
    assert.match(content, /\{ id: 'dins', title: 'DINS' \}/);
    assert.match(content, /P\['dins'\] = \{\n\s+title: 'DINS',/);
    assert.match(content, /DINS<\/a> \(Deterministic In-Node Shares\)/);
    assert.match(content, /BluNotes \(BLU\)/);
    const mentions = content.match(/dins-dag/g) || [];
    assert.equal(mentions.length, 2, 'the alias and its comment only');
    assert.match(content, /P\['dins-dag'\] = P\['dins'\];/);
  });
});
