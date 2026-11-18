import '../models/delivery_quote.dart';

/// Gets a driving-distance delivery quote for an address.
abstract interface class DeliveryQuoteRepository {
  Future<DeliveryQuote> requestQuote(String address);
}

/// Used when no quote service is configured: delivery cannot be priced, so
/// checkout asks the customer to try again or choose pickup.
class UnavailableDeliveryQuoteRepository implements DeliveryQuoteRepository {
  const UnavailableDeliveryQuoteRepository();

  @override
  Future<DeliveryQuote> requestQuote(String address) async {
    throw const DeliveryQuoteException(
      'Delivery pricing is temporarily unavailable. Please try again or '
      'choose pickup.',
      code: 'routing_not_configured',
    );
  }
}
