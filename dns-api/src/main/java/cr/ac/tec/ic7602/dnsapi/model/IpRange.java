package cr.ac.tec.ic7602.dnsapi.model;

/** Un rango de la base IP-to-Country, tal como se guarda en /ipToCountry/{id}. */
public record IpRange(
        String id,
        String startIp,
        String endIp,
        long ipFrom,
        long ipTo,
        String countryCode,
        String countryName,
        String city,
        Double latitude,
        Double longitude
) {
}
