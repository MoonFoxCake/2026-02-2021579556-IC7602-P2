package cr.ac.tec.ic7602.dnsapi.geo;

import cr.ac.tec.ic7602.dnsapi.model.ClientLocation;
import cr.ac.tec.ic7602.dnsapi.testutil.FakeFirebase;
import cr.ac.tec.ic7602.dnsapi.testutil.TestData;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class IpToCountryServiceTest {

    private FakeFirebase firebase;
    private IpToCountryService service;

    @BeforeEach
    void setUp() throws Exception {
        firebase = new FakeFirebase().data(TestData.DB);
        service = new IpToCountryService(firebase.client());
    }

    @AfterEach
    void tearDown() {
        firebase.close();
    }

    @Test
    void conversionIpv4() {
        assertEquals(16909060L, Ipv4.toLong("1.2.3.4"));
        assertEquals(4294967295L, Ipv4.toLong("255.255.255.255"));
        assertEquals("1.2.3.4", Ipv4.fromLong(16909060L));
        assertEquals(-1, Ipv4.toLong("256.1.1.1"));
        assertEquals(-1, Ipv4.toLong("1.2.3"));
        assertEquals(-1, Ipv4.toLong("::1"));
        assertEquals(-1, Ipv4.toLong(null));
    }

    @Test
    void encuentraElRangoCorrecto() throws Exception {
        ClientLocation loc = service.lookup("8.8.8.8");
        assertTrue(loc.found());
        assertEquals("US", loc.countryCode());
        assertEquals("r-google", loc.rangeId());
        assertEquals(25.7617, loc.latitude());
    }

    @Test
    void ipEntreRangosNoSeEncuentra() throws Exception {
        assertFalse(service.lookup("100.0.0.1").found());   // mayor que r-google.ipTo, menor que loopback
        assertFalse(service.lookup("0.0.0.1").found());     // antes del primer rango
        assertFalse(service.lookup("no-es-ip").found());
    }

    @Test
    void paginacionParaLaUi() throws Exception {
        IpToCountryService.Page first = service.list(2, null);
        assertEquals(2, first.items().size());
        assertNotNull(first.nextCursor());

        IpToCountryService.Page second = service.list(2, first.nextCursor());
        assertEquals(1, second.items().size());
        assertNull(second.nextCursor());
        assertNotEquals(first.items().get(1).id(), second.items().get(0).id());
    }
}
