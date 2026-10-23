import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_cli.dart';

void main() {
  const bad = <String, String>{
    '-1': 'greater than zero',
    'NaN': 'finite',
    'Infinity': 'finite',
    '-Infinity': 'finite',
    '0': 'greater than zero',
    '0.0': 'greater than zero',
    'abc': 'positive number',
    '0.000000000001': '11 decimal',
    '1e30': 'decimal number',
    '1e400': 'decimal number',
  };

  for (final entry in bad.entries) {
    test('send rejects --amount ${entry.key}', () async {
      for (final args in [
        ['send', '--to', 'not-an-address', '--amount', entry.key, '--dry-run'],
        ['send', '--to', 'not-an-address', '--amount=${entry.key}', '--dry-run'],
      ]) {
        final err = StringBuffer();
        final code = await runShearCli(args, stdout: StringBuffer(), stderr: err);
        expect(code, 2, reason: '${args.join(' ')} ${err.toString()}');
        expect(err.toString().toLowerCase(), contains(entry.value.toLowerCase()));
        expect(err.toString(), isNot(contains('Invalid double')));
      }
    });

    test('reserve lock rejects --amount ${entry.key}', () async {
      for (final args in [
        ['reserve', 'lock', '--amount', entry.key, '--dry-run'],
        ['reserve', 'lock', '--amount=${entry.key}', '--dry-run'],
      ]) {
        final err = StringBuffer();
        final code = await runShearCli(args, stdout: StringBuffer(), stderr: err);
        expect(code, 2, reason: '${args.join(' ')} ${err.toString()}');
        expect(err.toString().toLowerCase(), contains(entry.value.toLowerCase()));
      }
    });
  }

  test('a positive amount is not an amount error', () async {
    final dir = Directory.systemTemp.createTempSync('shear-cli-amt-');
    addTearDown(() {
      if (dir.existsSync()) dir.deleteSync(recursive: true);
    });
    final err = StringBuffer();
    final code = await runShearCli(
      ['send', '--to', 'not-an-address', '--amount', '1.5', '--dry-run', '--store', '${dir.path}/missing.json'],
      stdout: StringBuffer(),
      stderr: err,
    );
    expect(code, isNonZero);
    final text = err.toString().toLowerCase();
    expect(text.contains('decimal'), isFalse);
    expect(text.contains('greater than zero'), isFalse);
    expect(text.contains('finite'), isFalse);
  });
}
