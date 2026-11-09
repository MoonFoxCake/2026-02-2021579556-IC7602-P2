package cr.ac.tec.ic7602.dnsapi.http;

import cr.ac.tec.ic7602.dnsapi.firebase.FirebaseAuth;
import cr.ac.tec.ic7602.dnsapi.geo.IpToCountryService;
import cr.ac.tec.ic7602.dnsapi.model.RecordTypes;
import cr.ac.tec.ic7602.dnsapi.service.UiService;
import io.javalin.http.Context;
import io.javalin.http.Handler;

import java.util.Map;

/**
 * Endpoints de solo lectura para la DNS UI (prefijo /api/ui).
 *
 *   GET /api/ui/summary                  resumen para dashboard
 *   GET /api/ui/records                  todos los registros con targets y salud
 *   GET /api/ui/records/{recordId}       un registro con el detalle por Health Checker
 *   GET /api/ui/health-checkers          checkers con ubicación y si están online
 *   GET /api/ui/ip-to-country?limit=&cursor=   rangos IP-to-Country paginados
 *   GET /api/ui/record-types             tipos de registro y campos requeridos
 */
public class UiHandlers {

    private static final int DEFAULT_PAGE = 50;
    private static final int MAX_PAGE = 500;

    private final UiService uiService;
    private final IpToCountryService ipToCountry;

    public UiHandlers(UiService uiService, IpToCountryService ipToCountry) {
        this.uiService = uiService;
        this.ipToCountry = ipToCountry;
    }

    public Handler summary() {
        return ctx -> firebase(ctx, () -> Json.send(ctx, 200, uiService.summary()));
    }

    public Handler records() {
        return ctx -> firebase(ctx, () -> Json.send(ctx, 200, uiService.listRecords()));
    }

    public Handler recordById() {
        return ctx -> firebase(ctx, () -> {
            String recordId = ctx.pathParam("recordId");
            uiService.getRecord(recordId).ifPresentOrElse(
                    record -> Json.send(ctx, 200, record),
                    () -> Json.send(ctx, 404, Map.of("error", "No existe el registro " + recordId)));
        });
    }

    public Handler healthCheckers() {
        return ctx -> firebase(ctx, () -> Json.send(ctx, 200, uiService.listHealthCheckers()));
    }

    public Handler ipToCountry() {
        return ctx -> firebase(ctx, () -> {
            int limit = parseLimit(ctx.queryParam("limit"));
            Json.send(ctx, 200, ipToCountry.list(limit, ctx.queryParam("cursor")));
        });
    }

    public Handler recordTypes() {
        return ctx -> Json.send(ctx, 200, Map.of(
                "recordTypes", RecordTypes.describe(),
                "healthCheckProtocols", Map.of(
                        "tcp", java.util.List.of("timeoutMs", "retries", "intervalSeconds"),
                        "http", java.util.List.of("path", "timeoutMs", "retries", "intervalSeconds",
                                "expectedStatusCodes", "basicAuthSecretRef (opcional)"))));
    }

    private static int parseLimit(String raw) {
        if (raw == null || raw.isBlank()) {
            return DEFAULT_PAGE;
        }
        try {
            return Math.max(1, Math.min(MAX_PAGE, Integer.parseInt(raw.trim())));
        } catch (NumberFormatException e) {
            return DEFAULT_PAGE;
        }
    }

    @FunctionalInterface
    private interface FirebaseAction {
        void run() throws FirebaseAuth.FirebaseException;
    }

    private static void firebase(Context ctx, FirebaseAction action) {
        try {
            action.run();
        } catch (FirebaseAuth.FirebaseException e) {
            Json.send(ctx, 502, Map.of("error", "Error consultando Firebase: " + e.getMessage()));
        }
    }
}
