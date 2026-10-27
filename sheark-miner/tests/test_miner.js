import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = process.platform === 'win32'
  ? path.join(root, 'ShearK-Miner.exe')
  : path.join(root, 'ShearK-Miner');

function stripAnsi(s) {
  return String(s || '').replace(/\x1b\[[0-9;]*m/g, '');
}

// A spawn that fails (ENOENT) emits 'error' and need not emit 'close'.
// Waiting on 'close' alone, with the stub pool still listening, hung the file
// until the 45-minute runner cap. `done` is armed at spawn and rejects on
// 'error'. The stub pool is unref'd so a failed case cannot pin the loop.
function spawnMiner(args) {
  const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.done = new Promise((resolve, reject) => {
    child.once('close', resolve);
    child.once('error', reject);
  });
  child.done.catch(() => {});
  return child;
}

function needBin() {
  assert.equal(fs.existsSync(bin), true, `missing ${bin}: build it with make -C sheark-miner`);
}

function jsonFromProc(s) {
  const m = stripAnsi(s).match(/\{[\s\S]*\}/);
  assert.ok(m, `no json in ${s}`);
  return JSON.parse(m[0]);
}

describe('ShearK-Miner', () => {
  it('selftest and print-config are ShearHash-v3 light', () => {
    assert.equal(fs.existsSync(bin), true, `missing ${bin}`);
    const st = spawnSync(bin, ['--backend', 'interpreter', '--selftest'], { timeout: 600_000, encoding: 'utf8' });
    assert.equal(st.status, 0, st.stderr + st.stdout);
    assert.match(st.stdout, /selftest ok 98818c31d739ef821db0242f76bd244b96f1fb5049d27ea9a192e95c67b39a8b/);
    const stJit = spawnSync(bin, ['--backend', 'jit', '--selftest'], { timeout: 600_000, encoding: 'utf8' });
    assert.equal(stJit.status, 0, stJit.stderr + stJit.stdout);
    assert.match(stJit.stdout, /selftest ok 98818c31d739ef821db0242f76bd244b96f1fb5049d27ea9a192e95c67b39a8b/);
    assert.match(stJit.stdout, /backend=(jit|interpreter)/);
    assert.equal(stJit.stdout.includes('jit-full'), false);
    if (process.platform === 'linux') assert.match(stJit.stdout, /backend=jit/);
    assert.match(st.stdout, /k 55111f0216ab10a6ba15fc0146990b10d26edcf58c86fa1418c41d96fa40b8e4/);
    assert.equal(st.stdout.includes('64d41fa97f5ebea8a7e2a2625b1824467ce9d081bf29b0b2ae0a7fe617599895'), false);
    assert.match(st.stdout, /client=ShearHash/);
    assert.match(st.stdout, /algorithm=ShearHash/);
    assert.match(st.stdout, /personalisation=ShearHash-v3/);
    assert.equal(st.stdout.includes('5d00a24233609829e59d6e83d9fcd2f262c4014e772a23024fd3db4e66ee2066'), false);
    assert.equal(st.stdout.toLowerCase().includes('feeless'), false);
    const cfg = spawnSync(bin, ['--backend', 'interpreter', '--print-config'], { timeout: 600_000, encoding: 'utf8' });
    assert.equal(cfg.status, 0, cfg.stderr);
    const j = jsonFromProc(cfg.stdout);
    assert.equal(j.name, 'ShearK-Miner');
    assert.equal(j.client, 'ShearHash');
    assert.equal(j.algorithm, 'ShearHash');
    assert.equal(j.personalisation, 'ShearHash-v3');
    assert.equal(j.version, '2.9');
    assert.equal(j.version.split('.').length, 2);
    assert.equal(j.headerBytes, 128);
    assert.equal(j.magic, 'shear-testnet-v12');
    assert.equal(j.rxMode, 'light');
    assert.equal(j.rxCacheMiB, 128);
    assert.equal(j.feePct, 0);
    assert.equal(j.clientLogin, 'direct');
    assert.equal(j.pool, 'pool.shear.digital:443');
    assert.equal(j.tls, true);
    const longDest = 'ssa1qsj3qt0mcuznqv6r5370d58tw32gz3yhjychuu0sljyw5zmw9pmwc47d9vnwagjafs3ywjz7udh7suc7e3qsshw25ze';
    const longCfg = spawnSync(bin, [
      '--backend', 'interpreter', '--print-config',
      '--user', `${longDest}.P7`,
    ], { timeout: 600_000, encoding: 'utf8' });
    assert.equal(longCfg.status, 0, longCfg.stderr);
    const lj = jsonFromProc(longCfg.stdout);
    assert.equal(lj.destBound, true, longCfg.stdout);
    assert.equal(lj.dest20, '84a205bf78e0a60668748f9eda1d6e8a902892f2');
    assert.equal(lj.dest20.length, 40);
    assert.equal(j.feeDest, undefined);
    const src = fs.readFileSync(path.join(root, 'src/sheark_miner.c'), 'utf8');
    assert.equal(src.toLowerCase().includes('feeless'), false);
    assert.equal(/g_fee_login/.test(src), false);
    assert.ok(j.backend === 'interpreter' || j.backend === 'jit' || j.backend === 'jit-full', j.backend);
    assert.equal(j.backend, 'interpreter');
    assert.equal(typeof j.hugePages, 'boolean');
    const help = spawnSync(bin, ['--help'], { timeout: 600_000, encoding: 'utf8' });
    assert.match(help.stdout, /ShearK-Miner 2\.9 \(ShearHash-v3 light\)/);
    assert.match(help.stdout, /stratum\+ssl:\/\//);
    assert.match(help.stdout, /ShearHash-v3 light/);
    assert.match(help.stdout, /--backend jit-full/);
    assert.match(help.stdout, /--backend jit/);
    const srcEx = fs.readFileSync(path.join(root, 'example.sh'), 'utf8');
    const bat = fs.readFileSync(path.join(root, 'example.bat'), 'utf8');
    assert.match(srcEx, /shear-testnet-v12/);
    assert.equal(srcEx.includes('shear-testnet-v2'), false);
    assert.equal(srcEx.includes('shear-testnet-v3'), false);
    assert.match(bat, /shear-testnet-v12/);
    assert.equal(bat.includes('shear-testnet-v2'), false);
    assert.equal(bat.includes('shear-testnet-v3'), false);
    assert.match(srcEx, /--user YOUR_SSA1\.worker/);
    assert.match(srcEx, /--dest YOUR_SSA1/);
    assert.match(srcEx, /--backend jit-full/);
    assert.match(bat, /--user YOUR_SSA1\.worker/);
    assert.match(bat, /--dest YOUR_SSA1/);
    assert.match(bat, /--backend jit-full/);
    assert.match(bat, /ShearK-Miner-2\.9-windows\.zip/);
    assert.doesNotMatch(bat, /ShearK-Miner-2\.7-windows\.zip/);
    assert.doesNotMatch(help.stdout, /--tls-pin/);
    assert.doesNotMatch(help.stdout, /--tls-insecure/);
    assert.match(bat, /stratum\+ssl:\/\/pool\.shear\.digital:443/);
    assert.match(bat, /libssl-3-x64\.dll/);
    assert.equal(help.stdout.toLowerCase().includes('feeless'), false);
    assert.match(src, /hashes=%llu round=%llu hashrate=%s accepted=%d rejected=%d submitted=%llu blocks=%d dropped=%llu/);
    assert.match(src, /cpuCores=%d cpuThreads=%d/);
    assert.match(src, /BLOCKFOUND!!!/);
    assert.match(src, /init_note_commit/);
    assert.match(src, /share_or_block_hit/);
    assert.match(src, /shareBind/);
    assert.match(src, /g_job_gen\+\+/);
    assert.match(src, /aborted_stale/);
    assert.match(src, /g_dropped\+\+/);
    assert.match(src, /primed = 0;/);
    assert.match(src, /shear_hash\(primed_hdr, check\)/);
    assert.match(src, /accepted=" C_GRN "%d"/);
    assert.match(src, /rejected=" C_RED "%d"/);
    assert.match(src, /C_RED "reject %s"/);
    assert.match(src, /C_GRN "accept"/);
    const hashNext = fs.readFileSync(path.join(root, 'src/shear_hash.c'), 'utf8');
    assert.match(hashNext, /shear_hash_next\(h1, piped\)/);
    assert.match(hashNext, /memcmp\(full, piped, 32\)/);
    assert.equal(src.includes('do not bump gen'), false);
    assert.match(src, /blen > 160/);
    assert.match(src, /Copy dest is dest20/);
    const hashSrc = fs.readFileSync(path.join(root, 'src/shear_hash.c'), 'utf8');
    assert.match(hashSrc, /shear-share-dest-v1/);
    assert.match(hashSrc, /shear-note-commit-v1/);
    assert.match(src, /\\033\[1;91m\\033\[1;93m\\033\[1;92m/);
    assert.match(src, /msgid == 1 && inflight <= 0/);
    assert.match(src, /\\033\[1;92m/);
    assert.match(src, /\\033\[1;93m/);
    assert.match(src, /\\033\[1;91m/);
    assert.match(src, /blockfound|BLOCKFOUND/i);
    assert.equal(src.includes('rainbow_puts'), false);
    assert.match(src, /\\"hash\\":\\"%s\\"/);
    assert.match(src, /hashes\\":%llu/);
    assert.match(src, /hashrate\\":%.0f/);
    const hashc = fs.readFileSync(path.join(root, 'src/shear_hash.c'), 'utf8');
    assert.match(hashc, /pthread_getspecific/);
    assert.match(hashc, /g_in_hash/);
    assert.match(hashc, /atomic_fetch_add_explicit\(&g_in_hash/);
    assert.match(hashc, /wait_hash_idle/);
    assert.match(hashc, /exclusive_begin/);
    assert.match(hashc, /hash_enter/);
    assert.match(hashc, /hash_leave/);
    assert.equal(/rx_rd\(/.test(hashc), false);
    assert.match(hashc, /shear_bind/);
    assert.match(hashc, /randomx_calculate_hash_next/);
    assert.match(hashc, /RANDOMX_FLAG_FULL_MEM/);
    assert.match(hashc, /backend_matches_selftest_locked/);
    assert.match(hashc, /if \(shear_bind\(header\) != 0\)/);
    assert.match(hashc, /if \(!g_have \|\| memcmp\(g_k, k, 32\) != 0\)/);
    assert.match(hashc, /RANDOMX_FLAG_LARGE_PAGES/);
    assert.match(hashc, /RANDOMX_FLAG_HARD_AES/);
    assert.match(hashc, /flags_jit_light/);
    assert.match(src, /backend_arg = "jit-full"/);
    assert.equal(/backend_arg = "auto"/.test(src), false);
    assert.match(src, /--dest ssa1/);
    assert.match(src, /ssa1 dest is incomplete or checksum-failed/);
    assert.match(src, /Copy dest from the Shear wallet/);
    assert.match(src, /she1 login has no --dest ssa1/);
    assert.equal(/randomx_calculate_hash\(g_vm,/.test(hashc), false);
    assert.match(src, /pthread_setaffinity_np/);
    assert.match(src, /g_cpu_map/);
    assert.match(src, /s\.gen != live_gen/);
    assert.match(src, /enqueue_share\(job\.jobId, stamped, hash, job\.gen\)/);
    assert.match(src, /never submit a digest for the previous header/);
    assert.match(src, /g_stale\+\+/);
    assert.match(src, /strstr\(low, "stale"\)/);
    assert.equal(/Do not bump gen \(that aborts/.test(src), false);
    assert.match(src, /enqueue_share\(job\.jobId, primed_n, hash, job\.gen\)/);
    assert.match(src, /g_stamp_seq/);
    assert.match(src, /stamp != last_stamp/);
    assert.match(src, /#define IN_FLIGHT_MAX 1/);
    assert.match(src, /strstr\(low, "busy"\)/);
    assert.match(src, /memcmp\(g_main_job\.header, job\.header, 100\)/);
    assert.match(src, /primed_hdr/);
    assert.match(src, /hash_next returns the previous header's digest/);
    assert.match(src, /reject %s/);
    assert.match(src, /g_smooth_hs/);
    assert.match(src, /promote_pending_job/);
    assert.match(src, /g_have_pending/);
    assert.match(hashc, /shear_prepare/);
    assert.match(hashc, /shear_commit_epoch/);
    assert.match(src, /Blockfound RandomX K pause/);
    assert.match(src, /RATE_HOLD_FRAC 0\.9/);
    assert.match(src, /RATE_MIN_DT 2/);
    assert.match(src, /g_rate_t0 = now/);
    assert.equal(/g_smooth_hs \* 0\.5/.test(src), false);
    {
      const bench = src.slice(src.indexOf('if (bench_secs > 0)'));
      assert.match(bench, /shear_hash_first\(header\)/);
      assert.match(bench, /shear_hash_next\(header, hash\)/);
    }
  });

  it('login status=OK does not bump accepted; status line prints hashes and job bits', async () => {
    needBin();
    const header = Buffer.alloc(128);
    header[0] = 1;
    const job = {
      jobId: 'login-job',
      header: header.toString('hex'),
      shareBits: 32,
      blockBits: 32,
      bits: 32,
    };
    let loginLine = '';
    const server = net.createServer((sock) => {
      sock.on('error', () => {});
      sock.on('data', (chunk) => {
        const text = chunk.toString();
        if (text.includes('"method":"login"')) {
          loginLine += text;
          sock.write(`${JSON.stringify({ id: 1, result: { status: 'OK' }, job })}\n`);
        }
      });
    });
    server.on('error', () => {});
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    server.unref();
    const port = server.address().port;
    const child = spawnMiner([
      '--backend', 'interpreter',
      '--pool', `127.0.0.1:${port}`,
      '--notls',
      '--user', 'she1qlrll6hhdakpcrlygumhq5a2xqhcj49ys7j2lzj.raskul',
      '--threads', '1',
    ]);
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !/job[= ]login-job/.test(stripAnsi(out))) {
      await new Promise((r) => setTimeout(r, 150));
    }
    const tickUntil = Date.now() + 2500;
    while (Date.now() < tickUntil && !/hashes=\d+/.test(stripAnsi(out))) {
      await new Promise((r) => setTimeout(r, 150));
    }
    child.kill('SIGTERM');
    await child.done;
    server.close();
    assert.match(loginLine, /"name":"ShearK-Miner"/);
    assert.match(loginLine, /"version":"2\.9"/);
    assert.match(loginLine, /"client":"ShearHash"/);
    assert.match(loginLine, /"algorithm":"ShearHash"/);
    assert.equal(/"dest"/.test(loginLine), false, loginLine);
    assert.equal(/"version":"1\.[019]"/.test(loginLine), false, loginLine);
    assert.match(out, /ShearK-Miner 2\.9 \(ShearHash-v3 light\)/);
    assert.match(stripAnsi(out), /hashes=\d+/);
    assert.match(stripAnsi(out), /accepted=0/);
    assert.match(stripAnsi(out), /rejected=0/);
    assert.match(out, /threads=1/);
    assert.match(stripAnsi(out), /job[= ]login-job/);
    assert.match(out, /shareBits=32/);
    assert.match(out, /blockBits=32/);
    assert.equal(/accepted=1/.test(out), false, out);
  });

  it('she1 login with owned ssa1 --dest still gets a 256-hex job', async () => {
    needBin();
    const header = Buffer.alloc(128);
    header[0] = 1;
    const job = {
      jobId: 'dest-job',
      header: header.toString('hex'),
      shareBits: 32,
      blockBits: 32,
      bits: 32,
    };
    let loginLine = '';
    const server = net.createServer((sock) => {
      sock.on('error', () => {});
      sock.on('data', (chunk) => {
        const text = chunk.toString();
        if (text.includes('"method":"login"')) {
          loginLine += text;
          sock.write(`${JSON.stringify({ id: 1, result: { status: 'OK' }, job })}\n`);
        }
      });
    });
    server.on('error', () => {});
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    server.unref();
    const port = server.address().port;
    const dest = 'ssa1qlrll6hhdakpcrlygumhq5a2xqhcj49ys7mhq4z';
    const child = spawnMiner([
      '--backend', 'interpreter',
      '--pool', `127.0.0.1:${port}`,
      '--notls',
      '--user', 'she1qlrll6hhdakpcrlygumhq5a2xqhcj49ys7j2lzj.raskul',
      '--dest', dest,
      '--threads', '1',
    ]);
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !/job[= ]dest-job/.test(stripAnsi(out))) {
      await new Promise((r) => setTimeout(r, 150));
    }
    child.kill('SIGTERM');
    await child.done;
    server.close();
    assert.match(loginLine, /"version":"2\.9"/);
    assert.match(loginLine, new RegExp(`"dest":"${dest}"`));
    assert.match(stripAnsi(out), /job[= ]dest-job/);
    assert.equal(header.toString('hex').length, 256);
  });

  it('two hash threads complete more hashes than one against the same job', async () => {
    needBin();
    const header = Buffer.alloc(128);
    header[0] = 1;
    const job = {
      jobId: 'scale-job',
      header: header.toString('hex'),
      shareBits: 32,
      blockBits: 32,
      bits: 32,
    };
    async function runThreads(n) {
      const server = net.createServer((sock) => {
        sock.on('error', () => {});
        sock.on('data', (chunk) => {
          if (chunk.toString().includes('"method":"login"')) {
            sock.write(`${JSON.stringify({ id: 1, result: { status: 'OK' }, job })}\n`);
          }
        });
      });
      server.on('error', () => {});
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      server.unref();
      const port = server.address().port;
      const child = spawnMiner([
        '--backend', 'interpreter',
        '--pool', `127.0.0.1:${port}`,
        '--notls',
        '--user', 'she1qlrll6hhdakpcrlygumhq5a2xqhcj49ys7j2lzj.raskul',
        '--threads', String(n),
      ]);
      let out = '';
      child.stdout.on('data', (d) => { out += d.toString(); });
      await new Promise((r) => setTimeout(r, 4500));
      child.kill('SIGTERM');
      await child.done;
      server.close();
      const lines = out.split('\n').filter((l) => l.includes('hashes='));
      assert.ok(lines.length >= 1, out);
      const last = lines[lines.length - 1];
      const m = /hashes=(\d+)/.exec(stripAnsi(last));
      assert.ok(m, last);
      return Number(m[1]);
    }
    const one = await runThreads(1);
    const two = await runThreads(2);
    assert.ok(two > one, `1-thread hashes=${one} 2-thread hashes=${two}`);
  });

  it('requireTls refuses a cleartext pool url in either flag order', () => {
    needBin();
    const user = 'she1qlrll6hhdakpcrlygumhq5a2xqhcj49ys7j2lzj.raskul';
    const first = spawnSync(bin, [
      '--require-tls', '--pool', 'stratum+tcp://127.0.0.1:1111',
      '--user', user, '--print-config',
    ], { timeout: 600_000, encoding: 'utf8' });
    assert.equal(first.status, 2, first.stdout + first.stderr);
    assert.match(first.stderr, /requireTls: refusing cleartext/);
    const second = spawnSync(bin, [
      '--pool', 'stratum+tcp://127.0.0.1:1111', '--require-tls',
      '--user', user, '--print-config',
    ], { timeout: 600_000, encoding: 'utf8' });
    assert.equal(second.status, 2, second.stdout + second.stderr);
    assert.match(second.stderr, /requireTls: refusing cleartext/);
    const bare = spawnSync(bin, [
      '--require-tls', '--pool', '127.0.0.1:1111', '--notls',
      '--user', user, '--print-config',
    ], { timeout: 600_000, encoding: 'utf8' });
    assert.equal(bare.status, 2, bare.stdout + bare.stderr);
    assert.match(bare.stderr, /requireTls: refusing cleartext/);
  });

  // The zips themselves are built and checked per OS by pack_linux.js and
  // pack_windows.js in sheark-packs.yml, never skipped here.
  it('sheark-packs runs the Linux and Windows pack checks on their own OS', () => {
    const wf = fs.readFileSync(path.join(root, '..', '.github', 'workflows', 'sheark-packs.yml'), 'utf8');
    const job = (name) => wf.split(new RegExp(`^  ${name}:`, 'm'))[1].split(/^ {2}\w[\w-]*:/m)[0];
    assert.match(job('linux'), /runs-on: ubuntu-/);
    assert.match(job('linux'), /node sheark-miner\/tests\/pack_linux\.js/);
    assert.match(job('windows'), /runs-on: windows-/);
    assert.match(job('windows'), /node sheark-miner\/tests\/pack_windows\.js/);
    assert.equal(/ShearK-Miner-2\.[0-8]-/.test(wf), false, 'stale pack version in sheark-packs.yml');
    for (const f of ['pack_linux.js', 'pack_windows.js']) {
      const src = fs.readFileSync(path.join(root, 'tests', f), 'utf8');
      assert.match(src, /assert\.equal\(process\.platform, '(linux|win32)'/);
      assert.equal(/\.skip\(|SKIP/.test(src), false, `${f} must fail, not skip`);
    }
  });

  it('unix pack script keeps a sample bat and shell launcher in every flavor', () => {
    const src = fs.readFileSync(path.join(root, 'pack/zip_unix.py'), 'utf8');
    for (const flavor of ['linux', 'archlinux', 'fedora', 'opensuse', 'macos']) {
      assert.match(src, new RegExp(`"${flavor}"`));
    }
    assert.match(src, /example\.bat/);
    assert.match(src, /example\.sh/);
    assert.match(src, /libssl/);
    assert.match(src, /libcrypto/);
    assert.match(src, /Refusing a cross-compile/);
    assert.match(src, /There is no --tls-insecure/);
    const mk = fs.readFileSync(path.join(root, 'Makefile'), 'utf8');
    assert.match(mk, /OPENSSL_PREFIX/);
    const selftest = fs.readFileSync(path.join(root, 'pack/selftest.sh'), 'utf8');
    assert.match(selftest, /98818c31d739ef821db0242f76bd244b96f1fb5049d27ea9a192e95c67b39a8b/);
  });

  it('the Linux pack recipe is portable unless SHEARK_NATIVE=1', () => {
    const mk = fs.readFileSync(path.join(root, 'Makefile'), 'utf8');
    const linux = mk.split('ifeq ($(UNAME),Linux)')[1].split('endif')[0];
    assert.equal(linux.includes('-march=native'), false);
    assert.match(mk, /ifeq \(\$\(SHEARK_NATIVE\),1\)[\s\S]*-march=native/);
    assert.equal(mk.includes('-DARCH=native'), false);
    // RandomX comes from the shared script, which pins the x86_64 baseline.
    assert.match(mk, /SHEARK_NATIVE=\$\(SHEARK_NATIVE\) RANDOMX_BUILD_DIR=\$\(RXBUILD\) bash \.\.\/scripts\/randomx_build\.sh/);
    assert.match(mk, /X86_BASELINE := -march=x86-64 -mtune=generic/);
    const rx = fs.readFileSync(path.join(root, '..', 'scripts', 'randomx_build.sh'), 'utf8');
    assert.match(rx, /ARCH=default/);
    assert.match(rx, /-march=x86-64 -mtune=generic/);
  });

  it('sheark-v4-afk defaults take the worker from the host file', () => {
    const run = fs.readFileSync(path.join(root, 'run-afk.sh'), 'utf8');
    const defs = fs.readFileSync(path.join(root, 'sheark-v4-afk.default'), 'utf8');
    const unit = fs.readFileSync(path.join(root, '..', 'deploy', 'sheark-v4-afk.service'), 'utf8');
    assert.match(run, /\$\{SHEARK_USER:\?\}/);
    assert.match(run, /\$\{SHEARK_BACKEND:-jit\}/);
    assert.match(run, /\$\{SHEARK_THREADS:-1\}/);
    assert.match(run, /--require-tls/);
    assert.match(run, /--pool "\$\{SHEARK_POOL:\?\}"/);
    assert.equal(run.includes('ssa1'), false);
    assert.equal(defs.includes('ssa1'), false);
    assert.equal(unit.includes('ssa1'), false);
    assert.match(defs, /SHEARK_POOL=stratum\+ssl:\/\/pool\.shear\.digital:443/);
    assert.match(defs, /SHEARK_THREADS=1/);
    assert.match(defs, /SHEARK_BACKEND=jit/);
    assert.equal(/^SHEARK_USER=/m.test(defs), false);
    assert.match(unit, /EnvironmentFile=\/etc\/default\/sheark-v4-afk/);
    assert.match(unit, /MemoryMax=2G/);
    assert.match(unit, /keeps this unit disabled/);
  });
});
