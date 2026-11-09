package cr.ac.tec.ic7602.dnsapi.service;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import cr.ac.tec.ic7602.dnsapi.firebase.FirebaseAuth;
import cr.ac.tec.ic7602.dnsapi.firebase.FirebaseDnsExistsChecker;
import cr.ac.tec.ic7602.dnsapi.firebase.FirebaseRestClient;
import cr.ac.tec.ic7602.dnsapi.model.HealthCheckerInfo;

import java.time.Clock;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import java.util.TreeMap;

/** Lecturas de Firebase que comparten el Interceptor y la DNS UI. */
public class DnsDataRepository {

    private final FirebaseRestClient client;
    private final FirebaseDnsExistsChecker checker;
    private final Clock clock;
    private final int checkerOnlineSeconds;

    public DnsDataRepository(FirebaseRestClient client, FirebaseDnsExistsChecker checker,
                             Clock clock, int checkerOnlineSeconds) {
        this.client = client;
        this.checker = checker;
        this.clock = clock;
        this.checkerOnlineSeconds = checkerOnlineSeconds;
    }

    /** Primer registro habilitado (por recordId) para el hostname. */
    public Optional<Map.Entry<String, JsonObject>> findEnabledByHostname(String hostname)
            throws FirebaseAuth.FirebaseException {
        JsonObject matches = checker.findEnabledByHostname(hostname);
        return new TreeMap<>(matches.asMap()).entrySet().stream()
                .filter(e -> e.getValue().isJsonObject())
                .map(e -> Map.entry(e.getKey(), e.getValue().getAsJsonObject()))
                .findFirst();
    }

    public JsonObject getAllRecords() throws FirebaseAuth.FirebaseException {
        return client.getObject("dnsRecords");
    }

    public Optional<JsonObject> getRecord(String recordId) throws FirebaseAuth.FirebaseException {
        JsonElement element = client.get("dnsRecords/" + FirebaseRestClient.segment(recordId));
        return element.isJsonObject() ? Optional.of(element.getAsJsonObject()) : Optional.empty();
    }

    /** /healthResults/{recordId} -> {targetId: {checkerId: {...}}} */
    public JsonObject getHealthResults(String recordId) throws FirebaseAuth.FirebaseException {
        return client.getObject("healthResults/" + FirebaseRestClient.segment(recordId));
    }

    /** /healthResults completo -> {recordId: {targetId: {checkerId: {...}}}} */
    public JsonObject getAllHealthResults() throws FirebaseAuth.FirebaseException {
        return client.getObject("healthResults");
    }

    /** /healthCheckers como mapa checkerId -> info, con el cálculo de "online". */
    public Map<String, HealthCheckerInfo> getHealthCheckers() throws FirebaseAuth.FirebaseException {
        JsonObject raw = client.getObject("healthCheckers");
        Map<String, HealthCheckerInfo> checkers = new LinkedHashMap<>();
        long now = clock.millis();
        for (Map.Entry<String, JsonElement> entry : new TreeMap<>(raw.asMap()).entrySet()) {
            if (!entry.getValue().isJsonObject()) {
                continue;
            }
            JsonObject json = entry.getValue().getAsJsonObject();
            Long lastSeen = Json.longOrNull(json, "lastSeenAt");
            Long secondsAgo = lastSeen == null ? null : Math.max(0, (now - lastSeen) / 1000);
            boolean online = secondsAgo != null && secondsAgo <= checkerOnlineSeconds;
            checkers.put(entry.getKey(), new HealthCheckerInfo(
                    entry.getKey(),
                    Json.str(json, "city"),
                    Json.str(json, "country"),
                    Json.doubleOrNull(json, "latitude"),
                    Json.doubleOrNull(json, "longitude"),
                    lastSeen,
                    lastSeen == null ? null : Instant.ofEpochMilli(lastSeen).toString(),
                    secondsAgo,
                    online));
        }
        return checkers;
    }

    /** Lectura segura de campos JSON opcionales. */
    static final class Json {
        private Json() {
        }

        static String str(JsonObject json, String key) {
            return json.has(key) && json.get(key).isJsonPrimitive() ? json.get(key).getAsString() : null;
        }

        static Long longOrNull(JsonObject json, String key) {
            try {
                return json.has(key) && json.get(key).isJsonPrimitive() ? json.get(key).getAsLong() : null;
            } catch (NumberFormatException e) {
                return null;
            }
        }

        static Integer intOrNull(JsonObject json, String key) {
            try {
                return json.has(key) && json.get(key).isJsonPrimitive() ? json.get(key).getAsInt() : null;
            } catch (NumberFormatException e) {
                return null;
            }
        }

        static Double doubleOrNull(JsonObject json, String key) {
            try {
                return json.has(key) && json.get(key).isJsonPrimitive() ? json.get(key).getAsDouble() : null;
            } catch (NumberFormatException e) {
                return null;
            }
        }

        static boolean bool(JsonObject json, String key, boolean defaultValue) {
            return json.has(key) && json.get(key).isJsonPrimitive() ? json.get(key).getAsBoolean() : defaultValue;
        }

        static JsonObject obj(JsonObject json, String key) {
            return json.has(key) && json.get(key).isJsonObject() ? json.getAsJsonObject(key) : new JsonObject();
        }
    }
}
