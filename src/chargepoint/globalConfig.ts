export interface GlobalConfiguration {
  region: string;
  endpoints: {
    accounts_endpoint: string;
    internal_api_gateway_endpoint: string;
    mapcache_endpoint: string;
    sso_endpoint: string;
    hcpo_hcm_endpoint: string;
    portal_domain_endpoint: string;
    webservices_endpoint: string;
    panda_websocket_endpoint: string;
    websocket_endpoint: string;
    payment_java_endpoint: string;
    payment_php_endpoint: string;
  };
}

function endpointValue(raw: Record<string, unknown>, key: string): string {
  const v = raw[key];
  if (typeof v === 'object' && v !== null && 'value' in v) {
    return (v as { value: string }).value;
  }
  return typeof v === 'string' ? v : '';
}

export function parseGlobalConfig(raw: Record<string, unknown>): GlobalConfiguration {
  const ep = (raw['endPoints'] ?? {}) as Record<string, unknown>;
  return {
    region: (raw['region'] as string) ?? '',
    endpoints: {
      accounts_endpoint: endpointValue(ep, 'accounts_endpoint'),
      internal_api_gateway_endpoint: endpointValue(ep, 'internal_api_gateway_endpoint'),
      mapcache_endpoint: endpointValue(ep, 'mapcache_endpoint'),
      sso_endpoint: endpointValue(ep, 'sso_endpoint'),
      hcpo_hcm_endpoint: endpointValue(ep, 'hcpo_hcm_endpoint'),
      portal_domain_endpoint: endpointValue(ep, 'portal_domain_endpoint'),
      webservices_endpoint: endpointValue(ep, 'webservices_endpoint'),
      panda_websocket_endpoint: endpointValue(ep, 'panda_websocket_endpoint'),
      websocket_endpoint: endpointValue(ep, 'websocket_endpoint'),
      payment_java_endpoint: endpointValue(ep, 'payment_java_endpoint'),
      payment_php_endpoint: endpointValue(ep, 'payment_php_endpoint'),
    },
  };
}
