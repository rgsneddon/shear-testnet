import 'package:flutter/material.dart';

const kRxPrivacyBrowserProgram = 'rx-privacy-browser-v1';
const kRxPrivacyBrowserName = 'Rx Privacy Browser';
const kRxBlockedStatus = 'blocked';
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
}

/// Remote loads stay blocked. This pane does not open a route.
RxNav rxDecide({required String url}) {
  final raw = url.trim();
  if (raw.isEmpty || raw.toLowerCase().startsWith('about:')) {
    return RxNav(
      allowed: true,
      status: kRxBlockedStatus,
      relay: 'none',
      url: raw.isEmpty ? 'about:newtab' : raw,
      local: true,
      reason: 'local',
    );
  }
  return RxNav(
    allowed: false,
    status: kRxBlockedStatus,
    relay: 'none',
    url: raw,
    reason: 'blocked',
  );
}

class RxPrivacyBrowserPane extends StatefulWidget {
  const RxPrivacyBrowserPane({super.key});

  @override
  State<RxPrivacyBrowserPane> createState() => _RxPrivacyBrowserPaneState();
}

class _RxPrivacyBrowserPaneState extends State<RxPrivacyBrowserPane> {
  final _url = TextEditingController(text: 'about:newtab');
  String _status = kRxBlockedStatus;
  String _page = 'about:newtab';
  String _body = '';

  @override
  void dispose() {
    _url.dispose();
    super.dispose();
  }

  void _go() {
    final decision = rxDecide(url: _url.text);
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
