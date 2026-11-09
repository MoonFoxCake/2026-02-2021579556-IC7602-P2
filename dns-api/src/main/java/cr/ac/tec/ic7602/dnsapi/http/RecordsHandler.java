package cr.ac.tec.ic7602.dnsapi.http;

import cr.ac.tec.ic7602.dnsapi.firebase.FirebaseAuth;
import cr.ac.tec.ic7602.dnsapi.model.ResolveResponse;
import cr.ac.tec.ic7602.dnsapi.service.RecordService;
import io.javalin.http.Context;
import io.javalin.http.Handler;

import java.util.Map;

/**
 * GET /api/records/{hostname}?sourceIp=1.2.3.4
 *
 * Endpoint del DNS Interceptor (diseño B). Devuelve el tipo de registro y todos sus
 * targets con su estado de salud; el Interceptor aplica la estrategia y elige la IP.
 * sourceIp es necesario para los tipos "geo" y "round-trip".
 *
 * 200: registro encontrado (ver ResolveResponse)
 * 404: {"found": false, "hostname": "..."} -> el Interceptor reenvía vía /api/dns_resolver
 * 502: Firebase no respondió o rechazó la lectura
 */
public class RecordsHandler implements Handler {

    private final RecordService recordService;

    public RecordsHandler(RecordService recordService) {
        this.recordService = recordService;
    }

    @Override
    public void handle(Context ctx) {
        String hostname = ctx.pathParam("hostname");
        String sourceIp = ctx.queryParam("sourceIp");
        try {
            ResolveResponse response = recordService.resolve(hostname, sourceIp);
            Json.send(ctx, response.found() ? 200 : 404, response);
        } catch (FirebaseAuth.FirebaseException e) {
            Json.send(ctx, 502, Map.of("error", "Error consultando Firebase: " + e.getMessage()));
        }
    }
}
