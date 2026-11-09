package cr.ac.tec.ic7602.dnsapi.geo;

/** Conversión de direcciones IPv4 a número (como en las bases IP-to-Country) y viceversa. */
public final class Ipv4 {

    private Ipv4() {
    }

    /** "1.2.3.4" -> 16909060. Devuelve -1 si no es una IPv4 válida (IPv6 no está soportado). */
    public static long toLong(String ip) {
        if (ip == null) {
            return -1;
        }
        String[] parts = ip.trim().split("\\.", -1);
        if (parts.length != 4) {
            return -1;
        }
        long value = 0;
        for (String part : parts) {
            if (part.isEmpty() || part.length() > 3 || !part.chars().allMatch(Character::isDigit)) {
                return -1;
            }
            int octet = Integer.parseInt(part);
            if (octet > 255) {
                return -1;
            }
            value = (value << 8) | octet;
        }
        return value;
    }

    /** 16909060 -> "1.2.3.4". */
    public static String fromLong(long value) {
        return ((value >> 24) & 0xFF) + "." + ((value >> 16) & 0xFF) + "."
                + ((value >> 8) & 0xFF) + "." + (value & 0xFF);
    }
}
