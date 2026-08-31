import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

describe('wallet cut updates the pool wallet', () => {
  it('macos pack always syncs this pin to Dedicated-de /opt/shear-v2/wallet', () => {
    const dart = read('wallet/lib/main.dart');
    const sh = read('wallet/pack/sync_pool_wallet.sh');
    const mac = read('wallet/pack_macos.sh');
    const linux = read('wallet/pack/pack_linux_de.sh');
    assert.match(dart, /kWalletVersion = '0\.9'/);
    assert.match(sh, /\/opt\/shear-v2\/wallet/);
    assert.match(sh, /kWalletVersion/);
    assert.match(sh, /shear_eip712/);
    assert.match(mac, /sync_pool_wallet\.sh/);
    assert.match(linux, /flutter build linux/);
    assert.match(linux, /shear-wallet-\{ver\}-linux\.zip/);
    assert.match(linux, /shear-wallet-\{ver\}-archlinux\.zip/);
  });
});
