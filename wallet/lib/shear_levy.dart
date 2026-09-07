const kLevyFloorUnits = 100;
const kLevyBps = 2;
const kSurgeMax = 3.0;
const kSurgeRef = 2048;
const kChainId = 2701;
/// Hard ceiling: 0.001 SHE. Never quote more.
const kLevyCapNanos = 100000000;

int levyBase(int amountNanos) {
  final a = amountNanos < 0 ? 0 : amountNanos;
  final bps = (a * kLevyBps + 9999) ~/ 10000;
  return bps < kLevyFloorUnits ? kLevyFloorUnits : bps;
}

double levySurge(int depth) {
  final d = depth < 0 ? 0 : depth;
  final s = d / kSurgeRef;
  if (s <= 0) return 0;
  if (s >= kSurgeMax) return kSurgeMax;
  return s;
}

int levyNanos(int amountNanos, {int depth = 0}) {
  final base = levyBase(amountNanos);
  final surge = levySurge(depth);
  final raw = (base * (1 + surge)).ceil();
  return raw > kLevyCapNanos ? kLevyCapNanos : raw;
}

bool levyTaxed(String kind, {bool coinbase = false}) {
  if (coinbase) return false;
  const untaxed = {
    'claim',
    'withdraw',
    'hash',
    'pot',
    'reserve',
    'reserve-interest',
    'reserve-shortfall',
  };
  if (untaxed.contains(kind)) return false;
  const taxed = {
    'send',
    'evm-value',
    'pool-withdraw',
    'vortice-register',
    'transfer',
    'user-spend',
    'lock',
    'vote',
  };
  return taxed.contains(kind);
}
