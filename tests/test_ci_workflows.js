/**
 * The shape of the CI workflows, read line by line (no YAML dependency).
 *
 * c2d07e45 replaced the full suite's pending check, its plan step and the
 * header of its shard job with the per-shard toolchain steps. The steps that
 * read ${{ matrix.shard }} then ran inside the pending job, which has no
 * matrix, so `--shard` got an empty value, the job exited 2 and no shard ran.
 * Nothing checked the workflow itself. This file does, and runs both in the
 * full suite and in its own ci-shape workflow, so an edit to full-suite.yml
 * cannot remove the check that would catch it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, '.github/workflows');

/** Top-level jobs of a workflow: name -> its lines. */
function jobsOf(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  assert.ok(start >= 0, 'no jobs: block');
  const jobs = new Map();
  let name = null;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const head = /^  ([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (head) {
      name = head[1];
      jobs.set(name, []);
    } else if (name) {
      jobs.get(name).push(line);
    }
  }
  return jobs;
}

const workflows = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();

describe('CI workflows', () => {
  it('every job that reads matrix values has a strategy matrix', () => {
    const bad = [];
    for (const f of workflows) {
      for (const [job, lines] of jobsOf(fs.readFileSync(path.join(dir, f), 'utf8'))) {
        const body = lines.join('\n');
        if (/\$\{\{\s*matrix\./.test(body) && !/^\s{4}strategy:\s*$/m.test(body)) bad.push(`${f} ${job}`);
        if (/\$\{\{\s*matrix\./.test(body) && !/^\s{6}matrix:/m.test(body)) bad.push(`${f} ${job} (no matrix)`);
      }
    }
    assert.deepEqual(bad, []);
  });

  it('full-suite checks the pending list, plans the shards and runs every shard', () => {
    const jobs = jobsOf(fs.readFileSync(path.join(dir, 'full-suite.yml'), 'utf8'));
    assert.deepEqual([...jobs.keys()], ['pending', 'shard']);
    const pending = jobs.get('pending').join('\n');
    assert.match(pending, /run: node tests\/ci_shard\.js --check\s*$/m);
    assert.match(pending, /- id: plan\n\s+run: echo "shards=\$\(node tests\/ci_shard\.js --count 16\)" >> "\$GITHUB_OUTPUT"/);
    assert.match(pending, /shards: \$\{\{ steps\.plan\.outputs\.shards \}\}/);
    assert.doesNotMatch(pending, /matrix\./);
    const shard = jobs.get('shard').join('\n');
    assert.match(shard, /^\s{4}needs: pending\s*$/m);
    assert.match(shard, /^\s{6}fail-fast: false\s*$/m);
    assert.match(shard, /shard: \$\{\{ fromJSON\(needs\.pending\.outputs\.shards\) \}\}/);
    assert.match(shard, /node tests\/ci_shard\.js --shard \$\{\{ matrix\.shard \}\} --of 16 > shard\.txt/);
    assert.match(shard, /node tests\/ci_shard_run\.js shard\.txt/);
    assert.doesNotMatch(shard, /node --test --test-concurrency=1 --test-reporter=tap \$\(cat shard\.txt\)/);
    // A skipped or todo test fails the shard.
    assert.match(shard, /every test must run/);
  });

  it('the shape check runs on every pull request in its own workflow', () => {
    const text = fs.readFileSync(path.join(dir, 'ci-shape.yml'), 'utf8');
    assert.match(text, /^\s{2}pull_request:/m);
    assert.match(text, /node --test tests\/test_ci_workflows\.js/);
    assert.doesNotMatch(text, /^\s+paths:/m);
  });
});
