import 'dart:math' as math;

import 'package:flutter/material.dart';

/// Consensus depth slices, in order: red, white, blue, orange, purple, green.
const kConfirmSliceColors = <Color>[
  Color(0xFFE53935),
  Color(0xFFFFFFFF),
  Color(0xFF1E88E5),
  Color(0xFFFB8C00),
  Color(0xFF8E24AA),
  Color(0xFF43A047),
];

int confirmSlicesFilled(int confirmations, {int need = 6}) {
  if (confirmations <= 0) return 0;
  if (confirmations >= need) return need;
  return confirmations;
}

/// Six-slice pie that fills in as an incoming tx gains confirmations.
class ConfirmPie extends StatelessWidget {
  const ConfirmPie({
    super.key,
    required this.filled,
    this.size = 36,
    this.need = 6,
  });

  final int filled;
  final double size;
  final int need;

  int get slices => confirmSlicesFilled(filled, need: need);

  @override
  Widget build(BuildContext context) {
    final n = slices;
    final dark = Theme.of(context).brightness == Brightness.dark;
    return Semantics(
      label: '$n of $need confirmations',
      child: SizedBox(
        width: size,
        height: size,
        child: CustomPaint(
          size: Size.square(size),
          painter: ConfirmPiePainter(
            filled: n,
            need: need,
            empty: dark ? const Color(0x66FFFFFF) : const Color(0x66000000),
            stroke: Theme.of(context).colorScheme.onSurface.withOpacity(0.85),
          ),
        ),
      ),
    );
  }
}

class ConfirmPiePainter extends CustomPainter {
  ConfirmPiePainter({
    required this.filled,
    required this.need,
    required this.empty,
    required this.stroke,
  });

  final int filled;
  final int need;
  final Color empty;
  final Color stroke;

  @override
  void paint(Canvas canvas, Size size) {
    final c = Offset(size.width / 2, size.height / 2);
    final r = size.shortestSide / 2 - 1.2;
    final sweep = 2 * math.pi / need;
    const start0 = -math.pi / 2;
    final rect = Rect.fromCircle(center: c, radius: r);
    final outline = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1
      ..color = stroke;
    for (var i = 0; i < need; i++) {
      final path = Path()
        ..moveTo(c.dx, c.dy)
        ..arcTo(rect, start0 + i * sweep, sweep, false)
        ..close();
      final fill = Paint()
        ..style = PaintingStyle.fill
        ..color = i < filled ? kConfirmSliceColors[i] : empty;
      canvas.drawPath(path, fill);
      canvas.drawPath(path, outline);
    }
  }

  @override
  bool shouldRepaint(ConfirmPiePainter old) =>
      old.filled != filled || old.need != need || old.empty != empty || old.stroke != stroke;
}
