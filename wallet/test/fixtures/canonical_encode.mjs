// The node's canonical tx encoding (crypto/canonical_row.js), for the wallet
// test that checks its port byte for byte.
//   node test/fixtures/canonical_encode.mjs <file of JSON values, one per line>
// Prints one JSON line per input: { enc, alias }.
import fs from 'node:fs';
import { canonicalAliasPath, canonicalEncode } from '../../../crypto/canonical_row.js';

const lines = fs.readFileSync(process.argv[2], 'utf8').split('\n').filter((l) => l.length);
for (const line of lines) {
  const v = JSON.parse(line);
  process.stdout.write(`${JSON.stringify({ enc: canonicalEncode(v), alias: canonicalAliasPath(v) })}\n`);
}
