import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_auto_send_delay.dart';
import 'package:shear_wallet/shear_ctf.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_session.dart';

void main() {
  test('delay bytes follow the shared spec weights', () {
    final text = _specText();
    final weights = _specWeights(text);
    expect(RegExp(r'qEpochBlocks = 8').hasMatch(text), isTrue);
    expect(weights, kAutoSendDelayWeights);
    expect(kAutoSendEpochBlocks, 8);
    expect(weights.fold<int>(0, (a, b) => a + b), 256);
    final counts = List<int>.filled(weights.length, 0);
    for (var b = 0; b < 256; b++) {
      final k = autoSendDelayEpochs(b);
      counts[k] += 1;
      final hold = AutoSendHold.draw(sealedTip: 16, byte: b);
      expect(hold.epochs, k);
      expect(hold.epochBase, 2);
      expect(hold.releaseEpoch, 2 + k);
      expect(hold.toJson()['v'], 1);
      expect(hold.ready(16 + k * kAutoSendEpochBlocks), isTrue);
      if (k > 0) {
        expect(hold.ready(16 + k * kAutoSendEpochBlocks - 1), isFalse);
      }
    }
    expect(counts, weights);
  });

  test('the delay is applied only to automatic sends', () async {
    final ledger = ShearLedger();
    ledger.restoreSealedTip(16);
    ledger.queueMinerPayoutSweep(byte: 200);
    expect(ledger.exportAutoSendDelay()!['epochs'], 5);
    expect(ledger.automaticBroadcastAllowed(), isFalse);

    await expectLater(
      ledger.send(from: 'a', to: 'b', amount: 1, automatic: true),
      throwsA(isA<StateError>().having((e) => e.message, 'message', 'auto_send_waiting')),
    );
    expect(ledger.exportAutoSendDelay()!['epochs'], 5);

    final manual = ShearLedger();
    await expectLater(
      manual.send(from: 'a', to: 'b', amount: 0),
      throwsA(isA<ArgumentError>()),
    );
    expect(manual.exportAutoSendDelay(), isNull);

    await expectLater(
      ledger.send(from: 'a', to: 'b', amount: 0),
      throwsA(isA<ArgumentError>()),
    );
    expect(ledger.exportAutoSendDelay()!['epochs'], 5);

    ledger.restoreSealedTip(16 + 5 * kAutoSendEpochBlocks);
    expect(ledger.automaticBroadcastAllowed(), isTrue);
    await expectLater(
      ledger.send(from: 'a', to: 'b', amount: 0, automatic: true),
      throwsA(isA<ArgumentError>().having((e) => e.message, 'message', 'amount')),
    );
    expect(ledger.exportAutoSendDelay()!['epochs'], 5);

    ledger.queueAutoConsolidate(byte: 0);
    expect(ledger.exportAutoSendDelay()!['epochs'], 5);
  });

  test('a successful automatic send clears the hold; a manual send does not', () async {
    final id = createIdentity();
    final ledger = ShearLedger()..bindIdentity(id);
    final dest = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    ledger.confirmRound(address: dest, pot: 1, height: 16);
    ledger.settleTo(16 + ShearLedger.spendableConfirmations - 1);
    ledger.queueMinerPayoutSweep(byte: 200);
    final bob = destForLogin(createIdentity().address, height: 1, viewKey: 'ab' * 32)!;

    await expectLater(
      ledger.send(
        from: dest,
        to: bob,
        amount: 0.1,
        restFrame: id.address,
        paymentCode: id.paymentCode,
        automatic: true,
      ),
      throwsA(isA<StateError>().having((e) => e.message, 'message', 'auto_send_waiting')),
    );

    final manual = await ledger.send(
      from: dest,
      to: bob,
      amount: 0.1,
      restFrame: id.address,
      paymentCode: id.paymentCode,
    );
    expect(manual.amount, 0.1);
    expect(ledger.exportAutoSendDelay()!['epochs'], 5);

    ledger.restoreSealedTip(ledger.sealedHeight + 5 * kAutoSendEpochBlocks);
    expect(ledger.automaticBroadcastAllowed(), isTrue);
    final swept = await ledger.send(
      from: dest,
      to: bob,
      amount: 0.1,
      restFrame: id.address,
      paymentCode: id.paymentCode,
      automatic: true,
    );
    expect(swept.amount, 0.1);
    expect(ledger.exportAutoSendDelay(), isNull);

    ledger.queueAutoConsolidate(byte: 255);
    expect(ledger.exportAutoSendDelay()!['epochs'], 7);
  });

  test('the hold survives a wallet restart', () async {
    final dir = await Directory.systemTemp.createTemp('shear-auto-send');
    addTearDown(() => dir.delete(recursive: true));
    final store = File('${dir.path}/session.json');
    final first = ShearSession(store: store);
    await first.setPassword('correct-horse', confirm: 'correct-horse');
    final ledger = ShearLedger()..bindIdentity(first.identity!);
    ledger.restoreSealedTip(16);
    ledger.queueMinerPayoutSweep(byte: 200);
    final saved = ledger.exportAutoSendDelay();
    first.rememberedAutoSendDelay = saved;
    first.rememberedSealedHeight = ledger.sealedHeight;
    await first.persist();

    final locked = ShearSession(store: store);
    final id = await locked.unlock('correct-horse');
    expect(locked.rememberedAutoSendDelay, saved);

    final again = ShearLedger()..bindIdentity(id);
    again.restoreSealedTip(locked.rememberedSealedHeight);
    again.restoreAutoSendDelay(locked.rememberedAutoSendDelay);
    expect(again.exportAutoSendDelay(), saved);
    expect(again.automaticBroadcastAllowed(), isFalse);
    again.queueAutoConsolidate(byte: 3);
    expect(again.exportAutoSendDelay()!['epochs'], saved!['epochs']);
    again.restoreSealedTip(16 + 5 * kAutoSendEpochBlocks);
    expect(again.automaticBroadcastAllowed(), isTrue);
  });

  test('a credit sync with no pool does not start the hold', () async {
    final id = createIdentity();
    final ledger = ShearLedger()..bindIdentity(id);
    await ledger.syncCredits(id.address, paymentCode: id.paymentCode);
    expect(ledger.exportAutoSendDelay(), isNull);
  });

  test('a hold record that is not this distribution is rejected', () {
    expect(
      AutoSendHold.tryParse({'v': 1, 'epochBase': 1, 'epochs': 2, 'releaseEpoch': 9}),
      isNull,
    );
    expect(
      AutoSendHold.tryParse({'v': 2, 'epochBase': 1, 'epochs': 2, 'releaseEpoch': 3}),
      isNull,
    );
    final ledger = ShearLedger();
    ledger.restoreAutoSendDelay({'v': 1, 'epochBase': 2, 'epochs': 5, 'releaseEpoch': 7});
    expect(ledger.exportAutoSendDelay()!['releaseEpoch'], 7);
    ledger.restoreAutoSendDelay({'v': 1, 'epochBase': 2, 'epochs': 5, 'releaseEpoch': 8});
    expect(ledger.exportAutoSendDelay()!['releaseEpoch'], 7);
  });
}

String _specText() {
  var dir = Directory.current;
  for (var i = 0; i < 6; i++) {
    final file = File('${dir.path}/docs/wallet-auto-send-delay.md');
    if (file.existsSync()) return file.readAsStringSync();
    final parent = dir.parent;
    if (parent.path == dir.path) break;
    dir = parent;
  }
  throw StateError('wallet-auto-send-delay.md');
}

List<int> _specWeights(String text) {
  final match = RegExp(r'weights = \[([0-9, ]+)\]').firstMatch(text);
  expect(match, isNotNull);
  return match!.group(1)!.split(',').map((s) => int.parse(s.trim())).toList();
}
