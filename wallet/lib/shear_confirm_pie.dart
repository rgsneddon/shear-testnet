import 'dart:math' as math;

import 'package:flutter/material.dart';

/// Waiting point. Blue neon, same family as the DAG blue shares.
const kConfirmVortexBlue = Color(0xFF3D8BFF);

/// Landed confirmation. The point turns yellow.
const kConfirmVortexYellow = Color(0xFFFFD24A);

/// Orbit marks. Each lit point is one confirmation. The ninth lights the core.
const kConfirmVortexPoints = 8;

int confirmPointsLit(int confirmations, {int points = kConfirmVortexPoints}) {
  if (confirmations <= 0) return 0;
  if (confirmations >= points) return points;
  return confirmations;
}

bool confirmVortexCoreLit(int confirmations, {int need = 9}) {
  return confirmations >= need;
}

/// Small vortex for a pending transfer. Eight neon points, one per confirmation.
class ConfirmVortex extends StatelessWidget {
  const ConfirmVortex({
    super.key,
    required this.filled,
    this.size = 28,
    this.need = 9,
    this.points = kConfirmVortexPoints,
  });

  final int filled;
  final double size;
  final int need;
  final int points;

  int get lit => confirmPointsLit(filled, points: points);

  @override
  Widget build(BuildContext context) {
    final n = lit;
    final core = confirmVortexCoreLit(filled, need: need);
    final dark = Theme.of(context).brightness == Brightness.dark;
    return Semantics(
      label: '$filled of $need confirmations',
      child: SizedBox(
        width: size,
        height: size,
        child: CustomPaint(
          size: Size.square(size),
          painter: ConfirmVortexPainter(
            lit: n,
            points: points,
            core: core,
            empty: dark ? const Color(0x66FFFFFF) : const Color(0x33000000),
            ring: dark ? const Color(0x663D8BFF) : const Color(0x883D8BFF),
          ),
        ),
      ),
    );
  }
}

class ConfirmVortexPainter extends CustomPainter {
  ConfirmVortexPainter({
    required this.lit,
    required this.points,
    required this.core,
    required this.empty,
    required this.ring,
  });

  final int lit;
  final int points;
  final bool core;
  final Color empty;
  final Color ring;

  @override
  void paint(Canvas canvas, Size size) {
    final c = Offset(size.width / 2, size.height / 2);
    final r = size.shortestSide / 2 - 1.2;
    canvas.drawCircle(c, r, Paint()..color = empty);
    final ringPaint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 0.7
      ..color = ring;
    canvas.drawCircle(c, r * 0.72, ringPaint);
    canvas.drawCircle(c, r * 0.42, ringPaint);
    final spoke = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 0.6
      ..color = ring.withValues(alpha: 0.55);
    final n = points < 1 ? 1 : points;
    const start0 = -math.pi / 2;
    for (var i = 0; i < n; i++) {
      final a = start0 + i * 2 * math.pi / n;
      final tip = c + Offset(math.cos(a) * r * 0.78, math.sin(a) * r * 0.78);
      canvas.drawLine(c, tip, spoke);
      final on = i < lit;
      final ink = on ? kConfirmVortexYellow : kConfirmVortexBlue;
      final glowR = on ? r * 0.18 : r * 0.12;
      canvas.drawCircle(tip, glowR, Paint()..color = ink.withValues(alpha: on ? 0.5 : 0.28));
      canvas.drawCircle(tip, on ? r * 0.09 : r * 0.07, Paint()..color = ink);
    }
    final coreInk = core ? kConfirmVortexYellow : kConfirmVortexBlue;
    final coreR = core ? r * 0.16 : r * 0.07;
    canvas.drawCircle(c, coreR * 1.8, Paint()..color = coreInk.withValues(alpha: core ? 0.4 : 0.18));
    canvas.drawCircle(c, coreR, Paint()..color = coreInk);
  }

  @override
  bool shouldRepaint(ConfirmVortexPainter old) =>
      old.lit != lit || old.points != points || old.core != core || old.empty != empty || old.ring != ring;
}
