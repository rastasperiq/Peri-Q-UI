import 'todays_special_settings.dart';

class AppSettings {
  const AppSettings({
    this.storeOpen = true,
    this.pickupAvailable = true,
    this.deliveryAvailable = true,
    this.deliveryFee = 30,
    this.deliveryBaseFee = 15,
    this.deliveryPricePerKm = 4,
    this.deliveryMinFee = 20,
    this.deliveryMaxDistanceKm = 15,
    this.deliveryFreeThreshold,
    this.openingTime = '10:00',
    this.closingTime = '21:00',
    this.todaysSpecial = const TodaysSpecialSettings(),
  });

  final bool storeOpen;
  final bool pickupAvailable;
  final bool deliveryAvailable;
  /// Legacy flat fee, kept for old app versions. Checkout now prices
  /// delivery by driving distance with the fields below.
  final double deliveryFee;
  final double deliveryBaseFee;
  final double deliveryPricePerKm;
  final double deliveryMinFee;
  final double deliveryMaxDistanceKm;

  /// Items subtotal at or above which delivery is free; null = disabled.
  final double? deliveryFreeThreshold;
  final String openingTime;
  final String closingTime;
  final TodaysSpecialSettings todaysSpecial;

  AppSettings copyWith({
    bool? storeOpen,
    bool? pickupAvailable,
    bool? deliveryAvailable,
    double? deliveryFee,
    double? deliveryBaseFee,
    double? deliveryPricePerKm,
    double? deliveryMinFee,
    double? deliveryMaxDistanceKm,
    double? deliveryFreeThreshold,
    bool clearDeliveryFreeThreshold = false,
    String? openingTime,
    String? closingTime,
    TodaysSpecialSettings? todaysSpecial,
  }) {
    return AppSettings(
      storeOpen: storeOpen ?? this.storeOpen,
      pickupAvailable: pickupAvailable ?? this.pickupAvailable,
      deliveryAvailable: deliveryAvailable ?? this.deliveryAvailable,
      deliveryFee: deliveryFee ?? this.deliveryFee,
      deliveryBaseFee: deliveryBaseFee ?? this.deliveryBaseFee,
      deliveryPricePerKm: deliveryPricePerKm ?? this.deliveryPricePerKm,
      deliveryMinFee: deliveryMinFee ?? this.deliveryMinFee,
      deliveryMaxDistanceKm:
          deliveryMaxDistanceKm ?? this.deliveryMaxDistanceKm,
      deliveryFreeThreshold: clearDeliveryFreeThreshold
          ? null
          : deliveryFreeThreshold ?? this.deliveryFreeThreshold,
      openingTime: openingTime ?? this.openingTime,
      closingTime: closingTime ?? this.closingTime,
      todaysSpecial: todaysSpecial ?? this.todaysSpecial,
    );
  }

  factory AppSettings.fromJson(Map<String, dynamic>? json) {
    if (json == null) {
      return const AppSettings();
    }

    return AppSettings(
      storeOpen: json['store_open'] as bool? ?? true,
      pickupAvailable: json['pickup_available'] as bool? ?? true,
      deliveryAvailable: json['delivery_available'] as bool? ?? true,
      deliveryFee: (json['delivery_fee'] as num?)?.toDouble() ?? 30,
      deliveryBaseFee: _number(json['delivery_base_fee'], 15),
      deliveryPricePerKm: _number(json['delivery_price_per_km'], 4),
      deliveryMinFee: _number(json['delivery_min_fee'], 20),
      deliveryMaxDistanceKm: _number(json['delivery_max_distance_km'], 15),
      deliveryFreeThreshold: _optionalNumber(json['delivery_free_threshold']),
      openingTime: _validTimeOrDefault(json['opening_time'], '10:00'),
      closingTime: _validTimeOrDefault(json['closing_time'], '21:00'),
      todaysSpecial: TodaysSpecialSettings.fromJson(json),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'store_open': storeOpen,
      'pickup_available': pickupAvailable,
      'delivery_available': deliveryAvailable,
      'delivery_fee': deliveryFee,
      'delivery_base_fee': deliveryBaseFee,
      'delivery_price_per_km': deliveryPricePerKm,
      'delivery_min_fee': deliveryMinFee,
      'delivery_max_distance_km': deliveryMaxDistanceKm,
      'delivery_free_threshold': deliveryFreeThreshold,
      'opening_time': openingTime.trim(),
      'closing_time': closingTime.trim(),
      ...todaysSpecial.toJson(),
    };
  }

  bool isOpenAt(DateTime dateTime) {
    if (!storeOpen) {
      return false;
    }

    final openingMinutes = _minutesFromTime(openingTime);
    final closingMinutes = _minutesFromTime(closingTime);
    final nowMinutes = (dateTime.hour * 60) + dateTime.minute;

    if (openingMinutes == closingMinutes) {
      return true;
    }

    if (openingMinutes < closingMinutes) {
      return nowMinutes >= openingMinutes && nowMinutes < closingMinutes;
    }

    return nowMinutes >= openingMinutes || nowMinutes < closingMinutes;
  }

  static int _minutesFromTime(String value) {
    final parts = value.split(':');
    if (parts.length != 2) {
      return 0;
    }

    final hour = int.tryParse(parts[0]) ?? 0;
    final minute = int.tryParse(parts[1]) ?? 0;
    return (hour.clamp(0, 23) * 60) + minute.clamp(0, 59);
  }

  // Postgres numeric columns can arrive as numbers or strings.
  static double _number(Object? value, double fallback) =>
      _optionalNumber(value) ?? fallback;

  static double? _optionalNumber(Object? value) {
    if (value is num) return value.toDouble();
    if (value is String) return double.tryParse(value);
    return null;
  }

  static String _validTimeOrDefault(Object? value, String fallback) {
    final text = value?.toString().trim() ?? '';
    if (RegExp(r'^\d{2}:\d{2}$').hasMatch(text)) {
      return text;
    }
    return fallback;
  }
}
