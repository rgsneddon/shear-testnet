import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'shear_identity.dart';
import 'shear_levy.dart';
import 'shear_read_sync.dart';

/// Residual hop daemon for Continuum Reserve (restore-privacy RPT2).
const kPrivacyHopHost = '77.42.35.12';
const kPrivacyHopPort = 44044;
const kPrivacyHopLabel = 'SHEAR-HOP / EU';
const kPrivacyHopChannel = 'shear/privacy_hop';
const kPrivacyHopSessionName = 'SHEAR-HOP / EU';
const kPrivacyHopButtonLabel = 'Privacy hop';

/// Android VpnService handshake budget. Kotlin `HOP_HANDSHAKE_TIMEOUT_MS` matches.
const kPrivacyHopHandshakeTimeoutMs = 15000;

/// HELLO attempts. Kotlin `HOP_HANDSHAKE_ATTEMPTS` matches. Never above 3.
const kPrivacyHopHandshakeAttempts = 3;

/// Session poll after the service starts. Above the handshake budget so TUN
/// setup can finish, and well under the old 70s wait.
const kPrivacyHopSessionWaitMs = 20000;

const kHopProgressPaying = 'Paying hop fee…';
const kHopProgressConnecting = 'Connecting Privacy hop…';

/// Fixed hop click fee. Lands on [kPoolFeeDest] (ssa1), never she1.
const kPrivacyHopFeeShe = 0.05;
const kPrivacyHopFeeDest = kPoolFeeDest;

const kPrivacyHopFeeConfirmTitle = 'Pay 0.05 SHE for Privacy hop';
const kPrivacyHopFeeConfirmBody =
    'Send 0.05 SHE to the pool fee dest, then connect SHEAR-HOP / EU. '
    'The hop fee uses the public node. Reserve Send then goes through the hop.';

const kUnprivateSendLabel = 'Send without privacy hop';
const kUnprivateConfirmTitle = 'Send without Shear privacy hop';
const kUnprivateConfirmLabel = 'I already use a VPN / I accept exposing my IP';
const kUnprivateConfirmHelper =
    'Skip Shear privacy hop. If you are not already on a VPN, the public node may see your device IP.';

const kReserveHopWaitCopy =
    'Connect Privacy hop to hide your IP, then Send. Public pool HTTP is not used without the hop.';

const kUnprivateUnlockedBanner =
    'Unprivate send unlocked — public node may see your IP unless you already use a VPN';

String reservePublicWaitCopy({required bool unprivateConfirmed}) =>
    unprivateConfirmed ? kUnprivateUnlockedBanner : kReserveHopWaitCopy;

enum PrivacyHopState { off, connecting, up, error }

String privacyHopStateLabel(PrivacyHopState s) {
  switch (s) {
    case PrivacyHopState.off:
      return 'Privacy hop off';
    case PrivacyHopState.connecting:
      return 'Privacy hop connecting…';
    case PrivacyHopState.up:
      return 'Privacy hop up · $kPrivacyHopLabel';
    case PrivacyHopState.error:
      return 'Privacy hop error';
  }
}

bool reserveSendReady({
  required bool hopUp,
  String? poolUrl,
  bool skipPoolSync = false,
  bool enforceHopGate = false,
  bool unprivateConfirmed = false,
}) {
  if (skipPoolSync && !enforceHopGate) return true;
  if (localSendReady(poolUrl)) return true;
  if (hopUp) return true;
  return unprivateConfirmed;
}

bool reserveVaultSendReady({
  required bool skipPoolSync,
  bool enforceHopGate = false,
  String? poolUrl,
  PrivacyHopState hop = PrivacyHopState.off,
  bool unprivateConfirmed = false,
}) =>
    reserveSendReady(
      hopUp: hop == PrivacyHopState.up,
      poolUrl: poolUrl,
      skipPoolSync: skipPoolSync,
      enforceHopGate: enforceHopGate,
      unprivateConfirmed: unprivateConfirmed,
    );

bool privacyHopFeeDestOk(String dest) {
  final t = dest.trim();
  if (t.startsWith('she1') || t.startsWith('shear1')) return false;
  if (t.contains('she1')) return false;
  if (!isDestAddress(t)) return false;
  return t == kPrivacyHopFeeDest || t == poolFeeDest();
}

bool hopFeeDestIsSsa1(String dest) => privacyHopFeeDestOk(dest);

class PrivacyHopController extends ChangeNotifier {
  PrivacyHopController({
    this.mock = false,
    this.connectImpl,
    MethodChannel? channel,
    PrivacyHopState initial = PrivacyHopState.off,
  })  : _channel = channel ?? const MethodChannel(kPrivacyHopChannel),
        state = initial;

  final bool mock;
  final Future<bool> Function()? connectImpl;
  final MethodChannel _channel;

  PrivacyHopState state;
  String message = '';
  String? vpnIp;

  bool get isUp => state == PrivacyHopState.up;
  bool get isConnecting => state == PrivacyHopState.connecting;

  String statusLine() => message.isNotEmpty ? message : privacyHopStateLabel(state);

  Future<bool> connect({
    String host = kPrivacyHopHost,
    int port = kPrivacyHopPort,
  }) async {
    if (isUp) return true;
    state = PrivacyHopState.connecting;
    message = 'Connecting $kPrivacyHopLabel…';
    notifyListeners();
    final impl = connectImpl;
    if (impl != null) {
      final ok = await impl();
      state = ok ? PrivacyHopState.up : PrivacyHopState.error;
      message = ok ? '$kPrivacyHopLabel up' : 'Hop did not come up';
      notifyListeners();
      return ok;
    }
    if (mock) {
      state = PrivacyHopState.up;
      message = '$kPrivacyHopLabel up';
      notifyListeners();
      return true;
    }
    try {
      final raw = await _channel.invokeMethod<dynamic>('connect', {
        'host': host,
        'port': port,
        'fullTunnel': true,
        'sessionName': kPrivacyHopSessionName,
        'label': kPrivacyHopLabel,
        'timeoutMs': kPrivacyHopHandshakeTimeoutMs,
        'attempts': kPrivacyHopHandshakeAttempts,
      });
      final map = raw is Map<String, dynamic>
          ? raw
          : raw is Map
              ? Map<String, dynamic>.from(raw)
              : <String, dynamic>{};
      final ok = map['ok'] == true &&
          (map['connected'] == true || map['fullTunnelActive'] == true);
      if (ok) {
        state = PrivacyHopState.up;
        final ip = map['vpnIp']?.toString().trim();
        if (ip != null && ip.isNotEmpty) vpnIp = ip;
        message = (map['message'] as String?)?.trim().isNotEmpty == true
            ? map['message'] as String
            : '$kPrivacyHopLabel up';
        notifyListeners();
        return true;
      }
      state = PrivacyHopState.error;
      message = (map['message'] as String?)?.trim().isNotEmpty == true
          ? map['message'] as String
          : 'Privacy hop did not connect';
      notifyListeners();
      return false;
    } on MissingPluginException {
      state = PrivacyHopState.error;
      message =
          'Privacy hop native channel missing on this build. Android uses VpnService.';
      notifyListeners();
      return false;
    } on PlatformException catch (e) {
      state = PrivacyHopState.error;
      message = e.message ?? e.code;
      notifyListeners();
      return false;
    }
  }

  Future<void> disconnect() async {
    if (!mock && connectImpl == null) {
      try {
        await _channel.invokeMethod<dynamic>('disconnect');
      } catch (_) {}
    }
    state = PrivacyHopState.off;
    message = 'Privacy hop off';
    vpnIp = null;
    notifyListeners();
  }

  void mockUp() {
    state = PrivacyHopState.up;
    message = '$kPrivacyHopLabel up';
    notifyListeners();
  }
}

typedef PrivacyHop = PrivacyHopController;
