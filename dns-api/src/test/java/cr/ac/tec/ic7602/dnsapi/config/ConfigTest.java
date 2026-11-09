package cr.ac.tec.ic7602.dnsapi.config;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class ConfigTest {

    @Test
    void testConfigLoadsValues() {
        Config config = Config.fromEnv();
        assertNotNull(config);
        assertTrue(config.port() > 0);
        assertNotNull(config.remoteDnsServer());
        // La configuración puede cargarse sin credenciales; App las valida al iniciar.
        assertNotNull(config.dbUrl());
        assertNotNull(config.googleApplicationCredentials());
    }
}
