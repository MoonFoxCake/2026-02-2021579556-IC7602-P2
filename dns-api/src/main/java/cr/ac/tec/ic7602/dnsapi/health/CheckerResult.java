package cr.ac.tec.ic7602.dnsapi.health;

/** Resultado que un Health Checker escribió en /healthResults/{recordId}/{targetId}/{checkerId}. */
public record CheckerResult(
        String checkerId,
        boolean healthy,
        Integer attempts,
        Integer successes,
        Double latencyMs,
        Long checkedAt,
        String checkedAtIso,
        boolean stale
) {
}
