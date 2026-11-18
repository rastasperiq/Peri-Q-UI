/// A driving-distance delivery quote from the website server
/// (`/api/delivery/quote`). The fee is for display: the database recalculates
/// it from the quote's distance when checkout starts.
class DeliveryQuote {
  const DeliveryQuote({
    required this.quoteId,
    required this.address,
    required this.distanceKm,
    required this.durationMinutes,
    required this.deliveryFee,
    required this.baseFee,
    required this.pricePerKm,
    required this.minFee,
    required this.maxDistanceKm,
    this.freeDeliveryThreshold,
  });

  final String quoteId;
  final String address;
  final double distanceKm;
  final int durationMinutes;
  final double deliveryFee;
  final double baseFee;
  final double pricePerKm;
  final double minFee;
  final double maxDistanceKm;
  final double? freeDeliveryThreshold;

  factory DeliveryQuote.fromJson(Map<String, dynamic> json) {
    double number(String key, [double fallback = 0]) =>
        (json[key] as num?)?.toDouble() ?? fallback;
    final threshold = json['freeDeliveryThreshold'] as num?;
    return DeliveryQuote(
      quoteId: json['quoteId'] as String? ?? '',
      address: json['address'] as String? ?? '',
      distanceKm: number('distanceKm'),
      durationMinutes: (json['durationMinutes'] as num?)?.round() ?? 0,
      deliveryFee: number('deliveryFee'),
      baseFee: number('baseFee'),
      pricePerKm: number('pricePerKm'),
      minFee: number('minFee'),
      maxDistanceKm: number('maxDistanceKm', 15),
      freeDeliveryThreshold: threshold?.toDouble(),
    );
  }

  /// Whether this quote was made for [address] (same rule as the database).
  bool matches(String address) =>
      normalizeDeliveryAddress(this.address) ==
      normalizeDeliveryAddress(address);

  /// Delivery fee for a cart: free at or above the threshold when one is set.
  double feeFor(double itemsSubtotal) {
    final threshold = freeDeliveryThreshold;
    if (threshold != null && itemsSubtotal >= threshold) return 0;
    return deliveryFee;
  }

  /// True when the minimum fee, not the per-km sum, sets the price.
  bool get minimumApplies => baseFee + (distanceKm * pricePerKm) < minFee;
}

/// Same normalisation as `public.normalize_delivery_address` in the database.
String normalizeDeliveryAddress(String address) =>
    address.trim().replaceAll(RegExp(r'\s+'), ' ').toLowerCase();

/// Why a quote could not be made, worded for the customer.
class DeliveryQuoteException implements Exception {
  const DeliveryQuoteException(this.message, {this.code});

  final String message;
  final String? code;

  @override
  String toString() => message;
}
