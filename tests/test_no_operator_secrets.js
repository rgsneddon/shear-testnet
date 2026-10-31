import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { namesOperatorHost } from './operator_host.js';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('no operator secrets in the public tree', () => {
  it('never ships the operator admin hostname, in any tracked file, these tests included', () => {
    const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
    assert.ok(files.length > 100, 'the tracked tree');
    const hits = [];
    for (const rel of files) {
      let buf;
      try {
        buf = fs.readFileSync(path.join(root, rel));
      } catch {
        continue;
      }
      if (buf.length > 4 * 1024 * 1024 || buf.includes(0)) continue;
      if (namesOperatorHost(buf.toString('utf8'))) hits.push(rel);
    }
    assert.deepEqual(hits, [], `operator hostname leaked: ${hits.join(', ')}`);
  });

  it('the hostname check is a salted hash and does not fire on public names', () => {
    const { salt } = JSON.parse(fs.readFileSync(path.join(root, 'tests/operator_host.json'), 'utf8'));
    assert.match(salt, /^[0-9a-f]{32}$/);
    assert.equal(namesOperatorHost('server_name mypool.site; admin at pool.shear.digital'), false);
    assert.equal(namesOperatorHost(''), false);
  });

  it('.gitignore keeps an untracked operator vhost out of git; every tracked public vhost stays in', () => {
    const ignored = (rel) => spawnSync('git', ['check-ignore', '--no-index', '-q', rel], { cwd: root }).status === 0;
    for (const probe of ['deploy/nginx-operator-example.shear.digital.conf', 'deploy/nginx-desk.example.org.conf', 'deploy/nginx-ops-admin.conf']) {
      assert.equal(ignored(probe), true, `${probe} would be committable`);
    }
    const vhosts = execFileSync('git', ['ls-files', '--', 'deploy/nginx-*.conf'], { cwd: root, encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
    assert.ok(vhosts.length >= 5, 'the public vhosts');
    for (const rel of vhosts) assert.equal(ignored(rel), false, `${rel} is public and must stay re-included`);
  });

  it('DEFAULT_SEEDS is hostname only; node --help names the seed host', () => {
    const src = fs.readFileSync(path.join(root, 'node/src/node.js'), 'utf8');
    assert.match(src, /p2p\.shear\.digital:30303/);
    assert.doesNotMatch(src, /46\.224\.132\.83/);
    assert.doesNotMatch(src, /77\.42\.91\.84/);
    assert.doesNotMatch(src, /157\.180\.70\.110/);
    assert.doesNotMatch(src, /2\.28\.8\.89/);
    assert.doesNotMatch(src, /178\.105\.187\.178/);
    assert.doesNotMatch(src, /178\.156\.222\.223/);
    const r = spawnSync(process.execPath, ['node/src/node.js', '--help'], { cwd: root, encoding: 'utf8', timeout: 20000 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /SHEAR_DATA/);
    assert.match(r.stdout, /clock_wait/);
    assert.match(r.stdout, /p2p\.shear\.digital:30303/);
  });
});
