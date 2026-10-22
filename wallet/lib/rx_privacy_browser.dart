import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';

const kRxPrivacyBrowserProgram = 'rx-privacy-browser-v1';
const kRxPrivacyBrowserName = 'Rx Privacy Browser';
const kStatusUnprivateUnlessTor = 'unprivate unless tor';
const kStatusTorRouting = 'Tor routing';
const kRxGalleryKey = 'vort1:TODO-rx-browser';
const kRxGalleryReady = false;

class RxNav {
  const RxNav({
    required this.allowed,
    required this.status,
    required this.relay,
    required this.url,
    this.local = false,
    this.reason = '',
    this.body = '',
  });
  final bool allowed;
  final String status;
  final String relay;
  final String url;
  final bool local;
  final String reason;
  final String body;

  bool get looksPrivate => status == kStatusTorRouting && relay == 'tor';
}

bool rxOnionHost(String host) => host.toLowerCase().endsWith('.onion');

RxNav rxDecide({required bool torRouting, required String url}) {
  final status = torRouting ? kStatusTorRouting : kStatusUnprivateUnlessTor;
  final raw = url.trim();
  if (raw.isEmpty || raw.toLowerCase().startsWith('about:')) {
    return RxNav(allowed: true, status: status, relay: 'none', url: raw.isEmpty ? 'about:newtab' : raw, local: true, reason: 'local');
  }
  final uri = Uri.tryParse(raw);
  final scheme = uri?.scheme.toLowerCase() ?? '';
  final host = uri?.host ?? '';
  final port = uri?.hasPort == true
      ? uri!.port
      : scheme == 'https'
          ? 443
          : scheme == 'http'
              ? 80
              : 0;
  if ((scheme != 'http' && scheme != 'https') || host.isEmpty || port <= 0) {
    return RxNav(allowed: false, status: status, relay: 'blocked', url: raw, reason: 'unsupported');
  }
  if (!torRouting) {
    return RxNav(allowed: false, status: kStatusUnprivateUnlessTor, relay: 'blocked', url: raw, reason: 'tor_down');
  }
  return RxNav(
    allowed: true,
    status: kStatusTorRouting,
    relay: 'tor',
    url: raw,
    reason: rxOnionHost(host) ? 'onion' : 'clearnet',
  );
}

/// SOCKS5 CONNECT using a domain name so Tor resolves `.onion` (no local DNS).
Future<void> rxSocks5Connect(Socket sock, String host, int port) async {
  sock.add([5, 1, 0]);
  final greet = await _take(sock, 2);
  if (greet.length != 2 || greet[0] != 5 || greet[1] != 0) {
    throw StateError('socks_auth');
  }
  final hostBytes = host.codeUnits;
  if (hostBytes.isEmpty || hostBytes.length > 255) throw StateError('socks_host');
  sock.add([5, 1, 0, 3, hostBytes.length, ...hostBytes, (port >> 8) & 0xff, port & 0xff]);
  final head = await _take(sock, 4);
  if (head.length < 4 || head[0] != 5 || head[1] != 0) throw StateError('socks_fail');
  final atyp = head[3];
  if (atyp == 1) {
    await _take(sock, 6);
  } else if (atyp == 4) {
    await _take(sock, 18);
  } else if (atyp == 3) {
    final n = (await _take(sock, 1)).first;
    await _take(sock, n + 2);
  } else {
    throw StateError('socks_atyp');
  }
}

final _sockBuf = <Socket, List<int>>{};
final _sockSubs = <Socket, StreamSubscription<List<int>>>{};

Future<List<int>> _take(Socket sock, int n) async {
  final buf = _sockBuf.putIfAbsent(sock, () => <int>[]);
  _sockSubs.putIfAbsent(sock, () => sock.listen(buf.addAll));
  while (buf.length < n) {
    await Future<void>.delayed(const Duration(milliseconds: 5));
    if (buf.length >= n) break;
  }
  if (buf.length < n) return List<int>.from(buf);
  final out = buf.sublist(0, n);
  buf.removeRange(0, n);
  return out;
}

class RxPrivacyBrowserPane extends StatefulWidget {
  const RxPrivacyBrowserPane({super.key, this.torRouting = false});
  final bool torRouting;

  @override
  State<RxPrivacyBrowserPane> createState() => _RxPrivacyBrowserPaneState();
}

class _RxPrivacyBrowserPaneState extends State<RxPrivacyBrowserPane> {
  final _url = TextEditingController(text: 'about:newtab');
  String _status = kStatusUnprivateUnlessTor;
  String _page = 'about:newtab';
  String _body = '';

  @override
  void initState() {
    super.initState();
    _status = widget.torRouting ? kStatusTorRouting : kStatusUnprivateUnlessTor;
  }

  @override
  void dispose() {
    _url.dispose();
    super.dispose();
  }

  void _go() {
    final decision = rxDecide(torRouting: widget.torRouting, url: _url.text);
    setState(() {
      _status = decision.status;
      if (decision.allowed) {
        _page = decision.url;
        _body = decision.local ? '' : decision.body;
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      key: const Key('rx-privacy-browser'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(kRxPrivacyBrowserName, style: const TextStyle(fontWeight: FontWeight.w700)),
        Text(_status, key: const Key('rx-status')),
        TextField(key: const Key('rx-url'), controller: _url),
        FilledButton(key: const Key('rx-go'), onPressed: _go, child: const Text('Go')),
        Text(_page, key: const Key('rx-page')),
        if (_body.isNotEmpty) Text(_body, key: const Key('rx-body')),
      ],
    );
  }
}
