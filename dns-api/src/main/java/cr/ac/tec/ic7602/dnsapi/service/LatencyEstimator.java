package cr.ac.tec.ic7602.dnsapi.service;

import cr.ac.tec.ic7602.dnsapi.geo.GeoDistance;
import cr.ac.tec.ic7602.dnsapi.health.CheckerResult;
import cr.ac.tec.ic7602.dnsapi.model.ClientLocation;
import cr.ac.tec.ic7602.dnsapi.model.HealthCheckerInfo;

import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * Estima la latencia cliente -> target para registros round-trip.
 *
 * Se usa la latencia medida por el Health Checker más cercano al cliente, en este orden:
 *   1. "nearest-checker": cliente con coordenadas -> checker más cercano (Haversine)
 *   2. "same-city":       mismos país y ciudad -> promedio de esos checkers
 *   3. "same-country":    mismo país -> promedio de esos checkers
 *   4. "average":         sin ubicación útil -> promedio de todos los checkers
 */
public final class LatencyEstimator {

    public static final String NEAREST = "nearest-checker";
    public static final String SAME_CITY = "same-city";
    public static final String SAME_COUNTRY = "same-country";
    public static final String AVERAGE = "average";

    private LatencyEstimator() {
    }

    public record Estimate(Double latencyMs, String source, String checkerId, Double distanceKm) {
        static final Estimate NONE = new Estimate(null, null, null, null);
    }

    public static Estimate estimate(List<CheckerResult> freshResults,
                                    Map<String, HealthCheckerInfo> checkers,
                                    ClientLocation client) {
        List<CheckerResult> measured = freshResults.stream()
                .filter(r -> r.latencyMs() != null)
                .toList();
        if (measured.isEmpty()) {
            return Estimate.NONE;
        }

        if (client != null && client.found()) {
            if (client.hasCoordinates()) {
                CheckerResult best = null;
                double bestKm = Double.MAX_VALUE;
                for (CheckerResult result : measured) {
                    HealthCheckerInfo checker = checkers.get(result.checkerId());
                    if (checker == null || !checker.hasCoordinates()) {
                        continue;
                    }
                    double km = GeoDistance.km(client.latitude(), client.longitude(),
                            checker.latitude(), checker.longitude());
                    if (km < bestKm) {
                        bestKm = km;
                        best = result;
                    }
                }
                if (best != null) {
                    return new Estimate(best.latencyMs(), NEAREST, best.checkerId(), round(bestKm));
                }
            }

            if (client.countryCode() != null) {
                List<CheckerResult> sameCountry = measured.stream()
                        .filter(r -> checkers.containsKey(r.checkerId())
                                && client.countryCode().equalsIgnoreCase(checkers.get(r.checkerId()).country()))
                        .toList();
                if (client.city() != null) {
                    List<CheckerResult> sameCity = sameCountry.stream()
                            .filter(r -> client.city().equalsIgnoreCase(
                                    Objects.toString(checkers.get(r.checkerId()).city(), "")))
                            .toList();
                    if (!sameCity.isEmpty()) {
                        return averageOf(sameCity, SAME_CITY);
                    }
                }
                if (!sameCountry.isEmpty()) {
                    return averageOf(sameCountry, SAME_COUNTRY);
                }
            }
        }
        return averageOf(measured, AVERAGE);
    }

    private static Estimate averageOf(List<CheckerResult> results, String source) {
        double avg = results.stream().mapToDouble(CheckerResult::latencyMs).average().orElse(0);
        String checkerId = results.size() == 1 ? results.get(0).checkerId() : null;
        return new Estimate(round(avg), source, checkerId, null);
    }

    private static double round(double value) {
        return Math.round(value * 100.0) / 100.0;
    }
}
