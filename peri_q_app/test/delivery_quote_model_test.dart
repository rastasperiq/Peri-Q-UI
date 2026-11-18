import 'package:flutter_test/flutter_test.dart';
import 'package:peri_q_app/src/core/payment_config.dart';
import 'package:peri_q_app/src/models/app_settings.dart';
import 'package:peri_q_app/src/models/delivery_quote.dart';
import 'package:peri_q_app/src/screens/checkout_screen.dart';

void main() {
  test('reads a server quote and applies the free-delivery threshold', () {
    final quote = DeliveryQuote.fromJson({
      'quoteId': 'q-1',
      'address': '12 Test Street, Bloemfontein',
      'distanceKm': 3.27,
      'durationMinutes': 9,
      'deliveryFee': 28.08,
      'baseFee': 15,
      'pricePerKm': 4,
      'minFee': 20,
      'maxDistanceKm': 15,
      'freeDeliveryThreshold': null,
    });
    expect(quote.feeFor(500), 28.08);
    expect(quote.minimumApplies, isFalse);
    final free = DeliveryQuote.fromJson({
      'quoteId': 'q-2',
      'address': 'x',
      'distanceKm': 1,
      'deliveryFee': 20,
      'baseFee': 15,
      'pricePerKm': 4,
      'minFee': 20,
      'freeDeliveryThreshold': 300,
    });
    expect(free.minimumApplies, isTrue);
    expect(free.feeFor(299.99), 20);
    expect(free.feeFor(300), 0);
  });

  test('matches addresses the same way as the database', () {
    expect(normalizeDeliveryAddress('  12 MAIN road,\n  Heidedal '), '12 main road, heidedal');
    const quote = DeliveryQuote(
      quoteId: 'q',
      address: '12 Main Road, Heidedal',
      distanceKm: 5,
      durationMinutes: 10,
      deliveryFee: 35,
      baseFee: 15,
      pricePerKm: 4,
      minFee: 20,
      maxDistanceKm: 15,
    );
    expect(quote.matches('12  main road, HEIDEDAL'), isTrue);
    expect(quote.matches('13 Main Road, Heidedal'), isFalse);
  });

  test('settings parse distance pricing with defaults and numeric strings', () {
    final defaults = AppSettings.fromJson(const {});
    expect(defaults.deliveryBaseFee, 15);
    expect(defaults.deliveryPricePerKm, 4);
    expect(defaults.deliveryMinFee, 20);
    expect(defaults.deliveryMaxDistanceKm, 15);
    expect(defaults.deliveryFreeThreshold, isNull);
    final parsed = AppSettings.fromJson(const {
      'delivery_base_fee': '12.50',
      'delivery_price_per_km': 5,
      'delivery_min_fee': 25,
      'delivery_max_distance_km': '10',
      'delivery_free_threshold': 400,
    });
    expect(parsed.deliveryBaseFee, 12.5);
    expect(parsed.deliveryMaxDistanceKm, 10);
    expect(parsed.deliveryFreeThreshold, 400);
    expect(parsed.toJson()['delivery_free_threshold'], 400);
    expect(
      parsed.copyWith(clearDeliveryFreeThreshold: true).deliveryFreeThreshold,
      isNull,
    );
  });

  test('formats rands with cents only when needed', () {
    expect(formatRand(70), 'R70');
    expect(formatRand(28.08), 'R28.08');
    expect(formatRand(98.1), 'R98.10');
  });

  test('delivery quote endpoint is the public https site', () {
    expect(deliveryQuoteUri().toString(), 'https://rastasperiq.co.za/api/delivery/quote/');
    expect(deliveryQuoteUri(override: 'http://insecure.test/x'), isNull);
  });
}
