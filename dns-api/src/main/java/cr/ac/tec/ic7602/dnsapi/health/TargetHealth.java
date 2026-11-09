package cr.ac.tec.ic7602.dnsapi.health;

import java.util.List;

/**
 * Estado agregado de un target.
 *
 * @param status       "healthy", "unhealthy" o "unknown" (sin resultados vigentes)
 * @param healthy      decisión final para usar el target (unknown cuenta según HEALTH_UNKNOWN_AS_HEALTHY)
 * @param healthyVotes checkers vigentes que lo reportan healthy
 * @param totalVotes   checkers vigentes que lo evaluaron
 * @param results      todos los resultados, incluidos los viejos (stale=true)
 */
public record TargetHealth(
        String status,
        boolean healthy,
        int healthyVotes,
        int totalVotes,
        List<CheckerResult> results
) {
    public List<CheckerResult> freshResults() {
        return results.stream().filter(r -> !r.stale()).toList();
    }
}
