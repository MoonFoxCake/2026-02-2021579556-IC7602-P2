package cr.ac.tec.ic7602.dnsapi.model;

import java.util.List;

/**
 * Respuesta de GET /api/records/{hostname} para el DNS Interceptor (diseño B:
 * el API informa y el Interceptor decide qué IP devolver).
 */
public record ResolveResponse(
        boolean found,
        String hostname,
        String recordId,
        String type,
        Integer ttl,
        ClientLocation client,
        Integer healthyTargetCount,
        List<TargetInfo> targets
) {
    public static ResolveResponse notFound(String hostname) {
        return new ResolveResponse(false, hostname, null, null, null, null, null, null);
    }
}
