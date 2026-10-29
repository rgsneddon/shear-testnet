// Weights must cover GitHub run 40647027785 (b3efdc26, green).
// Seconds are the sum of that file's outermost TAP suites. Suite time
// does not include process start, so a file at 0.7 of its cap is already
// close. The cap is the shipped fileCapMs, including the 330-minute clamp.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileCapMs } from './ci_shard_run.js';

const ci = JSON.parse(fs.readFileSync(new URL('./ci_run_40647027785_seconds.json', import.meta.url), 'utf8'));
const weight = JSON.parse(fs.readFileSync(new URL('./ci_timings.json', import.meta.url), 'utf8'));

test('timings are at least the last green CI seconds and under 0.7 of the cap', () => {
  const short = [];
  const near = [];
  for (const [file, sec] of Object.entries(ci)) {
    const need = Math.ceil(Number(sec));
    const have = Number(weight[file]);
    if (!(have >= need)) short.push(`${file} weight ${have} < CI ${need}s`);
    const capS = fileCapMs(file, weight) / 1000;
    const ratio = Number(sec) / capS;
    if (!(ratio < 0.7)) near.push(`${file} ${ratio.toFixed(3)} of ${capS}s`);
  }
  assert.deepEqual(short, [], short.slice(0, 12).join('\n'));
  assert.deepEqual(near, [], near.slice(0, 12).join('\n'));
});
