package cr.ac.tec.ic7602.dnsapi.health;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;

import static org.junit.jupiter.api.Assertions.*;

class HealthEvaluatorTest {

    private static final Clock CLOCK = Clock.fixed(Instant.ofEpochMilli(100_000), ZoneOffset.UTC);

    private static JsonObject results(String json) {
        return JsonParser.parseString(json).getAsJsonObject();
    }

    @Test
    void mayoriaSimpleEntreCheckers() {
        HealthEvaluator evaluator = new HealthEvaluator(0, true, CLOCK);
        TargetHealth h = evaluator.evaluate(results("""
                {"a": {"healthy": true}, "b": {"healthy": true}, "c": {"healthy": false}}"""));
        assertEquals("healthy", h.status());
        assertEquals(2, h.healthyVotes());
        assertEquals(3, h.totalVotes());
    }

    @Test
    void empateEsUnhealthy() {
        HealthEvaluator evaluator = new HealthEvaluator(0, true, CLOCK);
        TargetHealth h = evaluator.evaluate(results("""
                {"a": {"healthy": true}, "b": {"healthy": false}}"""));
        assertEquals("unhealthy", h.status());
        assertFalse(h.healthy());
    }

    @Test
    void sinResultadosDependeDeLaConfiguracion() {
        assertTrue(new HealthEvaluator(0, true, CLOCK).evaluate(null).healthy());
        assertFalse(new HealthEvaluator(0, false, CLOCK).evaluate(new JsonObject()).healthy());
        assertEquals("unknown", new HealthEvaluator(0, false, CLOCK).evaluate(null).status());
    }

    @Test
    void resultadosViejosNoVotan() {
        HealthEvaluator evaluator = new HealthEvaluator(60, true, CLOCK);   // máximo 60 s
        TargetHealth h = evaluator.evaluate(results("""
                {"viejo": {"healthy": false, "checkedAt": 1000},
                 "nuevo": {"healthy": true,  "checkedAt": 90000}}"""));
        assertEquals("healthy", h.status());
        assertEquals(1, h.totalVotes());
        assertTrue(h.results().stream().anyMatch(r -> r.checkerId().equals("viejo") && r.stale()));
    }
}
