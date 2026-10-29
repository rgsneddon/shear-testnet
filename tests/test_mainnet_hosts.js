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
const MAINNET_UNITS = ['shear-node.service', 'shear-p2p.service', 'shear-pool.service'];
const V12_UNITS = MAINNET_UNITS.map((u) => u.replace('shear-', 'shear-v12-'));
const UNITS = [...MAINNET_UNITS, ...V12_UNITS];
const NETWORK = (u) => (u.startsWith('shear-v12-') ? 'shear-testnet-v12' : 'shear-v1');
const keysOf = (unit) => unit.split('\n').filter((l) => /^[A-Za-z]+=/.test(l));
const val = (keys, name) => keys.find((l) => l.startsWith(`Environment=${name}=`))?.split('=')[2];

function bash(args, env = {}) {
  const e = { ...process.env, ...env };
  delete e.SHEAR_TEARDOWN_GO;
  return spawnSync('bash', args, { encoding: 'utf8', env: { ...e, ...env }, timeout: 60_000 });
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
      assert.equal(val(keys, 'SHEAR_NETWORK'), NETWORK(name), 'its book');
      assert.ok(keys.includes('User=shear') && keys.includes('ProtectSystem=strict') && keys.includes('ProtectHome=yes'));
      // The datadir and the seal key dir are its StateDirectory, nothing else is writable.
      assert.equal(keys.some((l) => l.startsWith('ReadWritePaths=')), false);
      const state = keys.find((l) => l.startsWith('StateDirectory=')).split('=')[1].split(' ').map((d) => `/var/lib/${d}`);
      assert.deepEqual(state, [val(keys, 'SHEAR_DATA'), val(keys, 'SHEAR_SEAL_KEY_DIR')]);
      assert.equal(keys.some((l) => /^(MemoryMax|MemoryHigh|OOMPolicy)=/.test(l)), false, 'no unmeasured memory cap');
    });
  }

  const HARDENING = ['StateDirectoryMode=0700', 'UMask=0077', 'CapabilityBoundingSet=', 'AmbientCapabilities=', 'NoNewPrivileges=yes',
    'PrivateTmp=yes', 'PrivateDevices=yes', 'ProtectSystem=strict', 'ProtectHome=yes', 'ProtectKernelTunables=yes',
    'ProtectKernelModules=yes', 'ProtectKernelLogs=yes', 'ProtectControlGroups=yes', 'ProtectClock=yes', 'ProtectHostname=yes',
    'ProtectProc=invisible', 'RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX', 'RestrictNamespaces=yes', 'RestrictRealtime=yes',
    'RestrictSUIDSGID=yes', 'LockPersonality=yes', 'RemoveIPC=yes', 'SystemCallArchitectures=native',
    'SystemCallFilter=@system-service', 'SystemCallErrorNumber=EPERM'];
  for (const name of UNITS) {
    it(`${name}: systemd hardening, state 0700, and no MemoryDenyWriteExecute (V8 JIT)`, () => {
      const keys = keysOf(read(`units/${name}`));
      for (const k of HARDENING) assert.ok(keys.includes(k), `${name} has ${k}`);
      assert.equal(keys.some((l) => l.startsWith('MemoryDenyWriteExecute')), false, 'node needs W^X off for its JIT');
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
    // TLS only on mainnet (Russell 26 Oct): the lab cleartext flag is never set.
    assert.doesNotMatch(pool.replace(/^#.*$/gm, ''), /LAB_CLEARTEXT/);
    assert.match(pool, /^EnvironmentFile=\/etc\/shear\/pool\.env$/m);
    assert.doesNotMatch(pool, /SPEND_SEED|SPEND_KEY|AUTH_PUB=/, 'no secret or operator key in the unit');
  });

  it('the v12 testnet units mirror the mainnet ones, on their own book, state and release tree', () => {
    for (const name of MAINNET_UNITS) {
      const v12name = name.replace('shear-', 'shear-v12-');
      const strip = (t) => keysOf(t).filter((l) => !/^(Description|Environment=SHEAR_(NETWORK|DATA|SEAL_KEY_DIR)|StateDirectory|WorkingDirectory|EnvironmentFile|Requisite|PartOf|After)=/.test(l));
      assert.deepEqual(strip(read(`units/${v12name}`)), strip(read(`units/${name}`)), `${v12name} differs from ${name} only in book, paths and its pair`);
      const k = keysOf(read(`units/${v12name}`));
      assert.ok(k.includes('WorkingDirectory=/opt/shear-v12'), v12name);
      assert.match(val(k, 'SHEAR_DATA'), /^\/var\/lib\/shear\/testnet-v12(-p2p|-pool)?$/, v12name);
      assert.match(val(k, 'SHEAR_SEAL_KEY_DIR'), /^\/var\/lib\/shear\/seal-keys-v12\/(node|p2p|pool)$/, v12name);
    }
    const pool = read('units/shear-v12-pool.service');
    assert.match(pool, /^Requisite=shear-v12-p2p\.service$/m);
    assert.match(pool, /^PartOf=shear-v12-p2p\.service$/m);
    assert.match(pool, /^EnvironmentFile=\/etc\/shear\/pool-v12\.env$/m);
    // The mainnet units are installed but stay off until the genesis GO.
    assert.match(read('RUNBOOK.md'), /systemctl enable --now shear-v12-/);
    assert.doesNotMatch(read('RUNBOOK.md'), /systemctl enable --now shear-(node|p2p|pool)\.service[^\n]*before genesis/);
  });

  it('each firewall opens only its role\'s ports, TCP only, rate limits SSH, and 8080 is closed', () => {
    // The pool serves the site and stratum; p2p-a and p2p-b only SSH and :30303.
    const ufw = read('firewall/ufw-pool.sh');
    assert.match(ufw, /^PORTS="80 443 1111 30303"$/m);
    assert.match(ufw, /run ufw limit 22\/tcp/);
    assert.ok(ufw.indexOf('ufw --force reset') < ufw.indexOf('ufw limit 22/tcp'), 'reset before the rules');
    assert.ok(ufw.indexOf('ufw limit 22/tcp') < ufw.indexOf('ufw allow'), '22 first');
    assert.ok(ufw.indexOf('ufw limit 22/tcp') < ufw.indexOf('ufw --force enable'), '22 before enable');
    assert.match(ufw, /IPV6=yes/);
    const fwd = read('firewall/firewalld-p2p-b.sh');
    assert.match(fwd, /^PORTS="30303"$/m);
    for (const m of ['--remove-service=', '--remove-rich-rule=', '--remove-source-port=', '--remove-protocol=', '--change-interface=', '--set-target=DROP', '--add-protocol=ipv6-icmp']) assert.ok(fwd.includes(m), m);
    for (const fam of ['ipv4', 'ipv6']) assert.ok(fwd.includes(`rule family="${fam}" service name="ssh" accept limit value="10/m"`), `ssh limit ${fam}`);
    assert.ok(fwd.indexOf('--add-port=22/tcp') < fwd.indexOf('--remove-port=22/tcp'), 'plain 22 opened first, dropped once the limited rule is in');
    assert.ok(fwd.indexOf('--remove-port=22/tcp') < fwd.indexOf('firewall-cmd --reload'));
    // A blank rich-rule line must not end the script under set -e.
    assert.match(fwd, /while IFS= read -r r; do if \[ -n "\$r" \]; then run firewall-cmd .*--remove-rich-rule="\$r"; fi; done/);
    const nft = read('firewall/nftables-p2p-a.conf');
    assert.match(nft, /policy drop;/);
    const dports = [...nft.matchAll(/dport \{([^}]*)\}/g)].map((m) => m[1].split(',').map((p) => p.trim()));
    assert.deepEqual(dports, [['22', '30303']]);
    assert.match(nft, /tcp dport 22 ct state new add @ssh4 \{ ip saddr limit rate over 10\/minute burst 5 packets \} drop/);
    assert.match(nft, /tcp dport 22 ct state new add @ssh6 \{ ip6 saddr limit rate over 10\/minute burst 5 packets \} drop/);
    assert.ok(nft.indexOf('@ssh4') < nft.indexOf('tcp dport { 22, 30303 } accept'), 'the limit comes before the accept');
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
    // Never pass a token that could match the machine running the tests.
    const token = `not-a-host-${process.pid}-${Date.now()}`;
    const got = bash([file('scripts/teardown.sh'), '--apply'], { SHEAR_ROLE: 'p2p-a', SHEAR_TEARDOWN_GO: token });
    assert.equal(got.status, 1);
    assert.match(got.stdout, /^refused: --apply needs SHEAR_TEARDOWN_GO=/m);
    assert.equal(/would run|rm -rf/.test(got.stdout), false);
    const fixture = bash([file('scripts/teardown.sh'), '--apply'], { SHEAR_TEARDOWN_GO: token, SHEAR_TEARDOWN_ROOT: os.tmpdir() });
    assert.equal(fixture.status, 1, 'never --apply on a fixture root');
    assert.match(fixture.stdout, /^refused: --apply with a fixture root/, 'the fixture refusal comes before any token check');
    assert.doesNotMatch(read('../../tests/test_mainnet_hosts.js'), new RegExp(`${'SHEAR_TEARDOWN_GO'}: ${'host'}\\b`), 'no test passes the real hostname as a GO token');
  });

  it('teardown on a fixture tree lists every test leftover, keeps renewal hooks, and reaches the end', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teardown-'));
    const mk = (p, body = '') => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), body); };
    mk('root/claude-ci/lane1.txt'); mk('var/lib/shear/testnet-v12/chain.bin'); mk('var/lib/shear/mainnet/chain.bin');
    mk('root/.shear/book-seal-keys/k'); mk('home/ubuntu/.shear/x'); mk('opt/shear/node/src/node.js'); mk('opt/shear-v4/x');
    mk('etc/systemd/system/shear-node.service'); mk('etc/cron.d/claude-lanes', '0 * * * * root bash /root/claude-ci/fullhead.sh');
    mk('etc/cron.d/certbot', '0 */12 * * * root certbot renew --deploy-hook /etc/shear/hook # shear.digital');
    mk('root/test.shewall'); mk('var/log/shear-node.log');
    const got = bash([file('scripts/teardown.sh')], { SHEAR_TEARDOWN_ROOT: root, SHEAR_ROLE: 'p2p-a', SHEAR_TEARDOWN_HOSTNAME: 'p2p-a' });
    assert.equal(got.status, 0, got.stderr + got.stdout);
    assert.equal(got.stdout.includes(`rm -rf ${root}/var/lib/shear/mainnet\n`), false, 'a mainnet datadir is never removed');
    for (const p of ['root/claude-ci', 'var/lib/shear/testnet-v12', 'root/.shear', 'home/ubuntu/.shear',
      'opt/shear-v4', 'etc/systemd/system/shear-node.service', 'etc/cron.d/claude-lanes', 'root/test.shewall', 'var/log/shear-node.log']) {
      assert.ok(got.stdout.includes(`would run: rm -${p.startsWith('etc/cron.d') ? 'f' : 'rf'} ${root}/${p}\n`), p);
    }
    assert.equal(got.stdout.includes(`rm -f ${root}/etc/cron.d/certbot`), false, 'a renewal hook is never removed');
    assert.ok(got.stdout.includes(`check by hand (names shear): ${root}/etc/cron.d/certbot`));
    assert.match(got.stdout, /teardown dry run, nothing changed on /);
    assert.ok(fs.existsSync(path.join(root, 'root/claude-ci/lane1.txt')), 'a dry run removes nothing');
  });

  function teardownFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teardown-mn-'));
    const mk = (p, body = '') => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), body); };
    // Mainnet state R18a installs: it must survive every teardown.
    mk('var/lib/shear/mainnet/chain.bin'); mk('var/lib/shear/mainnet-p2p/chain.bin');
    mk('var/lib/shear/mainnet-pool/pool-spend.seed', 'seed-bytes-for-a-fixture\n'); mk('var/lib/shear/seal-keys/node/k');
    mk('etc/systemd/system/shear-node.service', '[Service]\nEnvironment=SHEAR_NETWORK=shear-v1\n');
    mk('etc/systemd/system/shear-pool.service', '[Service]\nEnvironment=SHEAR_NETWORK=shear-v1\n');
    mk('etc/systemd/system/multi-user.target.wants/shear-node.service', '[Service]\nEnvironment=SHEAR_NETWORK=shear-v1\n');
    mk('opt/shear/node/src/node.js');
    // v12 testnet state: a later teardown removes it.
    mk('var/lib/shear/testnet-v12/chain.bin'); mk('var/lib/shear/seal-keys-v12/node/k');
    mk('etc/systemd/system/shear-v12-node.service', '[Service]\nEnvironment=SHEAR_NETWORK=shear-testnet-v12\n');
    mk('opt/shear-v12/node/src/node.js');
    return root;
  }

  it('teardown never touches mainnet state, and still removes the v12 testnet', () => {
    const root = teardownFixture();
    const got = bash([file('scripts/teardown.sh')], { SHEAR_TEARDOWN_ROOT: root, SHEAR_ROLE: 'pool', SHEAR_TEARDOWN_HOSTNAME: 'pool' });
    assert.equal(got.status, 0, got.stderr + got.stdout);
    for (const p of ['var/lib/shear/mainnet', 'var/lib/shear/mainnet-p2p', 'var/lib/shear/mainnet-pool', 'var/lib/shear/seal-keys',
      'etc/systemd/system/shear-node.service', 'etc/systemd/system/shear-pool.service',
      'etc/systemd/system/multi-user.target.wants/shear-node.service', 'opt/shear']) {
      assert.equal(got.stdout.includes(`would run: rm -rf ${root}/${p}\n`), false, `${p} is mainnet and is kept`);
      assert.ok(got.stdout.includes(`keep (mainnet): ${root}/${p}\n`), `${p} is listed as kept`);
    }
    for (const p of ['var/lib/shear/testnet-v12', 'var/lib/shear/seal-keys-v12', 'etc/systemd/system/shear-v12-node.service', 'opt/shear-v12']) {
      assert.ok(got.stdout.includes(`would run: rm -rf ${root}/${p}\n`), `${p} is v12 testnet and goes`);
    }
    assert.ok(fs.existsSync(path.join(root, 'var/lib/shear/mainnet-pool/pool-spend.seed')));
  });

  it('teardown --apply needs an attested offline backup of the pool spend seed', () => {
    const root = teardownFixture();
    const env = { SHEAR_TEARDOWN_ROOT: root, SHEAR_ROLE: 'pool', SHEAR_TEARDOWN_HOSTNAME: 'pool' };
    const none = bash([file('scripts/teardown.sh')], env);
    assert.match(none.stdout, /seed backup: no attestation, --apply refuses until SHEAR_SEED_BACKUP_SHA256 is set/);
    const wrong = bash([file('scripts/teardown.sh')], { ...env, SHEAR_SEED_BACKUP_SHA256: '0'.repeat(64) });
    assert.match(wrong.stdout, /seed backup: SHEAR_SEED_BACKUP_SHA256 does not match/);
    const sha = spawnSync('sha256sum', [path.join(root, 'var/lib/shear/mainnet-pool/pool-spend.seed')], { encoding: 'utf8', timeout: 60_000 }).stdout.split(' ')[0];
    const good = bash([file('scripts/teardown.sh')], { ...env, SHEAR_SEED_BACKUP_SHA256: sha });
    assert.match(good.stdout, /seed backup: attested, sha256 matches/);
  });

  it('teardown refuses agent-box, the explorer and any host that is not pool, p2p-a or p2p-b', () => {
    const root = teardownFixture();
    const cases = [
      ['agent-box', 'pool', /refused: agent-box/],
      ['explorer', 'p2p-a', /refused: agent-box/],
      ['p2p-a', 'explorer', /refused: agent-box/],
      ['p2p-a', 'agent-box', /refused: agent-box/],
      ['web1', 'web1', /refused: role must be pool, p2p-a or p2p-b/],
      ['p2p-a', '', /refused: role must be pool, p2p-a or p2p-b/],
    ];
    for (const [hostName, role, why] of cases) {
      const got = bash([file('scripts/teardown.sh')], { SHEAR_TEARDOWN_ROOT: root, SHEAR_ROLE: role, SHEAR_TEARDOWN_HOSTNAME: hostName });
      assert.equal(got.status, 1, `${hostName}/${role}: ${got.stdout}`);
      assert.match(got.stdout, why, `${hostName}/${role}`);
      assert.equal(/would run/.test(got.stdout), false, `${hostName}/${role} lists nothing`);
    }
    // A role file written at install must agree with SHEAR_ROLE.
    fs.mkdirSync(path.join(root, 'etc/shear'), { recursive: true });
    fs.writeFileSync(path.join(root, 'etc/shear/role'), 'p2p-b\n');
    const clash = bash([file('scripts/teardown.sh')], { SHEAR_TEARDOWN_ROOT: root, SHEAR_ROLE: 'p2p-a', SHEAR_TEARDOWN_HOSTNAME: 'p2p-a' });
    assert.equal(clash.status, 1);
    assert.match(clash.stdout, /refused: \/etc\/shear\/role says p2p-b/);
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

  it('check_host knows the three roles, their OSes, their units and the ports each role opens', () => {
    const text = read('scripts/check_host.sh');
    assert.match(text, /pool\) +os=ubuntu; mn="shear-p2p\.service shear-pool\.service"; v12="shear-v12-p2p\.service shear-v12-pool\.service"/);
    assert.match(text, /p2p-a\) os=debian; mn="shear-node\.service"; v12="shear-v12-node\.service"/);
    assert.match(text, /p2p-b\) os=fedora; mn="shear-node\.service"; v12="shear-v12-node\.service"/);
    assert.match(text, /pool\) +ports=" 22 80 443 1111 30303 "/);
    assert.match(text, /p2p-a\|p2p-b\) ports=" 22 30303 "/);
    assert.match(text, /systemctl show -p Restart --value/);
    assert.match(text, /systemctl show -p Environment --value/);
    assert.match(text, /systemctl show -p EnvironmentFiles --value/);
    assert.match(text, /sshd -T/);
    assert.match(text, /ss -tulnH/);
    assert.equal(bash([file('scripts/check_host.sh'), 'nope', '--phase', 'live']).status, 2);
    assert.doesNotMatch(text, /SHEAR_MAINNET_EMIT=1|SHEAR_MAINNET_EMIT_CONFIRM=/, 'check_host never sets the emit gate');
  });

  it('check_host needs --phase pre-genesis or live', () => {
    for (const args of [['pool'], ['pool', '--phase'], ['pool', '--phase', 'later'], ['p2p-a', 'live']]) {
      const got = bash([file('scripts/check_host.sh'), ...args]);
      assert.equal(got.status, 2, args.join(' '));
      assert.match(got.stdout + got.stderr, /--phase pre-genesis\|live/, args.join(' '));
    }
  });

  // A host as check_host sees it: a fixture root plus mock systemctl, ss,
  // sshd, ufw, nft, firewall-cmd, journalctl, curl, git and stat on PATH.
  // Nothing here reaches a host or a real systemd.
  const MOCKS = {
    systemctl: String.raw`R="$SHEAR_CHECK_ROOT"; M="$MOCK"; cmd="$1"; shift
case "$cmd" in
  list-unit-files) for f in "$R"/etc/systemd/system/shear*.service; do [ -f "$f" ] && echo "$(basename "$f") disabled"; done ;;
  is-enabled) u="$(printf '%s\n' "$@" | tail -1)"; if [ -e "$M/enabled/$u" ]; then echo enabled; exit 0; fi; echo disabled; exit 1 ;;
  is-active) u="$(printf '%s\n' "$@" | tail -1)"; if [ -e "$M/active/$u" ]; then echo active; exit 0; fi; echo inactive; exit 3 ;;
  show) prop=""; u=""; while [ $# -gt 0 ]; do case "$1" in -p) prop="$2"; shift 2 ;; --value) shift ;; *) u="$1"; shift ;; esac; done
    files=("$R/etc/systemd/system/$u"); for d in "$R/etc/systemd/system/$u.d"/*.conf; do [ -f "$d" ] && files+=("$d"); done
    case "$prop" in
      Environment) grep -h '^Environment=' "\${files[@]}" | sed 's/^Environment=//' | tr '\n' ' ' | sed 's/ $//'; echo ;;
      EnvironmentFiles) grep -h '^EnvironmentFile=' "\${files[@]}" | sed 's/^EnvironmentFile=-\{0,1\}//; s/$/ (ignore_errors=no)/' ;;
      DropInPaths) for d in "\${files[@]:1}"; do printf '%s ' "\${d#$R}"; done; echo ;;
      Restart) v="$(grep -h '^Restart=' "\${files[@]}" | tail -1 | cut -d= -f2)"; echo "\${v:-no}" ;;
      OnFailure) grep -h '^OnFailure=' "\${files[@]}" | tail -1 | cut -d= -f2- ;;
      FragmentPath) echo "/etc/systemd/system/$u" ;;
    esac ;;
esac`,
    ss: 'cat "$MOCK/ss"',
    sshd: 'cat "$MOCK/sshd"',
    ufw: 'cat "$MOCK/ufw"',
    nft: 'cat "$MOCK/nft"',
    'firewall-cmd': 'case "$*" in *--get-default-zone*) echo public ;; *--get-target*) echo DROP ;; *--list-services*) echo ;; *--list-rich-rules*) cat "$MOCK/rich" ;; *--list-ports*) cat "$MOCK/fwports" ;; esac',
    journalctl: 'u=""; while [ $# -gt 0 ]; do [ "$1" = -u ] && u="$2"; shift; done; cat "$MOCK/journal/$u" 2>/dev/null',
    curl: String.raw`url="$(printf '%s\n' "$@" | tail -1)"; port="$(echo "$url" | sed -E 's#^http://127\.0\.0\.1:([0-9]+)/.*#\1#')"; p="$(echo "$url" | sed -E 's#^http://[^/]+/##; s#[?].*##')"
f="$MOCK/rpc/$port-$p"
if [ -f "$f.seq" ]; then n=$(( $(cat "$f.n" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$f.n"; sed -n "\${n}p" "$f.seq"; exit 0; fi
[ -f "$f" ] && cat "$f" || exit 7`,
    git: '[ -f "$MOCK/tag" ] && cat "$MOCK/tag" || exit 128',
    stat: 'f="$(printf "%s\\n" "$@" | tail -1)"; if [ -f "$MOCK/stat/$(basename "$f")" ]; then cat "$MOCK/stat/$(basename "$f")"; else exec /usr/bin/stat "$@"; fi',
  };
  const v12Of = (name) => {
    const real = `units/${name.replace('shear-', 'shear-v12-')}`;
    if (fs.existsSync(file(real))) return read(real);
    return read(`units/${name}`).replace(/shear-v1\b/g, 'shear-testnet-v12').replace(/shear\/mainnet/g, 'shear/testnet-v12')
      .replace(/seal-keys\//g, 'seal-keys-v12/').replace(/\/opt\/shear\b/g, '/opt/shear-v12').replace(/pool\.env/g, 'pool-v12.env')
      .replace(/shear-p2p\.service/g, 'shear-v12-p2p.service');
  };
  const FAKE_ASERT = "export const MAGIC_MAINNET = 'shear-v1';\nexport const MAGIC_TESTNET_V12 = 'shear-testnet-v12';\nexport const GENESIS_MAINNET = '2026-09-18T21:00:00+01:00';\n"
    + 'export function consensusFingerprint(m) { return `law:${m}`; }\n'
    + 'export function mainnetFingerprint() { return `${consensusFingerprint(MAGIC_MAINNET)}:GENESIS=${GENESIS_MAINNET}`; }\n';

  function hostFixture(role, phase) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'checkhost-'));
    const mock = path.join(root, '.mock');
    const put = (p, body = '') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };
    const R = (p) => path.join(root, p);
    const M = (p) => path.join(mock, p);
    for (const [cmd, body] of Object.entries(MOCKS)) { put(M(`bin/${cmd}`), `#!/usr/bin/env bash\n${body.replace(/\\\$\{/g, '${')}\n`); fs.chmodSync(M(`bin/${cmd}`), 0o755); }
    put(R('etc/os-release'), `ID=${{ pool: 'ubuntu', 'p2p-a': 'debian', 'p2p-b': 'fedora' }[role]}\n`);
    const mn = role === 'pool' ? ['shear-p2p.service', 'shear-pool.service'] : ['shear-node.service'];
    const v12 = mn.map((u) => u.replace('shear-', 'shear-v12-'));
    mn.forEach((u) => put(R(`etc/systemd/system/${u}`), read(`units/${u}`)));
    mn.forEach((u) => put(R(`etc/systemd/system/${u.replace('shear-', 'shear-v12-')}`), v12Of(u)));
    put(R('opt/shear/crypto/asert.js'), FAKE_ASERT); put(R('opt/shear-v12/crypto/asert.js'), FAKE_ASERT);
    put(R('var/lib/shear/mainnet/.keep')); put(R('var/lib/shear/testnet-v12/.keep'));
    if (role === 'pool') {
      put(R('etc/shear/pool.env'), 'SHEAR_STRATUM_AUTH_PUB=abc\n'); put(R('etc/shear/pool-v12.env'), 'SHEAR_STRATUM_AUTH_PUB=abc\n');
      put(M('stat/pool.env'), 'root:shear 640\n'); put(M('stat/pool-v12.env'), 'root:shear 640\n');
    }
    const listen = ['tcp LISTEN 0 511 0.0.0.0:22 0.0.0.0:*', 'tcp LISTEN 0 511 0.0.0.0:30303 0.0.0.0:*', 'tcp LISTEN 0 511 127.0.0.1:18333 0.0.0.0:*'];
    if (role === 'pool') listen.push('tcp LISTEN 0 511 0.0.0.0:1111 0.0.0.0:*', 'tcp LISTEN 0 511 0.0.0.0:443 0.0.0.0:*', 'tcp LISTEN 0 511 127.0.0.1:8088 0.0.0.0:*');
    put(M('ss'), `${listen.join('\n')}\n`);
    put(M('sshd'), 'port 22\npermitrootlogin prohibit-password\npasswordauthentication no\n');
    put(M('ufw'), 'Status: active\n\nTo                         Action      From\n22/tcp                     LIMIT IN    Anywhere\n30303/tcp                  ALLOW IN    Anywhere\n');
    put(M('nft'), 'table inet filter {\n chain input {\n  type filter hook input priority filter; policy drop;\n  tcp dport 22 ct state new add @ssh4 { ip saddr limit rate over 10/minute burst 5 packets } drop\n  tcp dport { 22, 30303 } accept\n }\n}\n');
    put(M('rich'), 'rule family="ipv4" service name="ssh" accept limit value="10/m"\nrule family="ipv6" service name="ssh" accept limit value="10/m"\n');
    put(M('fwports'), '30303/tcp\n');
    put(M('enabled/nftables'));
    const rpcPort = role === 'pool' ? 18333 : 18332;
    const live = phase === 'live';
    const magic = live ? 'shear-v1' : 'shear-testnet-v12';
    const stats = (h) => JSON.stringify({ ok: true, height: h, hash: 'ab'.repeat(32), magic, bookLawFingerprint: `law:${magic}` });
    put(M(`rpc/${rpcPort}-stats.seq`), `${stats(100)}\n${stats(103)}\n`);
    put(M(`rpc/${rpcPort}-header`), JSON.stringify({ ok: true, height: 0, hash: 'cd'.repeat(32) }));
    for (const u of live ? mn : v12) { put(M(`active/${u}`)); put(M(`enabled/${u}`)); }
    if (live) put(M('tag'), 'v1.0.0\n');
    const env = { SHEAR_CHECK_ROOT: root, MOCK: mock, PATH: `${M('bin')}:${process.env.PATH}`, SHEAR_CHECK_TIP_WAIT: '0' };
    if (live) env.SHEAR_RELEASE_TAG = 'v1.0.0';
    return { root, mock, R, M, put, mn, v12, env, rpcPort, stats };
  }
  const check = (fx, role, phase, extra = {}) => bash([file('scripts/check_host.sh'), role, '--phase', phase], { ...fx.env, ...extra });

  for (const role of ['pool', 'p2p-a', 'p2p-b']) {
    for (const phase of ['pre-genesis', 'live']) {
      it(`check_host ${role} --phase ${phase} passes a good host`, () => {
        const fx = hostFixture(role, phase);
        const got = check(fx, role, phase);
        assert.equal(got.status, 0, got.stdout + got.stderr);
        assert.match(got.stdout, new RegExp(`check_host ${role} ${phase}: PASS`));
      });
    }
  }

  it('check_host pre-genesis fails on a mainnet unit that could emit, or a v12 net that is not up', () => {
    const cases = [
      ['emit in a drop-in', (fx) => fx.put(fx.R(`etc/systemd/system/${fx.mn[0]}.d/emit.conf`), '[Service]\nEnvironment=SHEAR_MAINNET_EMIT=1\n'), /SHEAR_MAINNET_EMIT/],
      ['mainnet enabled', (fx) => fx.put(fx.M(`enabled/${fx.mn[0]}`)), /enabled before genesis/],
      ['mainnet active, no emit:false', (fx) => { fx.put(fx.M(`active/${fx.mn[0]}`)); fx.put(fx.M(`journal/${fx.mn[0]}`), '{"event":"boot","emit":true,"mainnet":true}\n'); }, /emit:false/],
      ['v12 down', (fx) => fs.unlinkSync(fx.M(`active/${fx.v12[0]}`)), /is not active/],
      ['v12 rpc on the wrong book', (fx) => fx.put(fx.M(`rpc/${fx.rpcPort}-stats.seq`), `${JSON.stringify({ height: 1, magic: 'shear-v1', bookLawFingerprint: 'law:shear-v1' })}\n`), /magic/],
      ['bootstrap in the env', (fx) => fx.put(fx.R(`etc/systemd/system/${fx.v12[0]}.d/b.conf`), '[Service]\nEnvironment=SHEAR_BOOTSTRAP=1\n'), /SHEAR_BOOTSTRAP/],
      ['rpc bound in public', (fx) => fx.put(fx.R(`etc/systemd/system/${fx.v12[0]}.d/r.conf`), '[Service]\nEnvironment=SHEAR_RPC_BIND=0.0.0.0\n'), /SHEAR_RPC_BIND/],
      ['password ssh', (fx) => fx.put(fx.M('sshd'), 'passwordauthentication yes\npermitrootlogin no\n'), /PasswordAuthentication/],
      ['ssh not limited', (fx) => fx.put(fx.M('ufw'), 'Status: active\n22/tcp ALLOW IN Anywhere\n'), /rate limit/],
      ['public 8088', (fx) => fx.put(fx.M('ss'), 'tcp LISTEN 0 511 0.0.0.0:8088 0.0.0.0:*\n'), /public tcp listener on 0\.0\.0\.0:8088/],
    ];
    for (const [name, tweak, why] of cases) {
      const fx = hostFixture('pool', 'pre-genesis');
      tweak(fx);
      const got = check(fx, 'pool', 'pre-genesis');
      assert.equal(got.status, 1, `${name}: ${got.stdout}`);
      assert.match(got.stdout, why, name);
    }
    // An active mainnet node that logged a deliberate emit:false is fine.
    const fx = hostFixture('p2p-a', 'pre-genesis');
    fx.put(fx.M('active/shear-node.service'));
    fx.put(fx.M('journal/shear-node.service'), '{"event":"boot","emit":false,"reason":"clock_wait","mainnet":true}\n');
    const ok = check(fx, 'p2p-a', 'pre-genesis');
    assert.match(ok.stdout, /emit:false/);
  });

  it('check_host on p2p-a and p2p-b allows only 22 and 30303', () => {
    for (const role of ['p2p-a', 'p2p-b']) {
      const fx = hostFixture(role, 'live');
      fx.put(fx.M('ss'), 'tcp LISTEN 0 511 0.0.0.0:22 0.0.0.0:*\ntcp LISTEN 0 511 0.0.0.0:30303 0.0.0.0:*\ntcp LISTEN 0 511 0.0.0.0:443 0.0.0.0:*\n');
      const got = check(fx, role, 'live');
      assert.equal(got.status, 1, role);
      assert.match(got.stdout, /public tcp listener on 0\.0\.0\.0:443/, role);
    }
  });

  it('check_host live fails on a wrong book, release, a stalled tip or a v12 net still up', () => {
    const cases = [
      ['tag', (fx) => fx.put(fx.M('tag'), 'v0.9.0\n'), /release tag/],
      ['no tag given', (fx) => delete fx.env.SHEAR_RELEASE_TAG, /SHEAR_RELEASE_TAG/],
      ['stalled', (fx) => fx.put(fx.M(`rpc/${fx.rpcPort}-stats.seq`), `${fx.stats(100)}\n${fx.stats(100)}\n`), /tip did not rise/],
      ['wrong magic', (fx) => fx.put(fx.M(`rpc/${fx.rpcPort}-stats.seq`), `${JSON.stringify({ height: 1, magic: 'shear-testnet-v12', bookLawFingerprint: 'law:shear-v1' })}\n${JSON.stringify({ height: 2, magic: 'shear-testnet-v12' })}\n`), /magic/],
      ['wrong fingerprint', (fx) => fx.put(fx.M(`rpc/${fx.rpcPort}-stats.seq`), `${JSON.stringify({ height: 1, magic: 'shear-v1', bookLawFingerprint: 'law:other' })}\n${JSON.stringify({ height: 2, magic: 'shear-v1' })}\n`), /fingerprint/],
      ['genesis differs from the peer', (fx) => { fx.env.SHEAR_GENESIS_HASH = 'ee'.repeat(32); }, /genesis/],
      ['v12 still up', (fx) => fx.put(fx.M(`active/${fx.v12[0]}`)), /v12 .*still active/],
      ['mainnet down', (fx) => fs.unlinkSync(fx.M(`active/${fx.mn[0]}`)), /is not active/],
      ['no stratum', (fx) => fx.put(fx.M('ss'), 'tcp LISTEN 0 511 0.0.0.0:22 0.0.0.0:*\ntcp LISTEN 0 511 0.0.0.0:30303 0.0.0.0:*\n'), /nothing listens on :1111/],
    ];
    for (const [name, tweak, why] of cases) {
      const fx = hostFixture('pool', 'live');
      tweak(fx);
      const got = check(fx, 'pool', 'live');
      assert.equal(got.status, 1, `${name}: ${got.stdout}`);
      assert.match(got.stdout, why, name);
    }
  });

  it('the runbook gates every host change on a GO and records the rulings', () => {
    const rb = read('RUNBOOK.md');
    assert.match(rb, /Status: \*\*prepared, not run\.\*\*/);
    assert.match(rb, /p2p-b first, then p2p-a, then the pool/);
    assert.match(rb, /\*\*Port 8080 is closed\*\*/);
    assert.match(rb, /\*\*Bootstrap publisher:\*\* left out/);
    assert.match(rb, /\*\*Stratum on 1111:\*\* TLS only/);
    assert.doesNotMatch(rb, /Open point/);
    for (const step of ['Reinstall', 'Firewall', 'Install', 'Verify, don\'t paint']) assert.ok(rb.includes(step), step);
  });
});
