import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';

const kRpMailProgram = 'rpmail-v1';
const kRpMailName = 'rpMail';
const kRpMailGalleryKey = 'vort1:TODO-rpmail';
const kRpMailGalleryReady = false;

class MailCredentialLeak implements Exception {
  MailCredentialLeak(this.message);
  final String message;
}

class MailSecret {
  const MailSecret({required this.user, required this.password});
  final String user;
  final String password;

  Map<String, Object> exportSpendable() {
    throw MailCredentialLeak('mail credentials are not SHE spendable');
  }
}

Map<String, Object> bindMailSecret(String password, Map<String, Object> spendable) {
  if (password.isNotEmpty && spendable.toString().contains(password)) {
    throw MailCredentialLeak('mail secret must not sit in spendable');
  }
  for (final banned in ['mailPassword', 'shewallPassword', 'imapPassword']) {
    if (spendable.containsKey(banned)) {
      throw MailCredentialLeak('mail secret key in spendable');
    }
  }
  return Map<String, Object>.of(spendable);
}

class _Lines {
  _Lines(Socket socket) : socket = socket {
    _sub = socket.listen((chunk) {
      _buf.addAll(chunk);
      _pump();
    }, onDone: () {
      _done = true;
      _pump();
    });
  }

  final Socket socket;
  final _buf = <int>[];
  final _waiters = <Completer<String>>[];
  late final StreamSubscription<List<int>> _sub;
  bool _done = false;

  void _pump() {
    while (_waiters.isNotEmpty) {
      final i = _buf.indexOf(10);
      if (i < 0) {
        if (_done) {
          _waiters.removeAt(0).completeError(StateError('eof'));
        }
        return;
      }
      final line = String.fromCharCodes(_buf.sublist(0, i)).replaceAll('\r', '');
      _buf.removeRange(0, i + 1);
      _waiters.removeAt(0).complete(line);
    }
  }

  Future<String> readLine() {
    final c = Completer<String>();
    _waiters.add(c);
    _pump();
    return c.future;
  }

  void sendLine(String line) {
    socket.add('$line\r\n'.codeUnits);
  }

  Future<void> close() => _sub.cancel();
}

Future<List<String>> rpImapBodies(Socket socket, {required String user, required String password}) async {
  final io = _Lines(socket);
  final greet = await io.readLine();
  if (!greet.startsWith('*')) throw StateError(greet);
  io.sendLine('a1 LOGIN "$user" "$password"');
  await _ok(io, 'a1');
  io.sendLine('a2 SELECT "INBOX"');
  await _ok(io, 'a2');
  io.sendLine('a3 FETCH 1:* (BODY[TEXT])');
  final bodies = <String>[];
  while (true) {
    final line = await io.readLine();
    if (line.startsWith('a3 ')) {
      if (!line.toUpperCase().contains(' OK')) throw StateError(line);
      break;
    }
    final mark = 'Subject:';
    final at = line.toLowerCase().indexOf('subject:');
    if (at >= 0) bodies.add(line.substring(at + mark.length).trim());
  }
  io.sendLine('a4 LOGOUT');
  await io.close();
  return bodies;
}

Future<List<String>> rpPop3Subjects(Socket socket, {required String user, required String password}) async {
  final io = _Lines(socket);
  final greet = await io.readLine();
  if (!greet.startsWith('+OK')) throw StateError(greet);
  io.sendLine('USER $user');
  if (!(await io.readLine()).startsWith('+OK')) throw StateError('user');
  io.sendLine('PASS $password');
  if (!(await io.readLine()).startsWith('+OK')) throw StateError('pass');
  io.sendLine('RETR 1');
  if (!(await io.readLine()).startsWith('+OK')) throw StateError('retr');
  final lines = <String>[];
  while (true) {
    final row = await io.readLine();
    if (row == '.') break;
    lines.add(row);
  }
  io.sendLine('QUIT');
  await io.close();
  for (final row in lines) {
    if (row.toLowerCase().startsWith('subject:')) {
      return [row.split(':').sublist(1).join(':').trim()];
    }
  }
  return const [];
}

Future<void> _ok(_Lines io, String tag) async {
  while (true) {
    final line = await io.readLine();
    if (line.startsWith('$tag ')) {
      if (!line.toUpperCase().contains(' OK')) throw StateError(line);
      return;
    }
  }
}

Future<String> rpSmtpSend(
  Socket socket, {
  required String from,
  required String to,
  required String subject,
  required String body,
}) async {
  final io = _Lines(socket);
  final greet = await io.readLine();
  if (!greet.startsWith('220')) throw StateError(greet);
  io.sendLine('EHLO rpmail');
  while (true) {
    final line = await io.readLine();
    if (line.startsWith('250 ')) break;
    if (!line.startsWith('250')) throw StateError(line);
  }
  io.sendLine('MAIL FROM:<$from>');
  if (!(await io.readLine()).startsWith('250')) throw StateError('mail');
  io.sendLine('RCPT TO:<$to>');
  if (!(await io.readLine()).startsWith('250')) throw StateError('rcpt');
  io.sendLine('DATA');
  if (!(await io.readLine()).startsWith('354')) throw StateError('data');
  socket.add('Subject: $subject\r\nFrom: $from\r\nTo: $to\r\n\r\n$body\r\n.\r\n'.codeUnits);
  if (!(await io.readLine()).startsWith('250')) throw StateError('queued');
  io.sendLine('QUIT');
  return subject;
}

class RpMailPane extends StatefulWidget {
  const RpMailPane({super.key});

  @override
  State<RpMailPane> createState() => _RpMailPaneState();
}

class _RpMailPaneState extends State<RpMailPane> {
  final _pass = TextEditingController();
  String _note = 'IMAP · POP3 · SMTP';

  @override
  void dispose() {
    _pass.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      key: const Key('rpmail-pane'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Text(kRpMailName, style: TextStyle(fontWeight: FontWeight.w700)),
        const Text('Client only. Mail password is not SHE Spendable and is not the shewall password.'),
        Text(_note, key: const Key('rpmail-proto')),
        TextField(
          key: const Key('rpmail-password'),
          controller: _pass,
          obscureText: true,
          decoration: const InputDecoration(labelText: 'Mail password'),
        ),
      ],
    );
  }
}
