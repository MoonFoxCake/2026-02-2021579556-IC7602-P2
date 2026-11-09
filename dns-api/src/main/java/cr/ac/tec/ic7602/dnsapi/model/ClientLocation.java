package cr.ac.tec.ic7602.dnsapi.model;

/**
 * Ubicación estimada del cliente DNS a partir de su IP (base IP-to-Country).
 *
 * found=false si la IP no está en ningún rango cargado; en ese caso los demás
 * campos (salvo ip) vienen ausentes.
 */
public record ClientLocation(
        String ip,
        boolean found,
        String rangeId,
        String countryCode,
        String countryName,
        String city,
        Double latitude,
        Double longitude
) {
    public static ClientLocation notFound(String ip) {
        return new ClientLocation(ip, false, null, null, null, null, null, null);
    }

    public boolean hasCoordinates() {
        return latitude != null && longitude != null;
    }
}
