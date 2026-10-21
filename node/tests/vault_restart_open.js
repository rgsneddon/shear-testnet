/**
 * Opens one datadir in this process and prints the tip, the supply, the
 * vault root, and the portal ids. The parent test compares that line to the
 * process that wrote the book. An in-process createStore shares the FS-1
 * tree and does not take this path.
 */
import { createStore } from '../src/store.js';
import { supplyIdentity } from '../../crypto/reserve_vault.js';
import { auditCirculatingSupply } from '../src/supply.js';

const dir = process.argv[2];
if (!dir) {
  process.stderr.write('dir\n');
  process.exit(2);
}

const store = createStore(dir);
const tip = store.tip();
const identity = supplyIdentity(store.reserveVault);
const audit = auditCirculatingSupply(store.blocks);
const portals = Object.keys(store.reserveVault.portals || {}).sort();
process.stdout.write(`${JSON.stringify({
  loadMode: store.loadMode,
  height: tip ? Number(tip.height) : 0,
  hash: tip ? Buffer.from(tip.hash).toString('hex') : '',
  circulating: audit.circulatingNanos,
  supplyStatus: audit.status,
  identityOk: identity.ok === true,
  principal: identity.principalNanos,
  vaultRoot: String(store.reserveVault.vaultLockRoot || ''),
  portals,
})}\n`);
