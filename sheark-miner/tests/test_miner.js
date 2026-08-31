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

describe('ShearK-Miner', () => {
  it('selftest and print-config are ShearHash-v2 light', () => {
    assert.equal(fs.existsSync(bin), true, `missing ${bin}`);
    const st = spawnSync(bin, ['--backend', 'interpreter', '--selftest'], { encoding: 'utf8' });
    assert.equal(st.status, 0, st.stderr + st.stdout);
    assert.match(st.stdout, /selftest ok 64d41fa97f5ebea8a7e2a2625b1824467ce9d081bf29b0b2ae0a7fe617599895/);
    assert.match(st.stdout, /k e46e00191cde74015961b7a68274933c680b69f05bdbbad1ef51e75fbc19f389/);
    assert.match(st.stdout, /client=ShearHash/);
    assert.match(st.stdout, /algorithm=ShearHash/);
    assert.match(st.stdout, /personalisation=ShearHash-v2/);
    assert.equal(st.stdout.includes('5d00a24233609829e59d6e83d9fcd2f262c4014e772a23024fd3db4e66ee2066'), false);
    assert.equal(st.stdout.toLowerCase().includes('feeless'), false);
    const cfg = spawnSync(bin, ['--print-config'], { encoding: 'utf8' });
    assert.equal(cfg.status, 0, cfg.stderr);
    const j = JSON.parse(cfg.stdout);
    assert.equal(j.name, 'ShearK-Miner');
    assert.equal(j.client, 'ShearHash');
    assert.equal(j.algorithm, 'ShearHash');
    assert.equal(j.personalisation, 'ShearHash-v2');
    assert.equal(j.version, '1.5');
    assert.equal(j.version.split('.').length, 2);
    assert.equal(j.headerBytes, 128);
    assert.equal(j.magic, 'shear-testnet-v2');
    assert.equal(j.rxMode, 'light');
    assert.equal(j.rxCacheMiB, 128);
    assert.equal(j.feePct, 0);
    assert.equal(j.clientLogin, 'direct');
    assert.equal(j.pool, 'pool.shear.digital:1111');
    assert.equal(j.feeDest, undefined);
    const src = fs.readFileSync(path.join(root, 'src/sheark_miner.c'), 'utf8');
    assert.equal(src.toLowerCase().includes('feeless'), false);
    assert.equal(/g_fee_login/.test(src), false);
    const help = spawnSync(bin, ['--help'], { encoding: 'utf8' });
    assert.match(help.stdout, /ShearK-Miner 1\.5 \(ShearHash-v2 light\)/);
    assert.match(help.stdout, /ShearHash-v2 light/);
    assert.equal(help.stdout.toLowerCase().includes('feeless'), false);
    assert.match(src, /hashes=%llu round=%llu hashrate=%s accepted=%d rejected=%d submitted=%llu blocks=%d dropped=%llu/);
    assert.match(src, /cpuCores=%d cpuThreads=%d/);
    assert.match(src, /BLOCKFOUND!!!/);
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
    assert.match(hashc, /shear_bind/);
    assert.match(hashc, /randomx_calculate_hash_next/);
    assert.match(hashc, /RANDOMX_FLAG_FULL_MEM/);
    assert.match(hashc, /backend_matches_selftest_locked/);
    assert.equal(/randomx_calculate_hash\(g_vm,/.test(hashc), false);
    assert.match(src, /pthread_setaffinity_np/);
    assert.match(src, /g_cpu_map/);
    assert.match(src, /s\.gen != live_gen/);
    assert.match(src, /enqueue_share\(job\.jobId, n, hash, job\.gen\)/);
    assert.match(src, /enqueue_share\(job\.jobId, primed_n, hash, job\.gen\)/);
    assert.match(src, /#define IN_FLIGHT_MAX 1/);
    assert.match(src, /strstr\(low, "busy"\)/);
    assert.match(src, /memcmp\(g_main_job\.header, job\.header, 100\)/);
    assert.match(src, /g_smooth_hs/);
    assert.match(src, /Blockfound RandomX K pause/);
    assert.match(src, /RATE_HOLD_FRAC 0\.9/);
    assert.match(src, /RATE_MIN_DT 2/);
    assert.match(src, /g_rate_t0 = time\(NULL\)/);
    assert.equal(/g_smooth_hs \* 0\.5/.test(src), false);
  });

  it('leftover windows zip is only ShearK-Miner.exe + example.bat', () => {
    const zip = path.join(root, '..', 'dist', 'ShearK-Miner-1.4-windows.zip');
    if (!fs.existsSync(zip)) return;
    const listed = spawnSync('tar', ['-tf', zip], { encoding: 'utf8' });
    const names = (listed.status === 0 ? listed.stdout : '')
      .split(/\r?\n/).map((s) => s.replace(/\\/g, '/').trim()).filter(Boolean);
    let zipNames = names;
    if (zipNames.length === 0) {
      const py = spawnSync('python', ['-c',
        'import zipfile,sys; print("\\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))', zip],
        { encoding: 'utf8' });
      assert.equal(py.status, 0, py.stderr);
      zipNames = py.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    }
    assert.deepEqual(zipNames.sort(), ['ShearK-Miner.exe', 'example.bat'].sort());
  });

  it('1.5 linux zip is ELF, never Darwin Mach-O', () => {
    const zip = path.join(root, '..', 'dist', 'ShearK-Miner-1.5-linux.zip');
    if (!fs.existsSync(zip)) return;
    const py = spawnSync('python3', ['-c',
      'import zipfile,sys\n'
      + 'z=zipfile.ZipFile(sys.argv[1])\n'
      + 'print("\\n".join(z.namelist()))\n'
      + 'b=z.read("ShearK-Miner")[:4]\n'
      + 'print("MAGIC", b.hex())\n'
      + 'print("MODE", oct((z.getinfo("ShearK-Miner").external_attr >> 16) & 0o777))',
      zip], { encoding: 'utf8' });
    assert.equal(py.status, 0, py.stderr);
    const out = py.stdout;
    assert.match(out, /ShearK-Miner/);
    assert.match(out, /example\.sh/);
    assert.match(out, /MAGIC 7f454c46/);
    assert.equal(/MAGIC cffaedfe/.test(out), false);
  });

  it('leftover linux zip is ShearK-Miner + example.sh', () => {
    const zip = path.join(root, '..', 'dist', 'ShearK-Miner-1.4-linux.zip');
    if (!fs.existsSync(zip)) return;
    const py = spawnSync('python3', ['-c',
      'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]);\n'
      + 'print("\\n".join(i.filename for i in z.infolist()));\n'
      + 'print("MODE", oct((z.getinfo("ShearK-Miner").external_attr >> 16) & 0o777))',
      zip], { encoding: 'utf8' });
    assert.equal(py.status, 0, py.stderr);
    const lines = py.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    assert.ok(lines.includes('ShearK-Miner'));
    assert.ok(lines.includes('example.sh'));
    assert.ok(lines.includes('MODE 0o755') || lines.includes('MODE 0755'));
  });

  it('login status=OK does not bump accepted; status line prints hashes and job bits', async () => {
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
    const port = server.address().port;
    const child = spawn(bin, [
      '--backend', 'interpreter',
      '--pool', `127.0.0.1:${port}`,
      '--notls',
      '--user', 'she1qlrll6hhdakpcrlygumhq5a2xqhcj49ys7j2lzj.raskul',
      '--threads', '1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !/hashes=\d+/.test(out)) {
      await new Promise((r) => setTimeout(r, 150));
    }
    child.kill('SIGTERM');
    await new Promise((r) => child.once('close', r));
    server.close();
    assert.match(loginLine, /"name":"ShearK-Miner"/);
    assert.match(loginLine, /"version":"1\.5"/);
    assert.match(loginLine, /"client":"ShearHash"/);
    assert.match(loginLine, /"algorithm":"ShearHash"/);
    assert.equal(/"version":"1\.[01]"/.test(loginLine), false, loginLine);
    assert.match(out, /ShearK-Miner 1\.5 \(ShearHash-v2 light\)/);
    assert.match(out, /hashes=(?:\x1b\[(?:32m|1;92m))?\d+/);
    assert.match(out, /accepted=(?:\x1b\[(?:33m|1;93m))?0/);
    assert.match(out, /rejected=(?:\x1b\[(?:31m|1;91m))?0/);
    assert.match(out, /threads=1/);
    assert.match(out, /job=login-job/);
    assert.match(out, /shareBits=32/);
    assert.match(out, /blockBits=32/);
    assert.equal(/accepted=1/.test(out), false, out);
  });

  it('two hash threads complete more hashes than one against the same job', async () => {
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
      const port = server.address().port;
      const child = spawn(bin, [
        '--backend', 'interpreter',
        '--pool', `127.0.0.1:${port}`,
        '--notls',
        '--user', 'she1qlrll6hhdakpcrlygumhq5a2xqhcj49ys7j2lzj.raskul',
        '--threads', String(n),
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d) => { out += d.toString(); });
      await new Promise((r) => setTimeout(r, 4500));
      child.kill('SIGTERM');
      await new Promise((r) => child.once('close', r));
      server.close();
      const lines = out.split('\n').filter((l) => l.includes('hashes='));
      assert.ok(lines.length >= 1, out);
      const last = lines[lines.length - 1];
      const m = /hashes=(?:\x1b\[(?:32m|1;92m))?(\d+)/.exec(last);
      assert.ok(m, last);
      return Number(m[1]);
    }
    const one = await runThreads(1);
    const two = await runThreads(2);
    assert.ok(two > one, `1-thread hashes=${one} 2-thread hashes=${two}`);
  });
});
