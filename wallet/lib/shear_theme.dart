import 'package:flutter/material.dart';

/// Pack-derived in-app art. [logo.png] is a square canvas; the mark is a circle (no stretch).
const kShearLogoAsset = 'assets/brand/logo.png';
const kShearWordmarkLight = 'assets/brand/wordmark-light.png';
const kShearWordmarkDark = 'assets/brand/wordmark-dark.png';

/// Pool light palette.
const shearBg = Color(0xFFEEF3F8);
const shearCard = Color(0xFFFFFFFF);
const shearInk = Color(0xFF0D2137);
const shearMuted = Color(0xFF5A738C);
const shearCyan = Color(0xFF0088A8);
const shearBlue = Color(0xFF1A6FB5);
const shearGreen = Color(0xFF1A9A4A);
const shearField = Color(0xFFF4F8FC);
const shearBar = Color(0xFFF7FBFF);

/// Dark palette (pack dark-bg / wordmark-dark).
const shearDarkBg = Color(0xFF0A1628);
const shearDarkCard = Color(0xFF132A4A);
const shearDarkInk = Color(0xFFE8F1F8);
const shearDarkMuted = Color(0xFF8AA4BC);
const shearDarkCyan = Color(0xFF4FD8E8);
const shearDarkField = Color(0xFF0F2038);
const shearDarkBar = Color(0xFF06141F);

ThemeData shearTheme() => shearLightTheme();

InputDecorationTheme _input(Color fill, Color label, Color ink) {
  return InputDecorationTheme(
    filled: true,
    fillColor: fill,
    labelStyle: TextStyle(color: label),
    hintStyle: TextStyle(color: label),
    prefixStyle: TextStyle(color: ink),
    suffixStyle: TextStyle(color: ink),
    floatingLabelStyle: TextStyle(color: label),
    border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
    enabledBorder: OutlineInputBorder(
      borderRadius: BorderRadius.circular(8),
      borderSide: BorderSide(color: label.withOpacity(0.35)),
    ),
    focusedBorder: OutlineInputBorder(
      borderRadius: BorderRadius.circular(8),
      borderSide: BorderSide(color: label),
    ),
  );
}

ThemeData shearLightTheme() {
  const scheme = ColorScheme.light(
    surface: shearCard,
    surfaceContainer: shearCard,
    surfaceContainerLow: shearCard,
    surfaceContainerHigh: shearCard,
    surfaceContainerHighest: shearField,
    surfaceContainerLowest: shearBg,
    primary: shearCyan,
    secondary: shearBlue,
    onSurface: shearInk,
    onPrimary: Colors.white,
    onSecondary: Colors.white,
  );
  return ThemeData(
    useMaterial3: true,
    brightness: Brightness.light,
    scaffoldBackgroundColor: shearBg,
    canvasColor: shearBg,
    dialogBackgroundColor: shearCard,
    colorScheme: scheme,
    appBarTheme: const AppBarTheme(
      backgroundColor: shearBar,
      foregroundColor: shearInk,
      elevation: 0,
      surfaceTintColor: Colors.transparent,
    ),
    cardColor: shearCard,
    cardTheme: const CardThemeData(
      color: shearCard,
      elevation: 0,
      surfaceTintColor: Colors.transparent,
      shadowColor: Colors.transparent,
      margin: EdgeInsets.zero,
    ),
    inputDecorationTheme: _input(shearField, shearMuted, shearInk),
    listTileTheme: const ListTileThemeData(
      tileColor: Colors.transparent,
      textColor: shearInk,
      iconColor: shearMuted,
      subtitleTextStyle: TextStyle(color: shearMuted),
    ),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: shearBar,
      indicatorColor: shearCyan.withOpacity(0.18),
      surfaceTintColor: Colors.transparent,
      labelTextStyle: WidgetStatePropertyAll(
        const TextStyle(color: shearInk, fontSize: 12),
      ),
      iconTheme: const WidgetStatePropertyAll(IconThemeData(color: shearInk)),
    ),
    textTheme: ThemeData.light().textTheme.apply(
      bodyColor: shearInk,
      displayColor: shearInk,
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(foregroundColor: Colors.white, backgroundColor: shearCyan),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(foregroundColor: shearInk),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(foregroundColor: shearCyan),
    ),
    snackBarTheme: const SnackBarThemeData(
      backgroundColor: shearInk,
      contentTextStyle: TextStyle(color: Colors.white),
    ),
    bannerTheme: const MaterialBannerThemeData(
      backgroundColor: shearField,
      contentTextStyle: TextStyle(color: shearInk),
    ),
    chipTheme: const ChipThemeData(
      backgroundColor: shearField,
      selectedColor: Color(0xFFD7ECF3),
      labelStyle: TextStyle(color: shearInk),
      secondaryLabelStyle: TextStyle(color: shearInk),
    ),
    tabBarTheme: const TabBarThemeData(
      labelColor: shearCyan,
      unselectedLabelColor: shearMuted,
      indicatorColor: shearCyan,
    ),
    dividerColor: const Color(0xFFD5E0EA),
  );
}

ThemeData shearDarkTheme() {
  const scheme = ColorScheme.dark(
    surface: shearDarkCard,
    surfaceContainer: shearDarkCard,
    surfaceContainerLow: shearDarkCard,
    surfaceContainerHigh: shearDarkCard,
    surfaceContainerHighest: shearDarkField,
    surfaceContainerLowest: shearDarkBg,
    primary: shearDarkCyan,
    secondary: shearBlue,
    onSurface: shearDarkInk,
    onPrimary: shearDarkBg,
    onSecondary: shearDarkInk,
  );
  return ThemeData(
    useMaterial3: true,
    brightness: Brightness.dark,
    scaffoldBackgroundColor: shearDarkBg,
    canvasColor: shearDarkBg,
    dialogBackgroundColor: shearDarkCard,
    colorScheme: scheme,
    appBarTheme: const AppBarTheme(
      backgroundColor: shearDarkBar,
      foregroundColor: shearDarkInk,
      elevation: 0,
      surfaceTintColor: Colors.transparent,
    ),
    cardColor: shearDarkCard,
    cardTheme: const CardThemeData(
      color: shearDarkCard,
      elevation: 0,
      surfaceTintColor: Colors.transparent,
      shadowColor: Colors.transparent,
      margin: EdgeInsets.zero,
    ),
    inputDecorationTheme: _input(shearDarkField, shearDarkMuted, shearDarkInk),
    listTileTheme: const ListTileThemeData(
      tileColor: Colors.transparent,
      textColor: shearDarkInk,
      iconColor: shearDarkMuted,
      subtitleTextStyle: TextStyle(color: shearDarkMuted),
    ),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: shearDarkBar,
      indicatorColor: shearDarkCyan.withOpacity(0.22),
      surfaceTintColor: Colors.transparent,
      labelTextStyle: WidgetStatePropertyAll(
        const TextStyle(color: shearDarkInk, fontSize: 12),
      ),
      iconTheme: const WidgetStatePropertyAll(IconThemeData(color: shearDarkInk)),
    ),
    textTheme: ThemeData.dark().textTheme.apply(
      bodyColor: shearDarkInk,
      displayColor: shearDarkInk,
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(foregroundColor: shearDarkBg, backgroundColor: shearDarkCyan),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(foregroundColor: shearDarkInk),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(foregroundColor: shearDarkCyan),
    ),
    snackBarTheme: const SnackBarThemeData(
      backgroundColor: shearDarkField,
      contentTextStyle: TextStyle(color: shearDarkInk),
    ),
    bannerTheme: const MaterialBannerThemeData(
      backgroundColor: shearDarkCard,
      contentTextStyle: TextStyle(color: shearDarkInk),
    ),
    chipTheme: const ChipThemeData(
      backgroundColor: shearDarkField,
      selectedColor: Color(0xFF1C3F66),
      labelStyle: TextStyle(color: shearDarkInk),
      secondaryLabelStyle: TextStyle(color: shearDarkInk),
    ),
    tabBarTheme: const TabBarThemeData(
      labelColor: shearDarkCyan,
      unselectedLabelColor: shearDarkMuted,
      indicatorColor: shearDarkCyan,
    ),
    dividerColor: const Color(0xFF2A4566),
  );
}

String shearWordmarkAsset(Brightness b) =>
    b == Brightness.dark ? kShearWordmarkDark : kShearWordmarkLight;

Color shearMutedOf(BuildContext context) =>
    Theme.of(context).brightness == Brightness.dark ? shearDarkMuted : shearMuted;

Color shearAccentOf(BuildContext context) => Theme.of(context).colorScheme.primary;
