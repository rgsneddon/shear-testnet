import 'dart:async';
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

  test('Tor-down is exact and not private; onion needs Tor', () {
    final down = rxDecide(torRouting: false, url: 'http://example.onion/');
    expect(down.allowed, isFalse);
    expect(down.status, kStatusUnprivateUnlessTor);
    expect(down.relay, 'blocked');
    expect(down.looksPrivate, isFalse);
    final up = rxDecide(torRouting: true, url: 'https://example.com/');
    expect(up.allowed, isTrue);
    expect(up.relay, 'tor');
    expect(up.status, kStatusTorRouting);
    expect(up.reason, 'clearnet');
    final onion = rxDecide(torRouting: true, url: 'http://example.onion/');
    expect(onion.reason, 'onion');
    expect(onion.relay, 'tor');
  });

  testWidgets('Tor-down chrome blocks Go', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: RxPrivacyBrowserPane(torRouting: false))));
    expect(find.text(kStatusUnprivateUnlessTor), findsOneWidget);
    await tester.enterText(find.byKey(const Key('rx-url')), 'https://example.onion/');
    await tester.tap(find.byKey(const Key('rx-go')));
    await tester.pump();
    expect(find.text(kStatusUnprivateUnlessTor), findsOneWidget);
    expect(tester.widget<Text>(find.byKey(const Key('rx-page'))).data, 'about:newtab');
    expect(find.text(kStatusTorRouting), findsNothing);
  });

  test('SOCKS connect sends the onion hostname', () async {
    final server = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    final hostGot = Completer<String>();
    server.listen((client) async {
      final buf = <int>[];
      var stage = 0;
      await for (final chunk in client) {
        buf.addAll(chunk);
        if (stage == 0 && buf.length >= 3) {
          client.add([5, 0]);
          buf.removeRange(0, 3);
          stage = 1;
        }
        if (stage == 1 && buf.length >= 5 && buf[3] == 3) {
          final n = buf[4];
          if (buf.length >= 5 + n + 2) {
            hostGot.complete(String.fromCharCodes(buf.sublist(5, 5 + n)));
            client.add([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
            break;
          }
        }
      }
    });
    final sock = await Socket.connect(InternetAddress.loopbackIPv4, server.port);
    await rxSocks5Connect(sock, 'example.onion', 80);
    expect(await hostGot.future.timeout(const Duration(seconds: 3)), 'example.onion');
    await sock.close();
    await server.close();
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
