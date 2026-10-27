#!/usr/bin/env node
/**
 * Run the slow node harness files one at a time.
 *
 *   node node/tests/run_slow.js
 *   node node/tests/run_slow.js test_levy_verify.js
 *
 * Each file has a wall-clock cap in slow_caps.js. The process group is killed
 * at that cap. Node's own timer does not run while a synchronous native prove
 * holds the event loop, so this outer kill is the file cap. A kill while the
 * tree is idle is a hang. A kill while it is still burning CPU means the cap
 * is shorter than the work.
 * SHEAR_SLOW_CAP_MS overrides every cap for a measurement run.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SLOW_FILES } from './slow_caps.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const clk = Number(spawnSync('getconf', ['CLK_TCK'], { timeout: 600_000, encoding: 'utf8' }).stdout) || 100;
const override = Number(process.env.SHEAR_SLOW_CAP_MS || 0);
const wanted = process.argv.slice(2).filter((arg) => arg && !arg.startsWith('--'));
const list = wanted.length
  ? SLOW_FILES.filter((row) => wanted.some((name) => row.file.includes(name)))
  : SLOW_FILES.slice();

if (!list.length) {
  console.error(`no slow file matches ${wanted.join(', ')}`);
  process.exit(2);
}

function procCpuTicks(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    return (Number(rest[11]) || 0) + (Number(rest[12]) || 0);
  } catch {
    return 0;
  }
}

function descendantPids(pid, out = []) {
  let kids = '';
  try {
    kids = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8');
  } catch {
    return out;
  }
  for (const part of kids.trim().split(/\s+/)) {
    const child = Number(part);
    if (!child) continue;
    out.push(child);
    descendantPids(child, out);
  }
  return out;
}

function treeCpuMs(pid) {
  const pids = [pid, ...descendantPids(pid)];
  let ticks = 0;
  for (const id of pids) ticks += procCpuTicks(id);
  return (ticks * 1000) / clk;
}

function tailLines(text, n) {
  return String(text || '').split(/\r?\n/).filter((line) => line.trim()).slice(-n);
}

function runOne(entry) {
  const capMs = override > 0 ? override : entry.capMs;
  const file = path.join(root, 'node/tests', entry.file);
  const args = [
    '--test',
    '--test-concurrency=1',
    `--test-timeout=${capMs}`,
    '--test-reporter=spec',
    file,
  ];
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, args, {
      cwd: root,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const samples = [];
    const sample = () => {
      samples.push({ at: Date.now() - t0, cpuMs: treeCpuMs(child.pid) });
    };
    sample();
    const sampler = setInterval(sample, 5000);
    let killed = false;
    const killGroup = (sig) => {
      try { process.kill(-child.pid, sig); } catch { /* already gone */ }
      try { child.kill(sig); } catch { /* already gone */ }
    };
    const killer = setTimeout(() => {
      sample();
      killed = true;
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 8000);
    }, capMs);
    const onData = (chunk, sink) => {
      const text = chunk.toString('utf8');
      if (sink === 'out') out += text;
      else err += text;
      process.stdout.write(text);
    };
    child.stdout.on('data', (chunk) => onData(chunk, 'out'));
    child.stderr.on('data', (chunk) => onData(chunk, 'err'));
    let settled = false;
    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      clearInterval(sampler);
      const wallMs = Date.now() - t0;
      const live = samples.filter((row) => row.cpuMs > 0);
      const cpuMs = live.reduce((max, row) => Math.max(max, row.cpuMs), 0);
      const recent = live.filter((row) => wallMs - row.at <= 25000);
      const recentCpu = recent.length >= 2
        ? recent[recent.length - 1].cpuMs - recent[0].cpuMs
        : (recent[0]?.cpuMs || 0);
      const recentWindow = recent.length >= 2
        ? Math.max(1, recent[recent.length - 1].at - recent[0].at)
        : wallMs;
      const busy = recentWindow > 0 && recentCpu / recentWindow > 0.25;
      const summary = `${out}\n${err}`;
      const tests = Number((summary.match(/^# tests (\d+)/m) || [])[1] || 0);
      const pass = Number((summary.match(/^# pass (\d+)/m) || [])[1] || 0);
      const fail = Number((summary.match(/^# fail (\d+)/m) || [])[1] || 0);
      const cancelled = Number((summary.match(/^# cancelled (\d+)/m) || [])[1] || 0);
      const skipped = Number((summary.match(/^# skipped (\d+)/m) || [])[1] || 0);
      const duration = (summary.match(/^# duration_ms ([\d.]+)/m) || [])[1] || '';
      let result = 'fail';
      if (code === 0 && !killed) result = 'pass';
      else if (killed && !busy) result = 'hang';
      else if (killed) result = 'cap';
      else if (signal) result = 'signal';
      const row = {
        file: entry.file,
        capMs,
        wallMs,
        cpuMs: Math.round(cpuMs),
        recentCpuMs: Math.round(recentCpu),
        exit: code,
        signal: signal || '',
        result,
        tests,
        pass,
        fail,
        cancelled,
        skipped,
        durationMs: duration,
        tail: tailLines(summary, 12),
      };
      resolve(row);
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      clearInterval(sampler);
      resolve({
        file: entry.file,
        capMs,
        wallMs: Date.now() - t0,
        result: 'fail',
        exit: 1,
        signal: '',
        error: String(err && err.message || err),
        tail: [],
      });
    });
  });
}

const rows = [];
for (const entry of list) {
  console.log(`\n=== ${entry.file} cap ${override > 0 ? override : entry.capMs} ms ===`);
  const row = await runOne(entry);
  rows.push(row);
  console.log(`SLOW file=${row.file} result=${row.result} wall_ms=${row.wallMs} cpu_ms=${row.cpuMs || 0} exit=${row.exit} signal=${row.signal || ''} tests=${row.tests || 0} pass=${row.pass || 0} fail=${row.fail || 0} cap_ms=${row.capMs}`);
}

const outPath = '/tmp/shear-slow-results.json';
fs.writeFileSync(outPath, `${JSON.stringify(rows, null, 2)}\n`);
console.log(`\nWROTE ${outPath}`);
const bad = rows.filter((row) => row.result !== 'pass');
process.exit(bad.length ? 1 : 0);
