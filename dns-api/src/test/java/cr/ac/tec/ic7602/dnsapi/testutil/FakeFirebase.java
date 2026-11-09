package cr.ac.tec.ic7602.dnsapi.testutil;

import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import cr.ac.tec.ic7602.dnsapi.firebase.FirebaseAuth;
import cr.ac.tec.ic7602.dnsapi.firebase.FirebaseRestClient;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.net.http.HttpClient;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Servidor HTTP en memoria que imita lo mínimo de Firebase para las pruebas:
 * login de Auth y lecturas REST de Realtime Database con orderBy, equalTo,
 * startAt, endAt, limitToFirst y limitToLast. Solo se usa en tests.
 */
public class FakeFirebase implements AutoCloseable {

    private final HttpServer server;
    private JsonObject root = new JsonObject();

    public FakeFirebase() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword",
                ex -> reply(ex, 200, "{\"idToken\":\"token-falso\",\"expiresIn\":\"3600\"}"));
        server.createContext("/", this::handleDatabase);
        server.start();
    }

    /** Carga el contenido completo de la base de datos (JSON). */
    public FakeFirebase data(String json) {
        root = JsonParser.parseString(json).getAsJsonObject();
        return this;
    }

    public String baseUrl() {
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    public FirebaseRestClient client() {
        HttpClient http = HttpClient.newHttpClient();
        FirebaseAuth auth = new FirebaseAuth(http, baseUrl(), "fake-api-key", "api@test.com", "secreto");
        return new FirebaseRestClient(http, auth, baseUrl(), "");
    }

    @Override
    public void close() {
        server.stop(0);
    }

    private void handleDatabase(HttpExchange ex) throws IOException {
        String path = ex.getRequestURI().getRawPath();
        if (!path.endsWith(".json")) {
            reply(ex, 404, "{\"error\":\"not found\"}");
            return;
        }
        Map<String, String> query = parseQuery(ex.getRequestURI().getRawQuery());
        if (!"token-falso".equals(query.get("auth"))) {
            reply(ex, 401, "{\"error\":\"Permission denied\"}");
            return;
        }

        JsonElement node = root;
        String clean = path.substring(1, path.length() - ".json".length());
        if (!clean.isEmpty()) {
            for (String raw : clean.split("/")) {
                String key = URLDecoder.decode(raw, StandardCharsets.UTF_8);
                node = node != null && node.isJsonObject() ? node.getAsJsonObject().get(key) : null;
            }
        }
        if (node == null) {
            reply(ex, 200, "null");
            return;
        }
        if (query.containsKey("orderBy") && node.isJsonObject()) {
            node = applyQuery(node.getAsJsonObject(), query);
        }
        reply(ex, 200, node.toString());
    }

    private static JsonObject applyQuery(JsonObject node, Map<String, String> q) {
        String orderBy = JsonParser.parseString(q.get("orderBy")).getAsString();
        List<Map.Entry<String, JsonElement>> entries = new ArrayList<>();
        for (Map.Entry<String, JsonElement> e : node.entrySet()) {
            JsonElement value = sortValue(orderBy, e);
            if (value == null && !"$key".equals(orderBy)) {
                if (q.containsKey("equalTo") || q.containsKey("startAt") || q.containsKey("endAt")) {
                    continue;
                }
            }
            if (q.containsKey("equalTo") && compare(value, JsonParser.parseString(q.get("equalTo"))) != 0) {
                continue;
            }
            if (q.containsKey("startAt") && compare(value, JsonParser.parseString(q.get("startAt"))) < 0) {
                continue;
            }
            if (q.containsKey("endAt") && compare(value, JsonParser.parseString(q.get("endAt"))) > 0) {
                continue;
            }
            entries.add(e);
        }
        entries.sort(Comparator.comparing((Map.Entry<String, JsonElement> e) -> sortValue(orderBy, e),
                FakeFirebase::compare));
        if (q.containsKey("limitToFirst")) {
            int n = Integer.parseInt(q.get("limitToFirst"));
            entries = new ArrayList<>(entries.subList(0, Math.min(n, entries.size())));
        }
        if (q.containsKey("limitToLast")) {
            int n = Integer.parseInt(q.get("limitToLast"));
            entries = new ArrayList<>(entries.subList(Math.max(0, entries.size() - n), entries.size()));
        }
        JsonObject out = new JsonObject();
        entries.forEach(e -> out.add(e.getKey(), e.getValue()));
        return out;
    }

    private static JsonElement sortValue(String orderBy, Map.Entry<String, JsonElement> e) {
        if ("$key".equals(orderBy)) {
            return new JsonPrimitive(e.getKey());
        }
        return e.getValue().isJsonObject() ? e.getValue().getAsJsonObject().get(orderBy) : null;
    }

    private static int compare(JsonElement a, JsonElement b) {
        if (a == null || a instanceof JsonNull) {
            return b == null || b instanceof JsonNull ? 0 : -1;
        }
        if (b == null || b instanceof JsonNull) {
            return 1;
        }
        JsonPrimitive pa = a.getAsJsonPrimitive();
        JsonPrimitive pb = b.getAsJsonPrimitive();
        if (pa.isNumber() && pb.isNumber()) {
            return Double.compare(pa.getAsDouble(), pb.getAsDouble());
        }
        if (pa.isNumber() != pb.isNumber()) {
            return pa.isNumber() ? -1 : 1;
        }
        return pa.getAsString().compareTo(pb.getAsString());
    }

    private static Map<String, String> parseQuery(String raw) {
        Map<String, String> map = new HashMap<>();
        if (raw == null) {
            return map;
        }
        for (String pair : raw.split("&")) {
            int i = pair.indexOf('=');
            if (i > 0) {
                map.put(URLDecoder.decode(pair.substring(0, i), StandardCharsets.UTF_8),
                        URLDecoder.decode(pair.substring(i + 1), StandardCharsets.UTF_8));
            }
        }
        return map;
    }

    private static void reply(HttpExchange ex, int status, String body) throws IOException {
        ex.getRequestBody().readAllBytes();
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().add("Content-Type", "application/json");
        ex.sendResponseHeaders(status, bytes.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(bytes);
        }
    }
}
