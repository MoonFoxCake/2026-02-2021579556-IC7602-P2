package cr.ac.tec.ic7602.dnsapi.service;

import cr.ac.tec.ic7602.dnsapi.firebase.FirebaseDnsExistsChecker;
import cr.ac.tec.ic7602.dnsapi.firebase.FirebaseRestClient;
import cr.ac.tec.ic7602.dnsapi.health.HealthEvaluator;
import cr.ac.tec.ic7602.dnsapi.model.ui.UiModels.UiCheckerList;
import cr.ac.tec.ic7602.dnsapi.model.ui.UiModels.UiRecord;
import cr.ac.tec.ic7602.dnsapi.model.ui.UiModels.UiRecordList;
import cr.ac.tec.ic7602.dnsapi.model.ui.UiModels.UiSummary;
import cr.ac.tec.ic7602.dnsapi.model.ui.UiModels.UiTarget;
import cr.ac.tec.ic7602.dnsapi.testutil.FakeFirebase;
import cr.ac.tec.ic7602.dnsapi.testutil.TestData;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;

import static org.junit.jupiter.api.Assertions.*;

/** Vistas que el API entrega a la DNS UI. */
class UiServiceTest {

    private FakeFirebase firebase;
    private UiService service;

    @BeforeEach
    void setUp() throws Exception {
        firebase = new FakeFirebase().data(TestData.DB);
        FirebaseRestClient client = firebase.client();
        Clock clock = Clock.fixed(Instant.ofEpochMilli(TestData.NOW), ZoneOffset.UTC);
        DnsDataRepository repo = new DnsDataRepository(client, new FirebaseDnsExistsChecker(client), clock, 120);
        service = new UiService(repo, new HealthEvaluator(0, true, clock), 60, clock);
    }

    @AfterEach
    void tearDown() {
        firebase.close();
    }

    private static UiRecord byId(UiRecordList list, String id) {
        return list.records().stream().filter(r -> r.id().equals(id)).findFirst().orElseThrow();
    }

    @Test
    void listaTodosLosRegistrosConSuEstado() throws Exception {
        UiRecordList list = service.listRecords();
        assertEquals(7, list.count(), "incluye también los deshabilitados");
        assertEquals("disabled", byId(list, "rec-off").status());
        assertEquals("down", byId(list, "rec-down").status());
        assertEquals("degraded", byId(list, "rec-multi").status());
        assertEquals("healthy", byId(list, "rec-rtt").status());
        assertEquals("unknown", byId(list, "rec-single").status());
        assertEquals("round-trip", byId(list, "rec-rtt").type());
    }

    @Test
    void detalleIncluyeResultadosPorCheckerYHealthCheck() throws Exception {
        UiRecord record = service.getRecord("rec-down").orElseThrow();
        UiTarget target = record.targets().get(0);
        assertEquals(2, target.checkerResults().size());
        assertEquals(1, target.healthyVotes());
        assertEquals(2, target.totalVotes());
        assertEquals("tcp", target.healthCheck().get("protocol").getAsString());
        assertNotNull(target.checkerResults().get(0).checkedAtIso());

        assertTrue(service.getRecord("no-existe").isEmpty());
    }

    @Test
    void healthCheckersConEstadoOnline() throws Exception {
        UiCheckerList checkers = service.listHealthCheckers();
        assertEquals(2, checkers.count());
        assertEquals(1, checkers.online(), "Miami reportó hace 900 s (> 120 s)");
    }

    @Test
    void resumenParaDashboard() throws Exception {
        UiSummary summary = service.summary();
        assertEquals(7, summary.totalRecords());
        assertEquals(6, summary.enabledRecords());
        assertEquals(3, summary.recordsByType().get("single"));
        assertEquals(1, summary.recordsByType().get("round-trip"));
        assertEquals(2, summary.healthCheckersTotal());
        assertEquals(1, summary.healthCheckersOnline());
        assertEquals(1, summary.recordsByStatus().get("disabled"));
    }
}
