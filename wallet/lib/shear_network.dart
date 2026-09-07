/// Network profiles. Magic isolates books. Testnet default is unchanged.
const kMagicTestnet = 'shear-testnet-v2';
const kMagicMainnet = 'shear-v1';

class ShearNetwork {
  const ShearNetwork({
    required this.id,
    required this.magic,
    required this.flySeed,
    required this.p2pSeeds,
    required this.mainnet,
  });
  final String id;
  final String magic;
  final String flySeed;
  final List<String> p2pSeeds;
  final bool mainnet;
}

const kTestnetNetwork = ShearNetwork(
  id: 'testnet',
  magic: kMagicTestnet,
  flySeed: 'https://pool.shear.digital',
  p2pSeeds: ['pool.shear.digital:30303'],
  mainnet: false,
);

/// Preview profile only. Do not connect this to a live mainnet book in this goal.
const kMainnetNetwork = ShearNetwork(
  id: 'mainnet',
  magic: kMagicMainnet,
  flySeed: '',
  p2pSeeds: [
    'p2p.shear.digital:30303',
    '46.224.132.83:30303',
    '178.105.187.178:30303',
  ],
  mainnet: true,
);

ShearNetwork shearNetworkOf(String? name) {
  final n = (name ?? '').trim().toLowerCase();
  if (n == 'mainnet' || n == kMagicMainnet || n == 'shear-v1') return kMainnetNetwork;
  return kTestnetNetwork;
}
