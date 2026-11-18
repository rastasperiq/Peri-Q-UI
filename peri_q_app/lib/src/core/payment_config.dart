/// Public checkout endpoint; server credentials must never be Dart defines.
Uri? cardCheckoutUri({String? override}) {
  const configured = String.fromEnvironment(
    'CARD_CHECKOUT_URL',
    defaultValue: 'https://rastasperiq.co.za/api/yoco/checkout/',
  );
  return _publicHttpsEndpoint(override ?? configured);
}

/// Server endpoint that prices delivery by driving distance. The routing
/// key lives only on the server.
Uri? deliveryQuoteUri({String? override}) {
  const configured = String.fromEnvironment(
    'DELIVERY_QUOTE_URL',
    defaultValue: 'https://rastasperiq.co.za/api/delivery/quote/',
  );
  return _publicHttpsEndpoint(override ?? configured);
}

Uri? _publicHttpsEndpoint(String value) {
  final uri = Uri.tryParse(value.trim());
  if (uri == null ||
      uri.scheme != 'https' ||
      uri.host.isEmpty ||
      uri.userInfo.isNotEmpty ||
      uri.hasQuery ||
      uri.hasFragment) {
    return null;
  }
  return uri;
}
