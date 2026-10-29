/**
 * main's macOS ShearK job is .github/workflows/sheark-28.yml. It installs
 * Homebrew openssl with no major. That formula is not one version on every
 * image. The job must install openssl@3 and compile against that keg.
 * A comment is not a brew command. openssl@3 is one token, not openssl.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = path.join(root, '.github/workflows/sheark-28.yml');

/** Top-level jobs of a workflow: name -> its lines. */
function jobsOf(text) {
  const lines = text.split('\n');
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

/** Package tokens of every `brew install` command. A comment is not a command. */
function brewInstallTokens(text) {
  const tokens = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('#')) continue;
    const matched = trimmed.match(/^brew install\s+(.*)$/);
    if (!matched) continue;
    let rest = matched[1];
    while (rest.endsWith('\\')) {
      rest = rest.slice(0, -1);
      i += 1;
      const cont = (lines[i] || '').trim();
      if (cont.startsWith('#')) break;
      rest += ` ${cont}`;
    }
    rest = rest.split('#')[0];
    for (const tok of rest.trim().split(/\s+/)) {
      if (tok && !tok.startsWith('-')) tokens.push(tok);
    }
  }
  return tokens;
}

/** `openssl` and `openssl@N` are formula tokens. `openssl@3` is one token, not `openssl`. */
function opensslFormulaTokens(tokens) {
  return tokens.filter((t) => t === 'openssl' || t.startsWith('openssl@'));
}

function brewPrefixFormulas(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) continue;
    for (const matched of trimmed.matchAll(/brew --prefix\s+([^\s"')]+)/g)) out.push(matched[1]);
  }
  return out;
}

function isMacosBuildJob(lines) {
  const body = lines.join('\n');
  return /runs-on:\s*macos-/.test(body) && /make -C sheark-miner\b/.test(body);
}

describe('sheark-28 macOS OpenSSL formula', () => {
  it('the macOS job installs openssl@3, not the unpinned openssl formula', () => {
    const text = fs.readFileSync(workflowPath, 'utf8').replace(/\r\n/g, '\n');
    const jobs = jobsOf(text);
    const slices = [...jobs.entries()].filter(([, lines]) => isMacosBuildJob(lines));
    assert.ok(slices.length >= 1, 'no macOS job builds ShearK-Miner');

    for (const [name, lines] of slices) {
      const body = lines.join('\n');
      const installed = opensslFormulaTokens(brewInstallTokens(body));
      assert.deepEqual(
        installed,
        installed.map(() => 'openssl@3'),
        `${name} brew install OpenSSL token is ${installed.join(', ') || '(none)'}; want openssl@3`,
      );
      assert.ok(installed.length >= 1, `${name} does not brew install openssl@3`);
      const prefixes = brewPrefixFormulas(body).filter((p) => p === 'openssl' || p.startsWith('openssl@'));
      assert.deepEqual(
        prefixes,
        prefixes.map(() => 'openssl@3'),
        `${name} brew --prefix OpenSSL is ${prefixes.join(', ') || '(none)'}; want openssl@3`,
      );
      assert.ok(prefixes.length >= 1, `${name} does not take the openssl@3 keg prefix`);
    }

    const stray = opensslFormulaTokens(brewInstallTokens(text)).filter((t) => t !== 'openssl@3');
    assert.deepEqual(stray, [], 'unpinned brew install openssl token (not openssl@3)');
  });
});
