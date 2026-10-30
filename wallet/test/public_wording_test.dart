import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_closure.dart';
import 'package:shear_wallet/shear_reserve.dart';

const kPublicNodeDepositCopy =
    'Private on chain. A public node still sees your IP and this deposit; use a VPN or a local node.';

const kPublicNodeSendCopy =
    'Private on chain. A public node still sees your IP and this send; use a VPN or a local node.';

const kPublicNodeTagline =
    'Private on chain. A public node still sees your IP; use a VPN or a local node.';

void main() {
  test('public copy names the IP a public node sees', () {
    expect(kReserveIpDisclaimer, kPublicNodeDepositCopy);
    expect(kReserveIpDisclaimer.toLowerCase(), isNot(contains('admitv2')));
    expect(kReserveIpDisclaimer.toLowerCase(), isNot(contains('is private')));
    expect(kReserveIpDisclaimer.toLowerCase(), isNot(contains('tunnel is not required')));
    expect(kReserveIpDisclaimer.toLowerCase(), isNot(contains('tor')));
    expect(kConnectBareCopy, contains(kPublicNodeSendCopy));
    expect(kConnectBareCopy.toLowerCase(), isNot(contains('admitv2')));
    expect(kConnectBareCopy.toLowerCase(), isNot(contains('dins-dag')));
    expect(kConnectBareCopy.toLowerCase(), isNot(contains('tor')));
    final ui = File('lib/main.dart').readAsStringSync();
    expect(ui.contains('she is private'), isFalse);
    expect(ui, contains(kPublicNodeTagline));
  });

  test('wallet lib does not say the send is private or that a tunnel is not required', () {
    final hits = <String>[];
    for (final ent in Directory('lib').listSync(recursive: true)) {
      if (ent is! File || !ent.path.endsWith('.dart')) continue;
      final path = ent.path.replaceAll('\\', '/');
      if (path.endsWith('/rx_privacy_browser.dart')) continue;
      final text = ent.readAsStringSync().toLowerCase();
      if (text.contains('is private') || text.contains('tunnel is not required')) {
        hits.add(path);
      }
    }
    expect(hits, isEmpty, reason: hits.join('\n'));
  });
}
