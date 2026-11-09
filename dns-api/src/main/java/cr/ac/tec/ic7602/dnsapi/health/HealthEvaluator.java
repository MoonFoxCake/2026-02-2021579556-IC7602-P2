package cr.ac.tec.ic7602.dnsapi.health;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * Decide si un target está healthy por mayoría simple entre los Health Checkers.
 *
 * Cada checker escribe {healthy, attempts, successes, latencyMs, checkedAt} en
 * /healthResults/{recordId}/{targetId}/{checkerId}; su "healthy" ya es la mayoría
 * de sus propios intentos. Aquí se hace la mayoría entre checkers:
 * healthy si votos_healthy > total_votos / 2 (un empate cuenta como unhealthy).
 */
public class HealthEvaluator {

    public static final String HEALTHY = "healthy";
    public static final String UNHEALTHY = "unhealthy";
    public static final String UNKNOWN = "unknown";

    private final int maxAgeSeconds;
    private final boolean unknownAsHealthy;
    private final Clock clock;

    /**
     * @param maxAgeSeconds    resultados más viejos que esto no votan (0 = sin límite)
     * @param unknownAsHealthy qué hacer con un target sin resultados vigentes
     */
    public HealthEvaluator(int maxAgeSeconds, boolean unknownAsHealthy, Clock clock) {
        this.maxAgeSeconds = maxAgeSeconds;
        this.unknownAsHealthy = unknownAsHealthy;
        this.clock = clock;
    }

    /** @param resultsByChecker el objeto /healthResults/{recordId}/{targetId} (puede ser null). */
    public TargetHealth evaluate(JsonObject resultsByChecker) {
        List<CheckerResult> results = new ArrayList<>();
        int healthyVotes = 0;
        int totalVotes = 0;

        if (resultsByChecker != null) {
            long now = clock.millis();
            for (Map.Entry<String, JsonElement> entry : new TreeMap<>(resultsByChecker.asMap()).entrySet()) {
                if (!entry.getValue().isJsonObject()) {
                    continue;
                }
                JsonObject json = entry.getValue().getAsJsonObject();
                if (!json.has("healthy") || !json.get("healthy").isJsonPrimitive()) {
                    continue;
                }
                boolean healthy = json.get("healthy").getAsBoolean();
                Long checkedAt = longOrNull(json, "checkedAt");
                boolean stale = maxAgeSeconds > 0
                        && (checkedAt == null || now - checkedAt > maxAgeSeconds * 1000L);

                results.add(new CheckerResult(
                        entry.getKey(), healthy,
                        intOrNull(json, "attempts"), intOrNull(json, "successes"),
                        doubleOrNull(json, "latencyMs"),
                        checkedAt, checkedAt == null ? null : Instant.ofEpochMilli(checkedAt).toString(),
                        stale));

                if (!stale) {
                    totalVotes++;
                    if (healthy) {
                        healthyVotes++;
                    }
                }
            }
        }

        if (totalVotes == 0) {
            return new TargetHealth(UNKNOWN, unknownAsHealthy, 0, 0, results);
        }
        boolean healthy = healthyVotes > totalVotes / 2.0;
        return new TargetHealth(healthy ? HEALTHY : UNHEALTHY, healthy, healthyVotes, totalVotes, results);
    }

    private static Long longOrNull(JsonObject json, String key) {
        try {
            return json.has(key) && json.get(key).isJsonPrimitive() ? json.get(key).getAsLong() : null;
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private static Integer intOrNull(JsonObject json, String key) {
        try {
            return json.has(key) && json.get(key).isJsonPrimitive() ? json.get(key).getAsInt() : null;
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
}
