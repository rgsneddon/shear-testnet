import 'package:flutter/material.dart';

import 'shear_reserve.dart';

/// Dark ballot card from Desktop guireserve.jpg.
/// Three towers track the epoch tally from the first vote.
class ReserveVoteTowers extends StatelessWidget {
  const ReserveVoteTowers({
    super.key,
    required this.decrease,
    required this.hold,
    required this.increase,
  });

  final int decrease;
  final int hold;
  final int increase;

  static const _card = Color(0xFF12181E);
  static const _ink = Color(0xFFE7EEF4);
  static const _muted = Color(0xFF8AA0B4);
  static const _cyan = Color(0xFF3DDCFF);
  static const _stub = Color(0xFF3A4553);
  static const _fill = Color(0xFF1F8F78);
  static const _track = 72.0;
  static const _stubH = 14.0;

  @override
  Widget build(BuildContext context) {
    final towers = reserveVoteTowers(
      decrease: decrease,
      hold: hold,
      increase: increase,
    );
    final total = towers.fold<int>(0, (sum, t) => sum + t.votes);
    return Container(
      key: const Key('reserve-vote-towers'),
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 12),
      decoration: BoxDecoration(
        color: _card,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFF243140)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              const Text(
                'VORTEX',
                key: Key('reserve-vote-towers-vortex'),
                style: TextStyle(
                  color: _cyan,
                  fontWeight: FontWeight.w700,
                  letterSpacing: 0.6,
                  fontSize: 13,
                ),
              ),
              const Spacer(),
              Container(
                key: const Key('reserve-vote-towers-reserve'),
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(20),
                  border: Border.all(color: const Color(0xFF3A4A5C)),
                ),
                child: const Text(
                  'RESERVE',
                  style: TextStyle(
                    color: _ink,
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                    letterSpacing: 0.4,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 14),
          const Text(
            'Epoch stake',
            style: TextStyle(color: _muted, fontSize: 13),
          ),
          const Text(
            'π unlocks 1 vote',
            key: Key('reserve-vote-towers-pi'),
            style: TextStyle(
              color: _ink,
              fontSize: 22,
              fontWeight: FontWeight.w700,
              height: 1.2,
            ),
          ),
          const SizedBox(height: 16),
          Row(
            children: [
              for (final t in towers)
                Expanded(
                  child: Text(
                    '${t.votes}',
                    key: Key('reserve-vote-tower-count-${t.id}'),
                    textAlign: TextAlign.center,
                    style: const TextStyle(color: _ink, fontSize: 12, fontWeight: FontWeight.w600),
                  ),
                ),
            ],
          ),
          const SizedBox(height: 4),
          SizedBox(
            height: _track,
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                for (final t in towers)
                  Expanded(child: _bar(t)),
              ],
            ),
          ),
          const SizedBox(height: 6),
          Row(
            children: [
              for (final t in towers)
                Expanded(
                  child: Text(
                    t.label,
                    textAlign: TextAlign.center,
                    style: const TextStyle(color: _muted, fontSize: 12),
                  ),
                ),
            ],
          ),
          const SizedBox(height: 8),
          const Row(
            children: [
              Text('Ballot', key: Key('reserve-vote-towers-ballot'), style: TextStyle(color: _muted, fontSize: 13)),
              Spacer(),
              Text('hashbonus ±1', key: Key('reserve-vote-towers-subject'), style: TextStyle(color: _muted, fontSize: 13)),
            ],
          ),
          if (total == 0)
            const Padding(
              padding: EdgeInsets.only(top: 6),
              child: Text(
                'No votes yet',
                key: Key('reserve-vote-towers-empty'),
                style: TextStyle(color: _muted, fontSize: 12),
              ),
            ),
        ],
      ),
    );
  }

  Widget _bar(ReserveVoteTower tower) {
    final barH = _stubH + tower.share * (_track - _stubH);
    return Padding(
      key: Key('reserve-vote-tower-${tower.id}'),
      padding: const EdgeInsets.symmetric(horizontal: 8),
      child: Align(
        alignment: Alignment.bottomCenter,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 240),
          height: barH,
          width: double.infinity,
          decoration: BoxDecoration(
            color: tower.filled ? _fill : _stub,
            borderRadius: BorderRadius.circular(4),
          ),
        ),
      ),
    );
  }
}
