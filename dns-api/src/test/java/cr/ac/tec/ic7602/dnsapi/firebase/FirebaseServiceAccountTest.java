package cr.ac.tec.ic7602.dnsapi.firebase;

import com.google.gson.JsonObject;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.net.InetSocketAddress;
import java.net.http.HttpClient;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyPairGenerator;
import java.util.Base64;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;

class FirebaseServiceAccountTest {
    @TempDir Path directory;

    @Test
    void serviceAccountReadsDatabaseAndReusesToken() throws Exception {
        var server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        String base = "http://127.0.0.1:" + server.getAddress().getPort();
        var exchanges = new AtomicInteger();
        server.createContext("/token", ex -> {
            exchanges.incrementAndGet();
            ex.getRequestBody().readAllBytes();
            byte[] body = "{\"access_token\":\"service-token\",\"expires_in\":3600,\"token_type\":\"Bearer\"}".getBytes();
            ex.getResponseHeaders().set("Content-Type", "application/json");
            ex.sendResponseHeaders(200, body.length);
            ex.getResponseBody().write(body);
            ex.close();
        });
        server.createContext("/dnsRecords.json", ex -> {
            boolean authorized = "Bearer service-token".equals(ex.getRequestHeaders().getFirst("Authorization"))
                    && ex.getRequestURI().getRawQuery() == null;
            byte[] body = "{\"record\":{\"hostname\":\"multi.test\"}}".getBytes();
            ex.sendResponseHeaders(authorized ? 200 : 401, body.length);
            ex.getResponseBody().write(body);
            ex.close();
        });
        server.start();
        try {
            var generator = KeyPairGenerator.getInstance("RSA");
            generator.initialize(2048);
            String pem = "-----BEGIN PRIVATE KEY-----\n"
                    + Base64.getEncoder().encodeToString(generator.generateKeyPair().getPrivate().getEncoded())
                    + "\n-----END PRIVATE KEY-----\n";
            var key = new JsonObject();
            key.addProperty("type", "service_account");
            key.addProperty("project_id", "test-project");
            key.addProperty("client_id", "123");
            key.addProperty("client_email", "test@test-project.iam.gserviceaccount.com");
            key.addProperty("private_key_id", "test-key");
            key.addProperty("private_key", pem);
            key.addProperty("token_uri", base + "/token");
            Path file = directory.resolve("account.json");
            Files.writeString(file, key.toString());
            var auth = new FirebaseAuth(file);
            var client = new FirebaseRestClient(HttpClient.newHttpClient(), auth, base, "");
            for (int i = 0; i < 2; i++) {
                assertEquals("multi.test", client.getObject("dnsRecords")
                        .getAsJsonObject("record").get("hostname").getAsString());
            }
            assertEquals(1, exchanges.get(), "OAuth token should be cached");
        } finally {
            server.stop(0);
        }
    }

    @Test
    void rejectsMissingCredentialFile() {
        assertThrows(java.io.IOException.class, () -> new FirebaseAuth(directory.resolve("missing.json")));
    }
}
