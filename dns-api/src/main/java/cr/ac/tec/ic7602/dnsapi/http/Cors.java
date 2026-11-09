package cr.ac.tec.ic7602.dnsapi.http;

import io.javalin.Javalin;

/**
 * Habilita CORS para que la DNS UI (React, servida desde otro puerto u origen)
 * pueda llamar al API desde el navegador. El origen se configura con CORS_ALLOWED_ORIGIN.
 */
public final class Cors {

    private Cors() {
    }

    public static void enable(Javalin app, String allowedOrigin) {
        app.before(ctx -> {
            ctx.header("Access-Control-Allow-Origin", allowedOrigin);
            ctx.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
            ctx.header("Access-Control-Allow-Headers", "Content-Type");
            if (!"*".equals(allowedOrigin)) {
                ctx.header("Vary", "Origin");
            }
        });
        // Respuesta a los preflight del navegador
        app.options("/*", ctx -> ctx.status(204));
    }
}
