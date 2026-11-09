package cr.ac.tec.ic7602.dnsapi.http;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import io.javalin.http.Context;

/**
 * Respuestas JSON con Gson.
 *
 * Se usa ctx.result(...) en lugar de ctx.json(...) porque ctx.json() de Javalin
 * necesita Jackson en el classpath, y el proyecto usa Gson.
 */
final class Json {

    static final Gson GSON = new GsonBuilder().disableHtmlEscaping().create();

    private Json() {
    }

    static void send(Context ctx, int status, Object body) {
        ctx.status(status)
           .contentType("application/json; charset=utf-8")
           .result(GSON.toJson(body));
    }
}
