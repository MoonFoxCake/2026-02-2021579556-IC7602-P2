package cr.ac.tec.ic7602.dnsapi.firebase;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import cr.ac.tec.ic7602.dnsapi.dns.DnsExistsChecker;

import java.net.http.HttpClient;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Implementación de DnsExistsChecker sobre la API REST de Firebase Realtime Database.
 *
 * Consulta: GET {DB_URL}/dnsRecords.json?orderBy="hostname"&equalTo="<host>"&auth=<token>[&ns=<namespace>]
 * Requiere ".indexOn": ["hostname"] en database.rules.json (ya está).
 */
public class FirebaseDnsExistsChecker implements DnsExistsChecker {

    private final FirebaseRestClient client;

    public FirebaseDnsExistsChecker(FirebaseRestClient client) {
        this.client = client;
    }

    public FirebaseDnsExistsChecker(HttpClient http, FirebaseAuth auth, String dbUrl, String namespace) {
        this(new FirebaseRestClient(http, auth, dbUrl, namespace));
    }

    @Override
    public boolean exists(String domain) {
        try {
            return !findEnabledByHostname(domain).isEmpty();
        } catch (FirebaseAuth.FirebaseException e) {
            throw new IllegalStateException(e.getMessage(), e);
        }
    }

    /**
     * Devuelve los registros habilitados cuyo hostname coincide, como {recordId: {...}}.
     */
    public JsonObject findEnabledByHostname(String domain) throws FirebaseAuth.FirebaseException {
        Map<String, String> params = new LinkedHashMap<>();
        params.put("orderBy", "\"hostname\"");
        params.put("equalTo", "\"" + normalize(domain) + "\"");

        JsonObject matches = client.getObject("dnsRecords", params);
        JsonObject result = new JsonObject();
        for (Map.Entry<String, JsonElement> entry : matches.entrySet()) {
            if (!entry.getValue().isJsonObject()) {
                continue;
            }
            JsonObject record = entry.getValue().getAsJsonObject();
            boolean enabled = !record.has("enabled") || record.get("enabled").getAsBoolean();
            if (enabled) {
                result.add(entry.getKey(), record);
            }
        }
        return result;
    }

    /** "WWW.Ejemplo.com." -> "www.ejemplo.com" (los nombres DNS no distinguen mayúsculas). */
    public static String normalize(String domain) {
        String d = domain.trim().toLowerCase(Locale.ROOT);
        return d.endsWith(".") ? d.substring(0, d.length() - 1) : d;
    }
}
