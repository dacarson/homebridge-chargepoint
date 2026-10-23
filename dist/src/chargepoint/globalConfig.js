"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseGlobalConfig = parseGlobalConfig;
function endpointValue(raw, key) {
    const v = raw[key];
    if (typeof v === 'object' && v !== null && 'value' in v) {
        return v.value;
    }
    return typeof v === 'string' ? v : '';
}
function parseGlobalConfig(raw) {
    const ep = (raw['endPoints'] ?? {});
    return {
        region: raw['region'] ?? '',
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
