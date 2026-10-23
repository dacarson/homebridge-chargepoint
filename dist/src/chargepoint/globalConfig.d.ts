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
export declare function parseGlobalConfig(raw: Record<string, unknown>): GlobalConfiguration;
