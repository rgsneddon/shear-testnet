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
