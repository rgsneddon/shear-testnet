/// Consent before a Reserve lock, vote, or withdraw reaches the public node.
///
/// A public-node post is refused until the user accepts [kUnprivateConfirmLabel].

const kUnprivateConfirmTitle = 'Public node may see your IP';

const kUnprivateConfirmLabel = 'I already use a VPN / I accept exposing my IP';

const kUnprivateConfirmHelper =
    'If you are not already on a VPN, the public node may see your device IP.';

const kUnprivateUnlockedBanner =
    'Unprivate send unlocked — public node may see your IP unless you already use a VPN';

const kPublicIpWaitCopy =
    'Confirm you use a VPN, or accept the node seeing your IP, before Send.';

/// Standing Reserve note on Connect bare.
const kReserveIpDisclaimer =
    'Connect bare sends this deposit to the public node directly. A tunnel is not required.';

String publicIpWaitCopy({required bool accepted}) =>
    accepted ? kUnprivateUnlockedBanner : kPublicIpWaitCopy;

/// Any finite positive SHE amount. No magnitude ceiling.
bool unprivateAmountPermitted(double she) => she.isFinite && she > 0;

/// Lock, vote, and withdraw may set public HTTP only after this confirm.
bool publicNodePostAllowed({required bool consent}) => consent;
