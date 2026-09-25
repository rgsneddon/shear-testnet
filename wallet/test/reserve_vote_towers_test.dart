import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_reserve.dart';
import 'package:shear_wallet/shear_reserve_towers.dart';

void main() {
  test('towers stay empty until the first vote, then scale to the leader', () {
    final none = reserveVoteTowers(decrease: 0, hold: 0, increase: 0);
    expect(none.map((t) => t.id).toList(), ['decrease', 'hold', 'increase']);
    expect(none.every((t) => !t.filled && t.share == 0 && t.votes == 0), isTrue);

    final first = reserveVoteTowers(decrease: 0, hold: 0, increase: 1);
    expect(first[2].filled, isTrue);
    expect(first[2].share, 1);
    expect(first[2].label, '+1');
    expect(first[0].filled, isFalse);
    expect(first[1].filled, isFalse);

    final later = reserveVoteTowers(decrease: 2, hold: 4, increase: 4);
    expect(later[0].share, 0.5);
    expect(later[1].share, 1);
    expect(later[2].share, 1);
    expect(later.every((t) => t.filled), isTrue);

    final clamped = reserveVoteTowers(decrease: -3, hold: 0, increase: 2);
    expect(clamped[0].votes, 0);
    expect(clamped[0].filled, isFalse);
    expect(clamped[2].votes, 2);
  });

  testWidgets('ballot card paints three towers from the running tally', (tester) async {
    await tester.pumpWidget(const MaterialApp(
      home: Scaffold(
        body: ReserveVoteTowers(decrease: 0, hold: 1, increase: 3),
      ),
    ));

    expect(find.byKey(const Key('reserve-vote-towers')), findsOneWidget);
    expect(find.text('VORTEX'), findsOneWidget);
    expect(find.text('RESERVE'), findsOneWidget);
    expect(find.text('π unlocks 1 vote'), findsOneWidget);
    expect(find.text('Ballot'), findsOneWidget);
    expect(find.text('hashbonus ±1'), findsOneWidget);
    expect(find.byKey(const Key('reserve-vote-tower-decrease')), findsOneWidget);
    expect(find.byKey(const Key('reserve-vote-tower-hold')), findsOneWidget);
    expect(find.byKey(const Key('reserve-vote-tower-increase')), findsOneWidget);
    expect(find.text('0'), findsOneWidget);
    expect(find.text('1'), findsOneWidget);
    expect(find.text('3'), findsOneWidget);
    expect(find.byKey(const Key('reserve-vote-towers-empty')), findsNothing);
  });

  testWidgets('before the first vote every tower is an empty stub', (tester) async {
    await tester.pumpWidget(const MaterialApp(
      home: Scaffold(
        body: ReserveVoteTowers(decrease: 0, hold: 0, increase: 0),
      ),
    ));
    expect(find.byKey(const Key('reserve-vote-towers-empty')), findsOneWidget);
    expect(find.text('No votes yet'), findsOneWidget);
  });
}
