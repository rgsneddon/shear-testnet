import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/rp_mail.dart';
import 'package:shear_wallet/rx_privacy_browser.dart';
import 'package:shear_wallet/shear_vortex.dart';

void main() {
  test('lean Continuum does not preinstall Rx or rpMail', () {
    final ids = leanContinuumVortices().map((v) => v.id).toList();
    expect(ids, [reserveProgram]);
    expect(ids.contains(kRxPrivacyBrowserProgram), isFalse);
    expect(ids.contains(kRpMailProgram), isFalse);
    expect(kRxGalleryReady, isFalse);
    expect(kRpMailGalleryReady, isFalse);
    expect(kRxGalleryKey, 'vort1:TODO-rx-browser');
    expect(kRpMailGalleryKey, 'vort1:TODO-rpmail');
  });

  test('pasted vort1 installs the Rx and rpMail chips', () {
    const rxBody =
        '{"v":1,"programId":"rx-privacy-browser-v1","name":"Rx Privacy Browser","traffic":"tor","vpnRelay":false,"statusTorDown":"unprivate unless tor"}';
    const mailBody =
        '{"v":1,"programId":"rpmail-v1","name":"rpMail","solidity":false,"protocols":["imap","pop3","smtp"]}';
    final rxKey = mintVorticeDeployKey(
      programId: kRxPrivacyBrowserProgram,
      name: kRxPrivacyBrowserName,
      origin: 'https://rx.shear.digital/rx-privacy-browser.json',
      source: rxBody,
    );
    final mailKey = mintVorticeDeployKey(
      programId: kRpMailProgram,
      name: kRpMailName,
      origin: 'https://mail.shear.digital/rpmail.json',
      source: mailBody,
    );
    expect(rxKey, isNotNull);
    expect(mailKey, isNotNull);
    final roster = addVortice(
      addVortice(leanContinuumVortices(), rxKey!, source: rxBody),
      mailKey!,
      source: mailBody,
    );
    expect(roster.map((v) => v.name), [reserveVortice.name, kRxPrivacyBrowserName, kRpMailName]);
  });

  test('Rx pane is blocked and the Tor and SOCKS strings are gone', () {
    final src = File('lib/rx_privacy_browser.dart').readAsStringSync().toLowerCase();
    expect(src.contains('unprivate unless tor'), isFalse);
    expect(src.contains('tor routing'), isFalse);
    expect(src.contains('socks'), isFalse);
    expect(src.contains('.onion'), isFalse);
    expect(src.contains('torrouting'), isFalse);
    expect(RegExp(r'\btor\b').hasMatch(src), isFalse);
    final remote = rxDecide(url: 'https://example.com/');
    expect(remote.allowed, isFalse);
    expect(remote.status, kRxBlockedStatus);
    expect(remote.reason, 'blocked');
    final local = rxDecide(url: 'about:newtab');
    expect(local.allowed, isTrue);
    expect(local.local, isTrue);
    expect(local.status, kRxBlockedStatus);
  });

  testWidgets('blocked chrome does not leave the start page', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: RxPrivacyBrowserPane())));
    expect(find.text(kRxBlockedStatus), findsOneWidget);
    await tester.enterText(find.byKey(const Key('rx-url')), 'https://example.com/');
    await tester.tap(find.byKey(const Key('rx-go')));
    await tester.pump();
    expect(find.text(kRxBlockedStatus), findsOneWidget);
    expect(tester.widget<Text>(find.byKey(const Key('rx-page'))).data, 'about:newtab');
    expect(find.text('unprivate unless tor'), findsNothing);
    expect(find.text('Tor routing'), findsNothing);
  });

  test('mail password is not spendable; IMAP POP3 SMTP round-trip', () async {
    expect(
      bindMailSecret('s3cret', {'ssa1': 1}),
      {'ssa1': 1},
    );
    expect(() => bindMailSecret('s3cret', {'note': 's3cret'}), throwsA(isA<MailCredentialLeak>()));
    expect(() => const MailSecret(user: 'ada', password: 's3cret').exportSpendable(), throwsA(isA<MailCredentialLeak>()));

    final imap = await _script((client) async {
      client.add('* OK\r\na1 OK\r\na2 OK\r\n* 1 FETCH Subject: Hi\r\na3 OK\r\n'.codeUnits);
    });
    final subjects = await rpImapBodies(imap, user: 'ada', password: 's3cret');
    expect(subjects, ['Hi']);

    final pop = await _script((client) async {
      client.add('+OK\r\n+OK\r\n+OK\r\n+OK\r\nSubject: Pop\r\n\r\n.\r\n'.codeUnits);
    });
    expect(await rpPop3Subjects(pop, user: 'ada', password: 's3cret'), ['Pop']);

    final smtp = await _script((client) async {
      client.add('220 ready\r\n250 hello\r\n250\r\n250\r\n354 go\r\n250 queued\r\n'.codeUnits);
    });
    expect(
      await rpSmtpSend(smtp, from: 'ada@ex.com', to: 'bob@ex.com', subject: 'Note', body: 'hello'),
      'Note',
    );
  });
}

Future<Socket> _script(Future<void> Function(Socket client) serve) async {
  final server = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
  server.listen((client) {
    serve(client);
  });
  final sock = await Socket.connect(InternetAddress.loopbackIPv4, server.port);
  return sock;
}
