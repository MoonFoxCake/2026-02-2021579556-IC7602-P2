package cr.ac.tec.ic7602.dnsapi.firebase;

import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Map;
import java.util.StringJoiner;

/**
 * Cliente mínimo de lectura para la API REST de Firebase Realtime Database.
 *
 * Usa Bearer para OAuth de cuentas de servicio o auth={token} para Firebase ID tokens.
 * y devuelve el JSON parseado. Firebase responde "null" cuando la ruta no existe.
 */
public class FirebaseRestClient {

    private final HttpClient http;
    private final FirebaseAuth auth;
    private final String dbUrl;
    private final String namespace;

    public FirebaseRestClient(HttpClient http, FirebaseAuth auth, String dbUrl, String namespace) {
        this.http = http;
        this.auth = auth;
        this.dbUrl = dbUrl.replaceAll("/+$", "");
        this.namespace = namespace == null ? "" : namespace;
    }

    /**
     * GET de una ruta. Los valores de {@code params} se envían tal cual (URL-encoded);
     * los parámetros de consulta de Firebase que son strings deben ir con comillas,
     * por ejemplo orderBy="\"hostname\"".
     */
    public JsonElement get(String path, Map<String, String> params) throws FirebaseAuth.FirebaseException {
        StringJoiner query = new StringJoiner("&");
        for (Map.Entry<String, String> param : params.entrySet()) {
            query.add(enc(param.getKey()) + "=" + enc(param.getValue()));
        }
        String token = auth.getToken();
        if (!auth.isServiceAccount()) query.add("auth=" + enc(token));
        if (!namespace.isBlank()) {
            query.add("ns=" + enc(namespace));
        }

        String cleanPath = path.replaceAll("^/+", "");
        URI uri = URI.create(dbUrl + "/" + cleanPath + ".json" + (query.length() == 0 ? "" : "?" + query));
        HttpRequest.Builder builder = HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(5));
        if (auth.isServiceAccount()) builder.header("Authorization", "Bearer " + token);
        HttpRequest request = builder.GET().build();
        try {
            HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() != 200) {
                throw new FirebaseAuth.FirebaseException(
                        "Realtime Database HTTP " + response.statusCode() + " en /" + cleanPath + ": " + response.body());
            }
            JsonElement parsed = JsonParser.parseString(response.body());
            return parsed == null ? JsonNull.INSTANCE : parsed;
        } catch (FirebaseAuth.FirebaseException e) {
            throw e;
        } catch (Exception e) {
            throw new FirebaseAuth.FirebaseException("Error consultando Realtime Database en /" + cleanPath, e);
        }
    }

    public JsonElement get(String path) throws FirebaseAuth.FirebaseException {
        return get(path, Map.of());
    }

    /** Igual que get(), pero devuelve un objeto vacío si la ruta no existe o no es un objeto. */
    public JsonObject getObject(String path, Map<String, String> params) throws FirebaseAuth.FirebaseException {
        JsonElement element = get(path, params);
        return element.isJsonObject() ? element.getAsJsonObject() : new JsonObject();
    }

    public JsonObject getObject(String path) throws FirebaseAuth.FirebaseException {
        return getObject(path, Map.of());
    }

    /** Codifica un segmento de ruta (por ejemplo un recordId) para usarlo dentro de la URL. */
    public static String segment(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8).replace("+", "%20");
    }

    private static String enc(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }
}
