package cr.ac.tec.ic7602.dnsapi.service;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import cr.ac.tec.ic7602.dnsapi.firebase.FirebaseAuth;
import cr.ac.tec.ic7602.dnsapi.health.HealthEvaluator;
import cr.ac.tec.ic7602.dnsapi.health.TargetHealth;
import cr.ac.tec.ic7602.dnsapi.model.HealthCheckerInfo;
import cr.ac.tec.ic7602.dnsapi.model.RecordTypes;
import cr.ac.tec.ic7602.dnsapi.model.ui.UiModels.HealthCounts;
import cr.ac.tec.ic7602.dnsapi.model.ui.UiModels.UiCheckerList;
import cr.ac.tec.ic7602.dnsapi.model.ui.UiModels.UiRecord;
import cr.ac.tec.ic7602.dnsapi.model.ui.UiModels.UiRecordList;
import cr.ac.tec.ic7602.dnsapi.model.ui.UiModels.UiSummary;
import cr.ac.tec.ic7602.dnsapi.model.ui.UiModels.UiTarget;
import cr.ac.tec.ic7602.dnsapi.service.DnsDataRepository.Json;

import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.TreeMap;

/**
 * Información ya combinada para la DNS UI: registros con sus targets, el estado
 * de salud agregado y el detalle por Health Checker, más un resumen para dashboard.
 * Es de solo lectura; la UI escribe directamente en Firebase según la arquitectura.
 */
public class UiService {

    private final DnsDataRepository repository;
    private final HealthEvaluator healthEvaluator;
    private final int defaultTtl;
    private final Clock clock;

    public UiService(DnsDataRepository repository, HealthEvaluator healthEvaluator, int defaultTtl, Clock clock) {
        this.repository = repository;
        this.healthEvaluator = healthEvaluator;
        this.defaultTtl = defaultTtl;
        this.clock = clock;
    }

    public UiRecordList listRecords() throws FirebaseAuth.FirebaseException {
        JsonObject records = repository.getAllRecords();
        JsonObject allHealth = repository.getAllHealthResults();
        List<UiRecord> list = new ArrayList<>();
        for (Map.Entry<String, JsonElement> entry : new TreeMap<>(records.asMap()).entrySet()) {
            if (entry.getValue().isJsonObject()) {
                list.add(toUiRecord(entry.getKey(), entry.getValue().getAsJsonObject(),
                        Json.obj(allHealth, entry.getKey())));
            }
        }
        return new UiRecordList(list.size(), list);
    }

    public Optional<UiRecord> getRecord(String recordId) throws FirebaseAuth.FirebaseException {
        Optional<JsonObject> record = repository.getRecord(recordId);
        if (record.isEmpty()) {
            return Optional.empty();
        }
        return Optional.of(toUiRecord(recordId, record.get(), repository.getHealthResults(recordId)));
    }

    public UiCheckerList listHealthCheckers() throws FirebaseAuth.FirebaseException {
        List<HealthCheckerInfo> checkers = new ArrayList<>(repository.getHealthCheckers().values());
        int online = (int) checkers.stream().filter(HealthCheckerInfo::online).count();
        return new UiCheckerList(checkers.size(), online, checkers);
    }

    public UiSummary summary() throws FirebaseAuth.FirebaseException {
        UiRecordList records = listRecords();
        Map<String, Integer> byType = new LinkedHashMap<>();
        for (String type : RecordTypes.ALL) {
            byType.put(type, 0);
        }
        Map<String, Integer> byStatus = new LinkedHashMap<>();
        int enabled = 0;
        int healthy = 0;
        int unhealthy = 0;
        int unknown = 0;
        for (UiRecord record : records.records()) {
            String type = record.type() == null ? "sin-tipo" : record.type();
            byType.merge(type, 1, Integer::sum);
            byStatus.merge(record.status(), 1, Integer::sum);
            if (record.enabled()) {
                enabled++;
            }
            healthy += record.health().healthy();
            unhealthy += record.health().unhealthy();
            unknown += record.health().unknown();
        }
        UiCheckerList checkers = listHealthCheckers();
        return new UiSummary(records.count(), enabled, byType, byStatus,
                new HealthCounts(healthy, unhealthy, unknown),
                checkers.count(), checkers.online(), Instant.ofEpochMilli(clock.millis()).toString());
    }

    private UiRecord toUiRecord(String id, JsonObject record, JsonObject healthResults) {
        String type = RecordTypes.normalize(Json.str(record, "type"));
        boolean enabled = Json.bool(record, "enabled", true);
        List<UiTarget> targets = new ArrayList<>();
        int healthy = 0;
        int unhealthy = 0;
        int unknown = 0;

        JsonObject rawTargets = Json.obj(record, "targets");
        for (Map.Entry<String, JsonElement> entry : new TreeMap<>(rawTargets.asMap()).entrySet()) {
            if (!entry.getValue().isJsonObject()) {
                continue;
            }
            JsonObject target = entry.getValue().getAsJsonObject();
            TargetHealth health = healthEvaluator.evaluate(Json.obj(healthResults, entry.getKey()));
            switch (health.status()) {
                case HealthEvaluator.HEALTHY -> healthy++;
                case HealthEvaluator.UNHEALTHY -> unhealthy++;
                default -> unknown++;
            }
            String country = Json.str(target, "country");
            targets.add(new UiTarget(
                    entry.getKey(),
                    Json.str(target, "address"),
                    Json.intOrNull(target, "port"),
                    Json.intOrNull(target, "weight"),
                    country == null ? null : country.toUpperCase(Locale.ROOT),
                    Json.obj(target, "healthCheck"),
                    health.status(), health.healthy(),
                    health.healthyVotes(), health.totalVotes(),
                    health.results()));
        }

        String status;
        if (!enabled) {
            status = "disabled";
        } else if (targets.isEmpty() || unknown == targets.size()) {
            status = "unknown";
        } else if (unhealthy == 0) {
            status = "healthy";
        } else if (healthy == 0 && unknown == 0) {
            status = "down";
        } else {
            status = "degraded";
        }

        Integer ttl = Json.intOrNull(record, "ttl");
        return new UiRecord(id, Json.str(record, "hostname"), type, enabled,
                ttl == null || ttl < 0 ? defaultTtl : ttl, status,
                new HealthCounts(healthy, unhealthy, unknown), targets);
    }
}
