package cr.ac.tec.ic7602.dnsapi.model.ui;

import com.google.gson.JsonObject;
import cr.ac.tec.ic7602.dnsapi.health.CheckerResult;
import cr.ac.tec.ic7602.dnsapi.model.HealthCheckerInfo;

import java.util.List;
import java.util.Map;

/** Vistas de solo lectura que el API entrega a la DNS UI. */
public final class UiModels {

    private UiModels() {
    }

    /** Conteo de targets por estado de salud. */
    public record HealthCounts(int healthy, int unhealthy, int unknown) {
    }

    /**
     * Un target tal como lo muestra la UI.
     * healthCheck es el objeto guardado en Firebase (protocol, timeoutMs, retries, intervalSeconds,
     * path, expectedStatusCodes, basicAuthSecretRef...), sin transformar.
     */
    public record UiTarget(
            String id,
            String address,
            Integer port,
            Integer weight,
            String country,
            JsonObject healthCheck,
            String healthStatus,
            boolean healthy,
            int healthyVotes,
            int totalVotes,
            List<CheckerResult> checkerResults
    ) {
    }

    /**
     * Un registro DNS para la UI.
     * status: "disabled", "healthy" (todos bien), "degraded" (algunos caídos),
     * "down" (ninguno bien) o "unknown" (sin resultados todavía).
     */
    public record UiRecord(
            String id,
            String hostname,
            String type,
            boolean enabled,
            int ttl,
            String status,
            HealthCounts health,
            List<UiTarget> targets
    ) {
    }

    public record UiRecordList(int count, List<UiRecord> records) {
    }

    public record UiCheckerList(int count, int online, List<HealthCheckerInfo> healthCheckers) {
    }

    /** Resumen para un dashboard. */
    public record UiSummary(
            int totalRecords,
            int enabledRecords,
            Map<String, Integer> recordsByType,
            Map<String, Integer> recordsByStatus,
            HealthCounts targets,
            int healthCheckersTotal,
            int healthCheckersOnline,
            String generatedAt
    ) {
    }
}
