/**
 * R18a mainnet host files (deploy/mainnet). The units never restart by
 * themselves, copy a datadir or tip.json, phone home or name a host IP; each
 * firewall opens exactly TCP 22, 80, 443, 1111 and 30303 (8080 closed,
 * Russell 26 Oct); every script that changes a host is a dry run unless told
 * otherwise; and teardown and check_host behave on fixtures. Nothing here
 * runs on a host (Russell 26 Oct: no wipe, rebuild or deploy without his GO).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = new URL('../deploy/mainnet/', import.meta.url);
const file = (p) => fileURLToPath(new URL(p, dir));
const read = (p) => fs.readFileSync(new URL(p, dir), 'utf8').replace(/\r/g, '');
const PORTS = ['22', '80', '443', '1111', '30303'];
const UNITS = ['shear-node.service', 'shear-p2p.service', 'shear-pool.service'];
const keysOf = (unit) => unit.split('\n').filter((l) => /^[A-Za-z]+=/.test(l));
const val = (keys, name) => keys.find((l) => l.startsWith(`Environment=${name}=`))?.split('=')[2];

function bash(args, env = {}) {
  const e = { ...process.env, ...env };
  delete e.SHEAR_TEARDOWN_GO;
  return spawnSync('bash', args, { encoding: 'utf8', env: { ...e, ...env } });
}

describe('mainnet host files', () => {
  for (const name of UNITS) {
    it(`${name}: no self-restart, no copies, no phone-home, no host IP`, () => {
      const keys = keysOf(read(`units/${name}`));
      assert.deepEqual(keys.filter((l) => l.startsWith('Restart')), ['Restart=no']);
      assert.equal(keys.some((l) => /^(OnFailure|StartLimitAction|FailureAction)=/.test(l)), false, 'no recovery hook');
      const execs = keys.filter((l) => /^Exec/.test(l));
      assert.deepEqual(execs.map((l) => l.split('=')[0]), ['ExecStart'], 'one ExecStart, no pre or post step');
      assert.equal(/\b(cp|rsync|curl|wget|scp)\b|tip\.json|https?:|bootstrap/.test(execs.join('\n')), false, 'no copy, fetch or bootstrap');
      assert.equal(keys.some((l) => /BOOTSTRAP/.test(l)), false, 'no bootstrap setting (roadmap rule 12)');
      const ips = keys.join('\n').match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) || [];
      assert.deepEqual(ips.filter((ip) => ip !== '127.0.0.1' && ip !== '0.0.0.0'), [], 'no host IP');
      const seeds = val(keys, 'SHEAR_SEEDS');
      if (seeds) for (const s of seeds.split(',')) assert.match(s, /^[a-z0-9.-]+\.shear\.digital:30303$/, s);
      assert.equal(val(keys, 'SHEAR_NETWORK'), 'shear-v1', 'mainnet book');
      assert.ok(keys.includes('User=shear') && keys.includes('ProtectSystem=strict') && keys.includes('ProtectHome=yes'));
      // The datadir and the seal key dir are its StateDirectory, nothing else is writable.
      assert.equal(keys.some((l) => l.startsWith('ReadWritePaths=')), false);
      const state = keys.find((l) => l.startsWith('StateDirectory=')).split('=')[1].split(' ').map((d) => `/var/lib/${d}`);
      assert.deepEqual(state, [val(keys, 'SHEAR_DATA'), val(keys, 'SHEAR_SEAL_KEY_DIR')]);
      assert.equal(keys.some((l) => /^(MemoryMax|MemoryHigh|OOMPolicy)=/.test(l)), false, 'no unmeasured memory cap');
    });
  }

  it('each unit has its own datadir and seal keys', () => {
    const dirs = UNITS.flatMap((u) => { const k = keysOf(read(`units/${u}`)); return [val(k, 'SHEAR_DATA'), val(k, 'SHEAR_SEAL_KEY_DIR')]; });
    assert.equal(new Set(dirs).size, dirs.length);
  });

  it('only the p2p units bind :30303; the pool needs its node running and stratum TLS', () => {
    assert.match(read('units/shear-node.service'), /^Environment=SHEAR_P2P_PORT=30303$/m);
    assert.match(read('units/shear-p2p.service'), /^Environment=SHEAR_P2P_PORT=30303$/m);
    const pool = read('units/shear-pool.service');
    assert.doesNotMatch(pool, /SHEAR_P2P_PORT/);
    assert.match(pool, /^Environment=SHEAR_P2P_IPC=127\.0\.0\.1:30313$/m);
    assert.match(pool, /^Requisite=shear-p2p\.service$/m);
    assert.match(pool, /^PartOf=shear-p2p\.service$/m);
    assert.doesNotMatch(pool, /^Requires=/m, 'starting the pool never starts the node');
    assert.match(pool, /^Environment=SHEAR_STRATUM_REQUIRE_TLS=1$/m);
    assert.match(pool, /^Environment=SHEAR_STRATUM_TLS_CERT=\/etc\/shear\/stratum-tls\/fullchain\.pem$/m);
    assert.doesNotMatch(pool, /LAB_CLEARTEXT/);
    assert.match(pool, /^EnvironmentFile=\/etc\/shear\/pool\.env$/m);
    assert.doesNotMatch(pool, /SPEND_SEED|SPEND_KEY|AUTH_PUB=/, 'no secret or operator key in the unit');
  });

  it('each firewall opens exactly the five ports, TCP only, and 8080 is closed', () => {
    for (const f of ['firewall/ufw-pool.sh', 'firewall/firewalld-p2p-b.sh']) {
      assert.match(read(f), /^PORTS="22 80 443 1111 30303"$/m, f);
    }
    const ufw = read('firewall/ufw-pool.sh');
    assert.ok(ufw.indexOf('ufw --force reset') < ufw.indexOf('ufw allow'), 'reset before the rules');
    assert.match(ufw, /IPV6=yes/);
    const fwd = read('firewall/firewalld-p2p-b.sh');
    for (const m of ['--remove-service=', '--remove-rich-rule=', '--remove-source-port=', '--remove-protocol=', '--change-interface=', '--set-target=DROP', '--add-protocol=ipv6-icmp']) assert.ok(fwd.includes(m), m);
    const nft = read('firewall/nftables-p2p-a.conf');
    assert.match(nft, /policy drop;/);
    const dports = [...nft.matchAll(/dport \{([^}]*)\}/g)].map((m) => m[1].split(',').map((p) => p.trim()));
    assert.deepEqual(dports, [PORTS]);
    assert.equal(/udp dport/.test(nft), false);
    for (const f of ['firewall/ufw-pool.sh', 'firewall/firewalld-p2p-b.sh', 'firewall/nftables-p2p-a.conf', 'scripts/check_host.sh']) {
      assert.equal(/\b8080\b/.test(read(f).replace(/^#.*$/gm, '')), false, `${f} has no 8080`);
    }
  });

  it('every script that changes a host is a dry run unless told', () => {
    for (const f of ['firewall/ufw-pool.sh', 'firewall/firewalld-p2p-b.sh', 'scripts/teardown.sh']) {
      const text = read(f);
      assert.match(text, /^apply=0; \[ "\$\{1:-\}" = "--apply" \] && apply=1$/m, f);
      assert.match(text, /if \[ \$apply = 1 \]; then "\$@"; else echo "would run: \$\*"; fi/, f);
    }
    for (const f of ['scripts/inventory.sh', 'scripts/check_host.sh']) {
      assert.equal(/\b(rm|systemctl (stop|disable|enable|start|restart)|ufw (allow|reset|enable)|firewall-cmd --permanent --zone="\$z" --(add|remove))\b/.test(read(f)), false, `${f} is read-only`);
    }
  });

  it('teardown refuses --apply without this host\'s GO token, before it touches anything', () => {
    const got = bash([file('scripts/teardown.sh'), '--apply']);
    assert.equal(got.status, 1);
    assert.match(got.stdout, /^refused: --apply needs SHEAR_TEARDOWN_GO=/);
    assert.equal(/would run|rm -rf/.test(got.stdout), false);
    const host = spawnSync('hostname', { encoding: 'utf8' }).stdout.trim();
    const fixture = bash([file('scripts/teardown.sh'), '--apply'], { SHEAR_TEARDOWN_GO: host, SHEAR_TEARDOWN_ROOT: os.tmpdir() });
    assert.equal(fixture.status, 1, 'never --apply on a fixture root');
    assert.match(fixture.stdout, /refused: --apply with a fixture root/);
  });

  it('teardown on a fixture tree lists every test leftover, keeps renewal hooks, and reaches the end', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teardown-'));
    const mk = (p, body = '') => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), body); };
    mk('root/claude-ci/lane1.txt'); mk('var/lib/shear/testnet-v12/chain.bin'); mk('var/lib/shear/mainnet/chain.bin');
    mk('root/.shear/book-seal-keys/k'); mk('home/ubuntu/.shear/x'); mk('opt/shear/node/src/node.js'); mk('opt/shear-v4/x');
    mk('etc/systemd/system/shear-node.service'); mk('etc/cron.d/claude-lanes', '0 * * * * root bash /root/claude-ci/fullhead.sh');
    mk('etc/cron.d/certbot', '0 */12 * * * root certbot renew --deploy-hook /etc/shear/hook # shear.digital');
    mk('root/test.shewall'); mk('var/log/shear-node.log');
    const got = bash([file('scripts/teardown.sh')], { SHEAR_TEARDOWN_ROOT: root });
    assert.equal(got.status, 0, got.stderr + got.stdout);
    for (const p of ['root/claude-ci', 'var/lib/shear/testnet-v12', 'var/lib/shear/mainnet', 'root/.shear', 'home/ubuntu/.shear',
      'opt/shear', 'opt/shear-v4', 'etc/systemd/system/shear-node.service', 'etc/cron.d/claude-lanes', 'root/test.shewall', 'var/log/shear-node.log']) {
      assert.ok(got.stdout.includes(`would run: rm -${p.startsWith('etc/cron.d') ? 'f' : 'rf'} ${root}/${p}\n`), p);
    }
    assert.equal(got.stdout.includes(`rm -f ${root}/etc/cron.d/certbot`), false, 'a renewal hook is never removed');
    assert.ok(got.stdout.includes(`check by hand (names shear): ${root}/etc/cron.d/certbot`));
    assert.match(got.stdout, /teardown dry run, nothing changed on /);
    assert.ok(fs.existsSync(path.join(root, 'root/claude-ci/lane1.txt')), 'a dry run removes nothing');
  });

  it('check_host --unit-file passes the shipped units and fails the bad ones', () => {
    for (const u of UNITS) {
      const got = bash([file('scripts/check_host.sh'), '--unit-file', file(`units/${u}`)]);
      assert.equal(got.status, 0, `${u}: ${got.stdout}`);
      assert.match(got.stdout, /PASS$/m);
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'units-'));
    const base = read('units/shear-node.service');
    const cases = {
      restarts: [base.replace('\nRestart=no\n', '\nRestart=always\n'), /restarts by itself/],
      copies: [base.replace('ExecStart=', 'ExecStartPre=/bin/cp /backup/tip.json /var/lib/shear/mainnet/\nExecStart='), /Exec step other than one ExecStart|copies or fetches/],
      ip: [base.replace('p2p.shear.digital:30303', '157.180.70.110:30303'), /names a host IP/],
      hook: [base.replace('\nRestart=no\n', '\nRestart=no\nOnFailure=recover.service\n'), /failure hook/],
    };
    for (const [name, [text, why]] of Object.entries(cases)) {
      assert.notEqual(text, base, `${name} fixture changed the unit`);
      const f = path.join(tmp, `${name}.service`);
      fs.writeFileSync(f, text);
      const got = bash([file('scripts/check_host.sh'), '--unit-file', f]);
      assert.equal(got.status, 1, name);
      assert.match(got.stdout, why, name);
    }
  });

  it('check_host knows the three roles, their OSes and the five ports', () => {
    const text = read('scripts/check_host.sh');
    assert.match(text, /pool\) +os=ubuntu; units="shear-p2p\.service shear-pool\.service"/);
    assert.match(text, /p2p-a\) os=debian; units="shear-node\.service"/);
    assert.match(text, /p2p-b\) os=fedora; units="shear-node\.service"/);
    assert.match(text, /" 22 80 443 1111 30303 "/);
    assert.match(text, /systemctl show -p Restart --value/);
    assert.match(text, /ss -tulnH/);
    assert.equal(bash([file('scripts/check_host.sh'), 'nope']).status, 2);
  });

  it('the runbook gates every host change on a GO and records the rulings', () => {
    const rb = read('RUNBOOK.md');
    assert.match(rb, /Status: \*\*prepared, not run\.\*\*/);
    assert.match(rb, /p2p-b first, then p2p-a, then the pool/);
    assert.match(rb, /\*\*Port 8080 is closed\*\*/);
    assert.match(rb, /\*\*Bootstrap publisher:\*\* left out/);
    for (const step of ['Reinstall', 'Firewall', 'Install', 'Verify, don\'t paint']) assert.ok(rb.includes(step), step);
  });
});
