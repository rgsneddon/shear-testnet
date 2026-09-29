import 'dart:async';
import 'dart:convert';
import 'dart:io';

/// Accrual-tick guard for Continuum tip polls.
///
/// [tipBusy] must clear on success, throw, timeout, and cancel so a hung RPC
/// cannot freeze the displayed tip until restart.
const kWalletTipTimeout = Duration(seconds: 8);
/// Connect Bare asks for the tip and any seals still missing, on this cadence.
const kWalletHotPoll = Duration(seconds: 8);
const kWalletIdlePoll = Duration(seconds: 8);
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

/// Height from one node SSE frame. Only a `tip` event counts.
int? nodeTipHeightFromSse(String frame) {
  var tip = false;
  int? height;
  for (final raw in frame.split(RegExp(r'\r?\n'))) {
    final line = raw.trim();
    if (line.startsWith('event:')) {
      tip = line.substring('event:'.length).trim() == 'tip';
    } else if (tip && line.startsWith('data:')) {
      try {
        final decoded = jsonDecode(line.substring('data:'.length).trim());
        if (decoded is Map) {
          final h = decoded['height'];
          if (h is num && h > 0) height = h.toInt();
        }
      } catch (_) {}
    }
  }
  return tip ? height : null;
}

/// Follow the node's `/events` stream. A dropped stream waits and tries again.
Future<void> listenNodeTips({
  required String base,
  required bool Function() cancelled,
  required void Function(int height) onTip,
}) async {
  final root = base.endsWith('/') ? base.substring(0, base.length - 1) : base;
  final uri = Uri.parse('$root/events');
  final client = HttpClient()..connectionTimeout = const Duration(seconds: 8);
  try {
    while (!cancelled()) {
      try {
        final req = await client.getUrl(uri);
        req.headers.set(HttpHeaders.acceptHeader, 'text/event-stream');
        final res = await req.close();
        if (res.statusCode != 200) {
          await res.drain<void>();
          await Future<void>.delayed(kWalletIdlePoll);
          continue;
        }
        var buf = '';
        await for (final chunk in res.transform(utf8.decoder)) {
          if (cancelled()) break;
          buf += chunk;
          int cut;
          while ((cut = buf.indexOf('\n\n')) >= 0) {
            final frame = buf.substring(0, cut);
            buf = buf.substring(cut + 2);
            final height = nodeTipHeightFromSse(frame);
            if (height != null) onTip(height);
          }
        }
      } catch (_) {
        if (cancelled()) break;
        await Future<void>.delayed(kWalletIdlePoll);
      }
    }
  } finally {
    client.close(force: true);
  }
}
