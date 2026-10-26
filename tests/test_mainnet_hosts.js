/**
 * R18a mainnet host files (deploy/mainnet). The units never restart by
 * themselves, copy a datadir or tip.json, phone home or name a host IP; each
 * firewall opens exactly TCP 22, 80, 443, 1111, 8080 and 30303; and every
 * script that changes a host is a dry run unless told otherwise. Nothing here
 * runs on a host (Russell 26 Oct: no wipe, rebuild or deploy without his GO).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = new URL('../deploy/mainnet/', import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, dir), 'utf8').replace(/\r/g, '');
const PORTS = ['22', '80', '443', '1111', '8080', '30303'];
const UNITS = ['shear-node.service', 'shear-p2p.service', 'shear-pool.service'];

describe('mainnet host files', () => {
  for (const name of UNITS) {
    it(`${name}: no self-restart, no copies, no phone-home, no host IP`, () => {
      const unit = read(`units/${name}`);
      const keys = unit.split('\n').filter((l) => /^[A-Za-z]+=/.test(l));
      assert.deepEqual(keys.filter((l) => l.startsWith('Restart')), ['Restart=no']);
      assert.equal(keys.some((l) => /^(OnFailure|StartLimitAction|FailureAction)=/.test(l)), false, 'no recovery hook');
      const execs = keys.filter((l) => /^Exec/.test(l));
      assert.deepEqual(execs.map((l) => l.split('=')[0]), ['ExecStart'], 'one ExecStart, no pre or post step');
      assert.equal(/\b(cp|rsync|curl|wget|scp)\b|tip\.json|https?:/.test(execs.join('\n')), false, 'no copy or fetch');
      const ips = keys.join('\n').match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) || [];
      assert.deepEqual(ips.filter((ip) => ip !== '127.0.0.1' && ip !== '0.0.0.0'), [], 'no host IP');
      const seeds = keys.find((l) => l.startsWith('Environment=SHEAR_SEEDS='));
      if (seeds) for (const s of seeds.split('=')[2].split(',')) assert.match(s, /^[a-z0-9.-]+\.shear\.digital:30303$/, s);
      assert.ok(keys.includes('Environment=SHEAR_NETWORK=shear-v1'), 'mainnet book');
      assert.ok(keys.includes('User=shear') && keys.includes('ProtectSystem=strict'));
      const data = keys.find((l) => l.startsWith('Environment=SHEAR_DATA=')).split('=')[2];
      assert.deepEqual(keys.filter((l) => l.startsWith('ReadWritePaths=')), [`ReadWritePaths=${data}`], 'writes only its own datadir');
    });
  }

  it('only the p2p units bind :30303; the pool does not', () => {
    assert.match(read('units/shear-node.service'), /^Environment=SHEAR_P2P_PORT=30303$/m);
    assert.match(read('units/shear-p2p.service'), /^Environment=SHEAR_P2P_PORT=30303$/m);
    assert.doesNotMatch(read('units/shear-pool.service'), /SHEAR_P2P_PORT/);
    assert.match(read('units/shear-pool.service'), /^Environment=SHEAR_P2P_IPC=127\.0\.0\.1:30313$/m);
  });

  it('each firewall opens exactly the six ports, TCP only', () => {
    const ufw = read('firewall/ufw-pool.sh');
    assert.match(ufw, /^PORTS="22 80 443 1111 8080 30303"$/m);
    assert.match(ufw, /ufw default deny incoming/);
    const fwd = read('firewall/firewalld-p2p-b.sh');
    assert.match(fwd, /^PORTS="22 80 443 1111 8080 30303"$/m);
    assert.match(fwd, /--remove-service=/);
    assert.match(fwd, /--set-target=DROP/);
    const nft = read('firewall/nftables-p2p-a.conf');
    assert.match(nft, /policy drop;/);
    const dports = [...nft.matchAll(/dport \{([^}]*)\}/g)].map((m) => m[1].split(',').map((p) => p.trim()));
    assert.deepEqual(dports, [PORTS]);
    assert.equal(/udp dport/.test(nft), false);
  });

  it('every script that changes a host is a dry run unless told', () => {
    for (const f of ['firewall/ufw-pool.sh', 'firewall/firewalld-p2p-b.sh', 'scripts/teardown.sh']) {
      const text = read(f);
      assert.match(text, /^apply=0; \[ "\$\{1:-\}" = "--apply" \] && apply=1$/m, f);
      assert.match(text, /if \[ \$apply = 1 \]; then "\$@"; else echo "would run: \$\*"; fi/, f);
    }
    for (const f of ['scripts/inventory.sh', 'scripts/check_host.sh']) {
      assert.equal(/\b(rm|systemctl (stop|disable|enable|start|restart)|ufw allow|firewall-cmd --permanent)\b/.test(read(f)), false, `${f} is read-only`);
    }
  });

  it('teardown refuses --apply without this host\'s GO token, before it touches anything', () => {
    const env = { ...process.env };
    delete env.SHEAR_TEARDOWN_GO;
    const got = spawnSync('bash', [fileURLToPath(new URL('scripts/teardown.sh', dir)), '--apply'], { encoding: 'utf8', env });
    assert.equal(got.status, 1);
    assert.match(got.stdout, /^refused: --apply needs SHEAR_TEARDOWN_GO=/);
    assert.equal(/would run|systemctl|rm -rf/.test(got.stdout), false);
    const text = read('scripts/teardown.sh');
    assert.ok(text.indexOf('refused: --apply') < text.indexOf('systemctl'), 'the refusal comes first');
  });

  it('teardown clears the test paths and keeps nothing from a datadir', () => {
    const text = read('scripts/teardown.sh');
    for (const p of ['/root/claude-ci', '/var/lib/shear', '/opt/shear-v4', "'shear*'", "'sheark*'", '*.shewall']) {
      assert.ok(text.includes(p), p);
    }
    assert.equal(/continue ;;/.test(text.slice(text.indexOf('# 3.'), text.indexOf('# 4.'))), false, 'no datadir is spared');
  });

  it('check_host knows the three roles and their OSes', () => {
    const text = read('scripts/check_host.sh');
    assert.match(text, /pool\) +os=ubuntu; units="shear-p2p\.service shear-pool\.service"/);
    assert.match(text, /p2p-a\) os=debian; units="shear-node\.service"/);
    assert.match(text, /p2p-b\) os=fedora; units="shear-node\.service"/);
    assert.match(text, /allowed=" 22 80 443 1111 8080 30303 "/);
    const got = spawnSync('bash', [fileURLToPath(new URL('scripts/check_host.sh', dir)), 'nope'], { encoding: 'utf8' });
    assert.equal(got.status, 2);
  });

  it('the runbook gates every host change on a GO and names the order', () => {
    const rb = read('RUNBOOK.md');
    assert.match(rb, /Status: \*\*prepared, not run\.\*\*/);
    assert.match(rb, /p2p-b first, then p2p-a, then the pool/);
    for (const step of ['Reinstall', 'Firewall', 'Install', 'Verify, don\'t paint']) assert.ok(rb.includes(step), step);
  });
});
