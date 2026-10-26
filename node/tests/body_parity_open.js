/**
 * Opens one datadir in this process and prints its body-parity line. The
 * parent compares it to the process that wrote the book: a block validated
 * fresh and the same block read back from disk must agree byte for byte.
 */
import { createStore } from '../src/store.js';
import { bodyParityLine } from './body_parity.js';

const dir = process.argv[2];
if (!dir) {
  process.stderr.write('dir\n');
  process.exit(2);
}
const store = createStore(dir);
process.stdout.write(`${JSON.stringify({ loadMode: store.loadMode, ...bodyParityLine(store) })}\n`);
