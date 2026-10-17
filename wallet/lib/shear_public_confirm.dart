/// Consent before a public-node post. There is no Tor path.
///
/// A public-node post is refused until the user accepts [kUnprivateConfirmLabel].
/// An own node on https, or on http to this machine or the LAN, does not ask.
import 'dart:io';

import 'shear_read_sync.dart';

const kUnprivateConfirmTitle = 'Public node may see your IP';

const kUnprivateConfirmLabel = 'I already use a VPN / I accept exposing my IP';

/// Connect bare consent, settings, docs, and wallet help share this sentence.
const kPublicNodeEverySendCopy =
    'The public node can see your IP on every send and every sync, not just once. '
    'In public mode, history requests carry your view key, so that operator can see incoming payments. '
    'Use a VPN, or point Continuum at your own node. '
    'A full node keeps your IP from the public node; your node\'s peers still see your IP.';

const kUnprivateConfirmHelper = kPublicNodeEverySendCopy;

const kUnprivateUnlockedBanner =
    'Unprivate send unlocked — public node may see your IP unless you already use a VPN';

/// The wait line is the same sentence as the confirm. There is no shorter variant.
const kPublicIpWaitCopy = kPublicNodeEverySendCopy;

const kOwnNodeUrlError =
    'Not a node URL. Use host:port or https://host:port. '
    'http is only for a node on this machine or your LAN. '
    'Own node means a node you run, not a public Shear host.';

const kLocalNodeDownCopy = 'local node not running';

/// Standing Reserve note on Connect bare.
const kReserveIpDisclaimer =
    'Connect bare sends this deposit to the public node directly. A tunnel is not required. '
    '$kPublicNodeEverySendCopy';

String publicIpWaitCopy({required bool accepted}) =>
    accepted ? kUnprivateUnlockedBanner : kPublicIpWaitCopy;

/// Any finite positive SHE amount. No magnitude ceiling.
bool unprivateAmountPermitted(double she) => she.isFinite && she > 0;

/// Lock, vote, withdraw, and Flow may post to the public node only after this confirm.
bool publicNodePostAllowed({required bool consent}) => consent;

/// True when [rpc] is not loopback, LAN, link-local, IPv6 ULA, or `.local`.
bool rpcNeedsPublicIpWarning(String rpc) {
  final u = Uri.tryParse(rpc.trim());
  if (u == null || u.host.isEmpty) return false;
  return !ownNodeAllowsHttp(u.host);
}

/// Empty input keeps the public node. Anything else must be an own-node URL.
String? ownNodeUrlError(String raw) {
  if (raw.trim().isEmpty) return null;
  if (parseOwnNodeUrl(raw) == null) return kOwnNodeUrlError;
  return null;
}

/// A saved own node is not the public node, so the IP confirm is not asked.
/// Remote cleartext http does not parse, so it does not skip the confirm.
bool ownNodeSkipsPublicConsent(String? raw) {
  if (raw == null || raw.trim().isEmpty) return false;
  return parseOwnNodeUrl(raw) != null;
}

/// `host:port` or an http(s) URL. Public Shear hosts are not an own node.
/// Empty input is the public-node default and returns null.
/// A bare public host becomes https. http is kept only for a private host.
String? parseOwnNodeUrl(String raw) {
  var s = raw.trim();
  if (s.isEmpty) return null;
  if (s.contains(' ') || s.contains('@') || s.contains('\\')) return null;
  final hadScheme = s.contains('://');
  if (!hadScheme) s = 'http://$s';
  final u = Uri.tryParse(s);
  if (u == null || !u.hasScheme) return null;
  if (u.scheme != 'http' && u.scheme != 'https') return null;
  if (u.host.isEmpty || u.userInfo.isNotEmpty) return null;
  if (u.query.isNotEmpty || u.fragment.isNotEmpty) return null;
  if (u.path.isNotEmpty && u.path != '/') return null;
  if (u.hasPort && (u.port <= 0 || u.port > 65535)) return null;
  final host = _stripDots(u.host.toLowerCase());
  if (host.isEmpty || isPublicWalletHost(host)) return null;
  final privateHost = ownNodeAllowsHttp(host);
  var scheme = u.scheme;
  if (!hadScheme && !privateHost) scheme = 'https';
  if (scheme == 'http' && !privateHost) return null;
  final shown = host.contains(':') ? '[$host]' : host;
  final port = u.hasPort ? ':${u.port}' : '';
  return '$scheme://$shown$port';
}

/// http is allowed for loopback, RFC1918, link-local, IPv6 ULA, and `.local`.
bool ownNodeAllowsHttp(String host) {
  final h = _stripDots(host.toLowerCase());
  if (h == 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  final addr = InternetAddress.tryParse(h);
  if (addr == null) return false;
  if (addr.isLoopback) return true;
  final b = addr.rawAddress;
  if (addr.type == InternetAddressType.IPv4) {
    if (b[0] == 10) return true;
    if (b[0] == 127) return true;
    if (b[0] == 192 && b[1] == 168) return true;
    if (b[0] == 172 && b[1] >= 16 && b[1] <= 31) return true;
    if (b[0] == 169 && b[1] == 254) return true;
    return false;
  }
  if ((b[0] & 0xfe) == 0xfc) return true;
  if (b[0] == 0xfe && (b[1] & 0xc0) == 0x80) return true;
  return false;
}

String _stripDots(String host) {
  var h = host;
  while (h.endsWith('.')) {
    h = h.substring(0, h.length - 1);
  }
  return h;
}
