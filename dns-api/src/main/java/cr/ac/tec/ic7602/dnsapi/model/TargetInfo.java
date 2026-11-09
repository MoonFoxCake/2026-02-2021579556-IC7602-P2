package cr.ac.tec.ic7602.dnsapi.model;

/**
 * Un target (IP) de un registro, con lo que el DNS Interceptor necesita para decidir.
 *
 * weight:  solo en registros "weight" (default 1 si no se definió).
 * country: solo si el target lo define (registros "geo").
 * latency*: solo en registros "round-trip" (latencia estimada desde la ubicación del cliente).
 */
public record TargetInfo(
        String id,
        String address,
        Integer port,
        boolean healthy,
        String healthStatus,
        Integer weight,
        String country,
        Double latencyMs,
        String latencySource,
        String latencyCheckerId,
        Double latencyDistanceKm
) {
}
