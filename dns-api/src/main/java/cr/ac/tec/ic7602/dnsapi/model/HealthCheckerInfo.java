package cr.ac.tec.ic7602.dnsapi.model;

/** Un Health Checker registrado en /healthCheckers/{id}. */
public record HealthCheckerInfo(
        String id,
        String city,
        String country,
        Double latitude,
        Double longitude,
        Long lastSeenAt,
        String lastSeenAtIso,
        Long secondsSinceLastSeen,
        boolean online
) {
    public boolean hasCoordinates() {
        return latitude != null && longitude != null;
    }
}
