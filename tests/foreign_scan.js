// The foreign-name grep and the line filter the shard scan uses.
// GNU grep on the CI runner. Args come before the pattern and the path.

export function foreignGrepArgs() {
  return [
    '-RIn',
    '--exclude-dir=.git',
    '--exclude-dir=node_modules',
    '-E',
  ];
}

// full-suite writes these two names at the checkout root only.
function shardOutput(line) {
  const file = line.split(':')[0].replace(/\\/g, '/');
  return file === './shard.tap' || file === './shard.txt';
}

// One grep hit. True means the line is a shipped-artifact hit.
export function keepForeignLine(line) {
  if (!line) return false;
  // full-suite writes these in the checkout. Their text is test output.
  if (shardOutput(line)) return false;
  if (line.includes('forbid_foreign_names.js')) return false;
  if (line.includes('/tests/')) return false;
  if (line.includes('specs/')) return false;
  if (line.includes('crypto/randomx/')) return false;
  // Licence notices must name upstream copyright holders as they wrote them,
  // and the vendored FCMP++ tree stays byte-identical to its pinned commit.
  if (line.includes('crypto/native/vendor/')) return false;
  if (line.startsWith('./THIRD_PARTY_NOTICES.txt')) return false;
  if (line.startsWith('./LICENSES/')) return false;
  if (line.includes('assets/licenses/THIRD_PARTY_NOTICES.txt')) return false;
  if (line.startsWith('./scripts/licenses/')) return false;
  if (line.startsWith('./docs/licensing-audit.md')) return false;
  if (line.includes('package-lock.json')) return false;
  if (line.includes('package.json')) return false;
  if (line.includes('crypto/reserve_evm.js')) return false;
  if (line.includes('wallet/lib/shear_eip712.dart')) return false;
  return true;
}
