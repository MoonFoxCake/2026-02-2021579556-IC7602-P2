package cr.ac.tec.ic7602.dnsapi.geo;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import cr.ac.tec.ic7602.dnsapi.firebase.FirebaseAuth;
import cr.ac.tec.ic7602.dnsapi.firebase.FirebaseRestClient;
import cr.ac.tec.ic7602.dnsapi.model.ClientLocation;
import cr.ac.tec.ic7602.dnsapi.model.IpRange;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Consulta la base IP-to-Country guardada en Firebase, en /ipToCountry/{id}:
 *
 * <pre>
 * { "ipFrom": 16777216, "ipTo": 16777471, "startIp": "1.0.0.0", "endIp": "1.0.0.255",
 *   "countryCode": "AU", "countryName": "Australia",
 *   "city": "Brisbane", "latitude": -27.46, "longitude": 153.02 }   // city/lat/lon opcionales
 * </pre>
 *
 * La búsqueda usa orderBy="ipFrom"&endAt=N&limitToLast=1 (el rango con mayor ipFrom <= N)
 * y luego verifica que N <= ipTo. Requiere ".indexOn": ["ipFrom"] en las reglas.
 */
public class IpToCountryService {

    private static final String PATH = "ipToCountry";

    private final FirebaseRestClient client;

    public IpToCountryService(FirebaseRestClient client) {
        this.client = client;
    }

    public ClientLocation lookup(String ip) throws FirebaseAuth.FirebaseException {
        long value = Ipv4.toLong(ip);
        if (value < 0) {
            return ClientLocation.notFound(ip);
        }

        Map<String, String> params = new LinkedHashMap<>();
        params.put("orderBy", "\"ipFrom\"");
        params.put("endAt", Long.toString(value));
        params.put("limitToLast", "1");

        JsonObject result = client.getObject(PATH, params);
        for (Map.Entry<String, JsonElement> entry : result.entrySet()) {
            if (!entry.getValue().isJsonObject()) {
                continue;
            }
            IpRange range = toRange(entry.getKey(), entry.getValue().getAsJsonObject());
            if (range != null && value >= range.ipFrom() && value <= range.ipTo()) {
                return new ClientLocation(ip, true, range.id(), range.countryCode(), range.countryName(),
                        range.city(), range.latitude(), range.longitude());
            }
        }
        return ClientLocation.notFound(ip);
    }

    /**
     * Página de rangos ordenados por id, para la DNS UI.
     * @param cursor id del último rango de la página anterior (o null para empezar).
     */
    public Page list(int limit, String cursor) throws FirebaseAuth.FirebaseException {
        Map<String, String> params = new LinkedHashMap<>();
        params.put("orderBy", "\"$key\"");
        boolean hasCursor = cursor != null && !cursor.isBlank();
        if (hasCursor) {
            params.put("startAt", "\"" + cursor + "\"");
        }
        // Con cursor se pide uno extra porque startAt incluye el propio cursor.
        params.put("limitToFirst", Integer.toString(limit + (hasCursor ? 2 : 1)));

        JsonObject result = client.getObject(PATH, params);
        List<IpRange> items = new ArrayList<>();
        for (Map.Entry<String, JsonElement> entry : new java.util.TreeMap<>(result.asMap()).entrySet()) {
            if (hasCursor && entry.getKey().equals(cursor)) {
                continue;
            }
            if (entry.getValue().isJsonObject()) {
                IpRange range = toRange(entry.getKey(), entry.getValue().getAsJsonObject());
                if (range != null) {
                    items.add(range);
                }
            }
        }
        String nextCursor = null;
        if (items.size() > limit) {
            items = new ArrayList<>(items.subList(0, limit));
            nextCursor = items.get(items.size() - 1).id();
        }
        return new Page(items, nextCursor);
    }

    static IpRange toRange(String id, JsonObject json) {
        Long from = longOrNull(json, "ipFrom");
        Long to = longOrNull(json, "ipTo");
        if (from == null && json.has("startIp")) {
            long v = Ipv4.toLong(json.get("startIp").getAsString());
            from = v >= 0 ? v : null;
        }
        if (to == null && json.has("endIp")) {
            long v = Ipv4.toLong(json.get("endIp").getAsString());
            to = v >= 0 ? v : null;
        }
        if (from == null || to == null) {
            return null;
        }
        String code = str(json, "countryCode");
        return new IpRange(id, Ipv4.fromLong(from), Ipv4.fromLong(to), from, to,
                code == null ? null : code.toUpperCase(Locale.ROOT),
                str(json, "countryName"), str(json, "city"),
                doubleOrNull(json, "latitude"), doubleOrNull(json, "longitude"));
    }

    private static String str(JsonObject json, String key) {
        return json.has(key) && json.get(key).isJsonPrimitive() ? json.get(key).getAsString() : null;
    }

    private static Long longOrNull(JsonObject json, String key) {
        try {
            return json.has(key) && json.get(key).isJsonPrimitive() ? json.get(key).getAsLong() : null;
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private static Double doubleOrNull(JsonObject json, String key) {
        try {
            return json.has(key) && json.get(key).isJsonPrimitive() ? json.get(key).getAsDouble() : null;
        } catch (NumberFormatException e) {
            return null;
        }
    }

    public record Page(List<IpRange> items, String nextCursor) {
    }
}
