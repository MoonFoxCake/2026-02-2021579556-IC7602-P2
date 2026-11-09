package cr.ac.tec.ic7602.dnsapi.model;

import java.util.List;
import java.util.Locale;

/** Tipos de registro definidos en el enunciado y los campos que usa cada uno. */
public final class RecordTypes {

    public static final String SINGLE = "single";
    public static final String MULTI = "multi";
    public static final String ROUND_TRIP = "round-trip";
    public static final String WEIGHT = "weight";
    public static final String GEO = "geo";

    public static final List<String> ALL = List.of(SINGLE, MULTI, ROUND_TRIP, WEIGHT, GEO);

    private RecordTypes() {
    }

    /** Normaliza variantes comunes: "Round_Trip", "roundtrip", "WEIGHTED"... */
    public static String normalize(String type) {
        if (type == null) {
            return null;
        }
        String t = type.trim().toLowerCase(Locale.ROOT).replace('_', '-');
        return switch (t) {
            case "roundtrip", "rtt" -> ROUND_TRIP;
            case "weighted" -> WEIGHT;
            default -> t;
        };
    }

    public static boolean needsClientLocation(String type) {
        return GEO.equals(type) || ROUND_TRIP.equals(type);
    }

    /** Metadatos para que la DNS UI arme sus formularios. */
    public static List<TypeInfo> describe() {
        return List.of(
                new TypeInfo(SINGLE, "Una sola IP.", 1, 1, List.of()),
                new TypeInfo(MULTI, "Varias IPs; el Interceptor las alterna con round-robin.", 2, null, List.of()),
                new TypeInfo(ROUND_TRIP, "Varias IPs; se devuelve la de menor latencia según el Health Checker más cercano al cliente.", 2, null, List.of()),
                new TypeInfo(WEIGHT, "Varias IPs con peso; la de mayor peso atiende más peticiones.", 2, null, List.of("weight")),
                new TypeInfo(GEO, "IPs por país; se elige según el país de la IP de origen (si no hay, una al azar).", 1, null, List.of("country"))
        );
    }

    public record TypeInfo(String type, String description, int minTargets, Integer maxTargets,
                           List<String> requiredTargetFields) {
    }
}
