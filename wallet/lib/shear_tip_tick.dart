/// Accrual-tick guard for Continuum tip polls.
///
/// [tipBusy] must clear on success, throw, timeout, and cancel so a hung RPC
/// cannot freeze the displayed tip until restart.
const kWalletTipTimeout = Duration(seconds: 8);
const kWalletHotPoll = Duration(seconds: 1);
const kWalletIdlePoll = Duration(seconds: 4);
const kWalletVaultGap = Duration(seconds: 30);

bool walletPollIsHot({
  required bool tipMoved,
  required bool pendingReceive,
  required bool historyBehindTip,
}) =>
    tipMoved || pendingReceive || historyBehindTip;

/// Continuum repaints when the owned Spendable sum changes.
///
/// That sum is what the pane shows. The she1 mailbox figure can stay put
/// while a sibling dest is overwritten, and owed-π is a separate line.
/// Under a pool, a missed pull is not a finished sync.
///
/// There is no Sync button. Unlock and the accrual tick are the only
/// writers. This line is the soft block after the one balance retry fails.
String? continuumUnsyncedLine({
  required bool poolAttached,
  required bool creditSyncLanded,
}) {
  if (!poolAttached || creditSyncLanded) return null;
  return 'Live balance has not written yet. This is not a finished sync.';
}

bool continuumFrameDirty({
  required int sealed,
  required int lastSealed,
  required int ownedUnits,
  required int lastOwnedUnits,
  required int owedUnits,
  required int lastOwedUnits,
  required int pendingCount,
  required int lastPendingCount,
  required bool tipMoved,
}) =>
    sealed != lastSealed ||
    ownedUnits != lastOwnedUnits ||
    owedUnits != lastOwedUnits ||
    pendingCount != lastPendingCount ||
    tipMoved;

bool walletShouldPoll({
  required DateTime lastPoll,
  required DateTime now,
  required bool hot,
}) {
  final gap = now.difference(lastPoll);
  if (hot) return !lastPoll.isAfter(now) && gap >= kWalletHotPoll;
  return gap >= kWalletIdlePoll;
}

Future<void> runTipAccrualTick({
  required bool busy,
  required void Function(bool) setBusy,
  required Future<void> Function() work,
  Duration timeout = kWalletTipTimeout,
}) async {
  if (busy) return;
  setBusy(true);
  try {
    await work().timeout(timeout);
  } catch (_) {
    // Keep last good sealed tip. Next tick retries.
  } finally {
    setBusy(false);
  }
}
