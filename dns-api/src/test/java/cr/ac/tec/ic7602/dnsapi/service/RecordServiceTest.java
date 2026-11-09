package cr.ac.tec.ic7602.dnsapi.service;

import com.google.gson.Gson;
import cr.ac.tec.ic7602.dnsapi.firebase.FirebaseDnsExistsChecker;
import cr.ac.tec.ic7602.dnsapi.firebase.FirebaseRestClient;
import cr.ac.tec.ic7602.dnsapi.geo.IpToCountryService;
import cr.ac.tec.ic7602.dnsapi.health.HealthEvaluator;
import cr.ac.tec.ic7602.dnsapi.model.ResolveResponse;
import cr.ac.tec.ic7602.dnsapi.model.TargetInfo;
import cr.ac.tec.ic7602.dnsapi.testutil.FakeFirebase;
import cr.ac.tec.ic7602.dnsapi.testutil.TestData;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;

import static org.junit.jupiter.api.Assertions.*;

/** Respuesta de GET /api/records/{hostname} para cada tipo de registro (diseño B). */
class RecordServiceTest {

    private FakeFirebase firebase;
    private RecordService service;

    @BeforeEach
    void setUp() throws Exception {
        firebase = new FakeFirebase().data(TestData.DB);
        FirebaseRestClient client = firebase.client();
        Clock clock = Clock.fixed(Instant.ofEpochMilli(TestData.NOW), ZoneOffset.UTC);
        DnsDataRepository repo = new DnsDataRepository(client, new FirebaseDnsExistsChecker(client), clock, 120);
        service = new RecordService(repo, new IpToCountryService(client),
                new HealthEvaluator(0, true, clock), 60);
    }

    @AfterEach
    void tearDown() {
        firebase.close();
    }

    private static TargetInfo target(ResolveResponse r, String id) {
        return r.targets().stream().filter(t -> t.id().equals(id)).findFirst().orElseThrow();
    }

    @Test
    void single() throws Exception {
        ResolveResponse r = service.resolve("single.test", "127.0.0.1");
        assertTrue(r.found());
        assertEquals("rec-single", r.recordId());
        assertEquals("single", r.type());
        assertEquals(30, r.ttl());
        assertNull(r.client(), "single no necesita ubicación del cliente");
        assertEquals(1, r.targets().size());
        TargetInfo t = r.targets().get(0);
        assertEquals("10.0.0.1", t.address());
        assertEquals(80, t.port());
        assertEquals("unknown", t.healthStatus());
        assertTrue(t.healthy(), "sin resultados todavía cuenta como healthy (config por defecto)");
    }

    @Test
    void noExisteODeshabilitado() throws Exception {
        assertFalse(service.resolve("nope.test", null).found());
        assertFalse(service.resolve("off.test", null).found());
    }

    @Test
    void normalizaElHostname() throws Exception {
        assertTrue(service.resolve("MULTI.Test.", null).found());
    }

    @Test
    void multiMarcaElTargetCaido() throws Exception {
        ResolveResponse r = service.resolve("multi.test", null);
        assertEquals("multi", r.type());
        assertEquals(60, r.ttl(), "TTL por defecto");
        assertEquals(3, r.targets().size());
        assertEquals(2, r.healthyTargetCount());
        assertFalse(target(r, "t3").healthy());
        assertEquals("unhealthy", target(r, "t3").healthStatus());
    }

    @Test
    void weightIncluyePesos() throws Exception {
        ResolveResponse r = service.resolve("weight.test", null);
        assertEquals(3, target(r, "t1").weight());
        assertEquals(1, target(r, "t2").weight(), "sin peso definido -> 1");
    }

    @Test
    void geoIncluyePaisDelClienteYDeLosTargets() throws Exception {
        ResolveResponse cr = service.resolve("geo.test", "127.0.0.1");
        assertTrue(cr.client().found());
        assertEquals("CR", cr.client().countryCode());
        assertEquals("San José", cr.client().city());
        assertEquals("CR", target(cr, "cr").country(), "el país del target se normaliza a mayúsculas");
        assertEquals("US", target(cr, "us").country());

        assertEquals("US", service.resolve("geo.test", "8.8.8.8").client().countryCode());
        assertFalse(service.resolve("geo.test", "200.1.1.1").client().found(), "IP fuera de los rangos");
        assertNull(service.resolve("geo.test", null).client(), "sin sourceIp no hay ubicación");
    }

    @Test
    void roundTripUsaElCheckerMasCercano() throws Exception {
        ResolveResponse fromCr = service.resolve("rtt.test", "127.0.0.1");
        assertEquals(15.0, target(fromCr, "t1").latencyMs());
        assertEquals(80.0, target(fromCr, "t2").latencyMs());
        assertEquals("checker-cartago", target(fromCr, "t1").latencyCheckerId());
        assertEquals("nearest-checker", target(fromCr, "t1").latencySource());
        assertTrue(target(fromCr, "t1").latencyDistanceKm() < 50);

        ResolveResponse fromUs = service.resolve("rtt.test", "8.8.8.8");
        assertEquals(120.0, target(fromUs, "t1").latencyMs());
        assertEquals(10.0, target(fromUs, "t2").latencyMs());
        assertEquals("checker-miami", target(fromUs, "t2").latencyCheckerId());
    }

    @Test
    void roundTripSinCoordenadasUsaElPais() throws Exception {
        ResolveResponse r = service.resolve("rtt.test", "1.0.0.1");   // rango solo con país CR
        assertEquals("same-country", target(r, "t1").latencySource());
        assertEquals(15.0, target(r, "t1").latencyMs());
    }

    @Test
    void roundTripSinUbicacionUsaElPromedio() throws Exception {
        ResolveResponse r = service.resolve("rtt.test", "200.1.1.1");
        assertEquals("average", target(r, "t1").latencySource());
        assertEquals(67.5, target(r, "t1").latencyMs());
    }

    @Test
    void empateEntreCheckersEsUnhealthy() throws Exception {
        ResolveResponse r = service.resolve("down.test", null);
        assertEquals(0, r.healthyTargetCount());
        assertEquals("unhealthy", r.targets().get(0).healthStatus());
    }

    @Test
    void jsonOmiteCamposQueNoAplican() throws Exception {
        String json = new Gson().toJson(service.resolve("multi.test", null));
        assertTrue(json.contains("\"type\":\"multi\""), json);
        assertTrue(json.contains("\"healthyTargetCount\":2"), json);
        assertFalse(json.contains("latencyMs"), "multi no lleva latencias: " + json);
        assertFalse(json.contains("\"client\""), json);

        String notFound = new Gson().toJson(service.resolve("nope.test", null));
        assertEquals("{\"found\":false,\"hostname\":\"nope.test\"}", notFound);
    }
}
