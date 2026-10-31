/**
 * The operator admin hostname, as a salted hash only (tests/operator_host.json):
 * the tests that keep it out of the public tree must not carry it themselves.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';

/** A check that is true when any letters-and-digits word of a text hashes, with `salt`, to `sha256`. */
export function makeHostCheck(salt, sha256) {
  return (text) => {
    const words = new Set(String(text).toLowerCase().match(/[a-z0-9]+/g) || []);
    for (const w of words) {
      if (createHash('sha256').update(`${salt}:${w}`).digest('hex') === sha256) return true;
    }
    return false;
  };
}

const { salt, sha256 } = JSON.parse(fs.readFileSync(new URL('./operator_host.json', import.meta.url), 'utf8'));

/** True when the text names the operator hostname. */
export const namesOperatorHost = makeHostCheck(salt, sha256);
