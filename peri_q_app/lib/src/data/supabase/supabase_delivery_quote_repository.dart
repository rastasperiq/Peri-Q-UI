import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:supabase_flutter/supabase_flutter.dart';

import '../../core/payment_config.dart';
import '../../models/delivery_quote.dart';
import '../../repositories/delivery_quote_repository.dart';

/// Asks the website server for a driving-distance quote. The routing key
/// stays on the server; the app only sends the address and its session.
class SupabaseDeliveryQuoteRepository implements DeliveryQuoteRepository {
  SupabaseDeliveryQuoteRepository({required this._client});

  final SupabaseClient _client;

  static const _unavailable = DeliveryQuoteException(
    "We couldn't calculate the delivery fee right now. Check your "
    'connection and try again, or choose pickup.',
    code: 'routing_unavailable',
  );

  @override
  Future<DeliveryQuote> requestQuote(String address) async {
    final endpoint = deliveryQuoteUri();
    if (endpoint == null) {
      throw const DeliveryQuoteException(
        'Delivery pricing is temporarily unavailable. Please choose pickup.',
        code: 'routing_not_configured',
      );
    }
    final token = _client.auth.currentSession?.accessToken;
    if (token == null || token.isEmpty) {
      throw const DeliveryQuoteException(
        'Your session has expired. Please reopen checkout.',
        code: 'unauthorized',
      );
    }
    final http = HttpClient()..connectionTimeout = const Duration(seconds: 15);
    try {
      final request = await http.postUrl(endpoint);
      request.headers.contentType = ContentType.json;
      request.headers.set('Authorization', 'Bearer $token');
      request.write(jsonEncode({'address': address.trim()}));
      final response = await request.close().timeout(
        const Duration(seconds: 20),
      );
      final text = await utf8.decoder.bind(response).join();
      Map<String, dynamic> body;
      try {
        body = jsonDecode(text) as Map<String, dynamic>;
      } on FormatException {
        throw _unavailable;
      }
      if (response.statusCode != 200 || body['quoteId'] is! String) {
        throw DeliveryQuoteException(
          body['error'] as String? ?? _unavailable.message,
          code: body['code'] as String?,
        );
      }
      return DeliveryQuote.fromJson(body);
    } on DeliveryQuoteException {
      rethrow;
    } on SocketException {
      throw _unavailable;
    } on TimeoutException {
      throw _unavailable;
    } on HttpException {
      throw _unavailable;
    } finally {
      http.close(force: true);
    }
  }
}
