import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/main.dart' show BookMagicRefusedApp;
import 'package:shear_wallet/shear_checkpoint.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';

/// Russell, 28 Oct: book magic is a build-time setting (SHEAR_BOOK_MAGIC,
/// default shear-testnet-v12). A release or profile build runs only the
/// testnet and mainnet books. The regtest checkpoint (node/tests/
/// regtest_checkpoint.json) is taken only by the regtest book.

CheckpointPin _regtestPin() {
  final raw = jsonDecode(File('../node/tests/regtest_checkpoint.json').readAsStringSync());
  final pin = checkpointPinFromJson(Map<String, dynamic>.from(raw as Map));
  if (pin == null) throw StateError('regtest checkpoint is not well formed');
  return pin;
}

void main() {
  test('the default build is the testnet book', () {
    expect(kBookMagic, kTestnetBookMagic);
    expect(bookMagicRefusal(), isNull);
  });

  test('a release or profile build with any other magic refuses at start, with a clear line', () {
    for (final magic in [kRegtestBookMagic, 'shear-dev', 'shear-testnet-v11', '']) {
      final line = bookMagicRefusal(magic, true);
      expect(line, isNotNull, reason: magic);
      expect(line, contains('"$magic"'));
      expect(line, contains(kTestnetBookMagic));
      expect(line, contains(kMainnetBookMagic));
    }
    expect(bookMagicRefusal(kTestnetBookMagic, true), isNull);
    expect(bookMagicRefusal(kMainnetBookMagic, true), isNull);
    // A debug or test build may run the regtest book.
    expect(bookMagicRefusal(kRegtestBookMagic, false), isNull);
    expect(bookMagicRefusal('', false), isNotNull);
  });

  test('main() checks the book magic before anything else opens', () {
    final src = File('lib/main.dart').readAsStringSync();
    final body = src.substring(src.indexOf('Future<void> main(List<String> args) async {'));
    final check = body.indexOf('bookMagicRefusal()');
    expect(check, greaterThan(0));
    for (final later in ['releaseCheckpointMissing()', 'armWalletConnect()', 'runApp(ShearWalletApp(']) {
      expect(check, lessThan(body.indexOf(later)), reason: later);
    }
  });

  testWidgets('the refusal is the whole screen', (tester) async {
    final line = bookMagicRefusal(kRegtestBookMagic, true)!;
    await tester.pumpWidget(BookMagicRefusedApp(message: line));
    expect(find.byKey(const Key('book-magic-refused')), findsOneWidget);
    expect(find.text(line), findsOneWidget);
  });

  test('the regtest checkpoint is refused under the testnet, mainnet and shear-dev books', () {
    final pin = _regtestPin();
    expect(pin.network, kRegtestBookMagic);
    for (final magic in [kTestnetBookMagic, kMainnetBookMagic, 'shear-dev']) {
      expect(checkpointAllowedFor(pin, magic), isFalse, reason: magic);
    }
    expect(checkpointAllowedFor(pin, kRegtestBookMagic), isTrue);
    // The regtest book takes no other pin.
    final testnet = CheckpointPin(
      network: 'testnet-v12',
      height: pin.height,
      hashHex: pin.hashHex,
      timeMs: pin.timeMs,
      bits: pin.bits,
      anchorHeight: pin.anchorHeight,
      anchorTimeMs: pin.anchorTimeMs,
      anchorBits: pin.anchorBits,
      priorTimesMs: pin.priorTimesMs,
    );
    expect(checkpointAllowedFor(testnet, kRegtestBookMagic), isFalse);
    expect(checkpointAllowedFor(testnet, kTestnetBookMagic), isTrue);
  });

  test('this testnet build installs no regtest checkpoint: depth stays unknown', () {
    final pin = _regtestPin();
    expect(checkpointPinWellFormed(pin), isTrue, reason: 'refused for its book, not its shape');
    final ledger = ShearLedger()..installCheckpoint(pin);
    expect(ledger.bookTip, 0, reason: 'the regtest pin seeds no verified tip');
    expect(ledger.fundsRefusal(1).message, kErrHeaderSync);
  });

  test('no wallet source names the regtest checkpoint', () {
    final pin = _regtestPin();
    for (final f in Directory('lib').listSync(recursive: true).whereType<File>()) {
      if (!f.path.endsWith('.dart')) continue;
      final text = f.readAsStringSync();
      expect(text.contains(pin.hashHex), isFalse, reason: f.path);
      expect(text.contains('regtest_checkpoint.json'), isFalse, reason: f.path);
    }
  });
}
