/// Consent before a public-node post. There is no Tor path.
///
/// A public-node post is refused until the user accepts [kUnprivateConfirmLabel].
/// An own node, or a local node, does not ask.

const kUnprivateConfirmTitle = 'Public node may see your IP';

const kUnprivateConfirmLabel = 'I already use a VPN / I accept exposing my IP';

/// Connect bare consent, settings, docs, and wallet help share this sentence.
const kPublicNodeEverySendCopy =
    'The public node can see your IP on every send, not just once. '
    'Use a VPN, or point Continuum at your own node. '
    'A full node in the desktop wallet is full privacy.';

const kUnprivateConfirmHelper = kPublicNodeEverySendCopy;

const kUnprivateUnlockedBanner =
    'Unprivate send unlocked — public node may see your IP unless you already use a VPN';

const kPublicIpWaitCopy =
    'The public node can see your IP on every send. '
    'Confirm a VPN, or point Continuum at your own node, before Send.';

const kOwnNodeUrlError = 'Not a node URL. Use host:port or https://host:port.';

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

/// Empty input keeps the public node. Anything else must be an own-node URL.
String? ownNodeUrlError(String raw) {
  if (raw.trim().isEmpty) return null;
  if (parseOwnNodeUrl(raw) == null) return kOwnNodeUrlError;
  return null;
}

/// A saved own node is not the public node, so the IP confirm is not asked.
bool ownNodeSkipsPublicConsent(String? raw) {
  if (raw == null || raw.trim().isEmpty) return false;
  return parseOwnNodeUrl(raw) != null;
}

/// `host:port` or an http(s) URL. Public Shear hosts are not an own node.
/// Empty input is the public-node default and returns null.
String? parseOwnNodeUrl(String raw) {
  var s = raw.trim();
  if (s.isEmpty) return null;
  if (s.contains(' ') || s.contains('@') || s.contains('\\')) return null;
  if (!s.contains('://')) s = 'http://$s';
  final u = Uri.tryParse(s);
  if (u == null || !u.hasScheme) return null;
  if (u.scheme != 'http' && u.scheme != 'https') return null;
  if (u.host.isEmpty || u.userInfo.isNotEmpty) return null;
  if (u.query.isNotEmpty || u.fragment.isNotEmpty) return null;
  if (u.path.isNotEmpty && u.path != '/') return null;
  if (u.hasPort && (u.port <= 0 || u.port > 65535)) return null;
  final host = u.host.toLowerCase();
  if (host == 'shear.digital' || host.endsWith('.shear.digital')) return null;
  final port = u.hasPort ? ':${u.port}' : '';
  return '${u.scheme}://$host$port';
}
