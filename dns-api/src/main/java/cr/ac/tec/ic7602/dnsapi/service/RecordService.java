package cr.ac.tec.ic7602.dnsapi.service;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import cr.ac.tec.ic7602.dnsapi.firebase.FirebaseAuth;
import cr.ac.tec.ic7602.dnsapi.geo.IpToCountryService;
import cr.ac.tec.ic7602.dnsapi.health.HealthEvaluator;
import cr.ac.tec.ic7602.dnsapi.health.TargetHealth;
import cr.ac.tec.ic7602.dnsapi.model.ClientLocation;
import cr.ac.tec.ic7602.dnsapi.model.HealthCheckerInfo;
import cr.ac.tec.ic7602.dnsapi.model.RecordTypes;
import cr.ac.tec.ic7602.dnsapi.model.ResolveResponse;
import cr.ac.tec.ic7602.dnsapi.model.TargetInfo;
import cr.ac.tec.ic7602.dnsapi.service.DnsDataRepository.Json;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.TreeMap;

/**
 * Arma la información que el DNS Interceptor necesita para decidir qué IP devolver
 * (diseño B). El API no elige la IP: informa el tipo, los targets, su salud y,
 * según el tipo, la ubicación del cliente (geo) o la latencia estimada (round-trip).
 */
public class RecordService {

    private final DnsDataRepository repository;
    private final IpToCountryService ipToCountry;
    private final HealthEvaluator healthEvaluator;
    private final int defaultTtl;

    public RecordService(DnsDataRepository repository, IpToCountryService ipToCountry,
                         HealthEvaluator healthEvaluator, int defaultTtl) {
        this.repository = repository;
        this.ipToCountry = ipToCountry;
        this.healthEvaluator = healthEvaluator;
        this.defaultTtl = defaultTtl;
    }

    /**
     * @param hostname nombre consultado (se normaliza: minúsculas, sin punto final)
     * @param sourceIp IP de origen de la consulta DNS; necesaria para geo y round-trip (puede ser null)
     */
    public ResolveResponse resolve(String hostname, String sourceIp) throws FirebaseAuth.FirebaseException {
        Optional<Map.Entry<String, JsonObject>> match = repository.findEnabledByHostname(hostname);
        if (match.isEmpty()) {
            return ResolveResponse.notFound(hostname);
        }
        String recordId = match.get().getKey();
        JsonObject record = match.get().getValue();
        String type = RecordTypes.normalize(Json.str(record, "type"));

        ClientLocation client = null;
        if (RecordTypes.needsClientLocation(type) && sourceIp != null && !sourceIp.isBlank()) {
            client = lookupClient(sourceIp);
        }

        Map<String, HealthCheckerInfo> checkers = RecordTypes.ROUND_TRIP.equals(type)
                ? repository.getHealthCheckers()
                : Map.of();
        JsonObject healthResults = repository.getHealthResults(recordId);

        List<TargetInfo> targets = new ArrayList<>();
        JsonObject rawTargets = Json.obj(record, "targets");
        for (Map.Entry<String, JsonElement> entry : new TreeMap<>(rawTargets.asMap()).entrySet()) {
            if (!entry.getValue().isJsonObject()) {
                continue;
            }
            JsonObject target = entry.getValue().getAsJsonObject();
            String address = Json.str(target, "address");
            if (address == null || address.isBlank()) {
                continue;
            }
            TargetHealth health = healthEvaluator.evaluate(Json.obj(healthResults, entry.getKey()));

            Integer weight = null;
            if (RecordTypes.WEIGHT.equals(type)) {
                Integer w = Json.intOrNull(target, "weight");
                weight = (w == null || w < 1) ? 1 : w;
            }
            String country = Json.str(target, "country");

            LatencyEstimator.Estimate latency = RecordTypes.ROUND_TRIP.equals(type)
                    ? LatencyEstimator.estimate(health.freshResults(), checkers, client)
                    : LatencyEstimator.Estimate.NONE;

            targets.add(new TargetInfo(
                    entry.getKey(), address.trim(), Json.intOrNull(target, "port"),
                    health.healthy(), health.status(),
                    weight, country == null ? null : country.toUpperCase(Locale.ROOT),
                    latency.latencyMs(), latency.source(), latency.checkerId(), latency.distanceKm()));
        }

        Integer ttl = Json.intOrNull(record, "ttl");
        int healthyCount = (int) targets.stream().filter(TargetInfo::healthy).count();
        return new ResolveResponse(true, Json.str(record, "hostname"), recordId, type,
                ttl == null || ttl < 0 ? defaultTtl : ttl, client, healthyCount, targets);
    }

    /** Si la base IP-to-Country falla, se sigue sin ubicación en vez de romper la resolución. */
    private ClientLocation lookupClient(String sourceIp) {
        try {
            return ipToCountry.lookup(sourceIp);
        } catch (FirebaseAuth.FirebaseException e) {
            System.err.println("No se pudo consultar IP-to-Country para " + sourceIp + ": " + e.getMessage());
            return ClientLocation.notFound(sourceIp);
        }
    }
}
