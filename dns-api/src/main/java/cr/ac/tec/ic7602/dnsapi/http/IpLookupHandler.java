package cr.ac.tec.ic7602.dnsapi.http;

import cr.ac.tec.ic7602.dnsapi.firebase.FirebaseAuth;
import cr.ac.tec.ic7602.dnsapi.geo.IpToCountryService;
import cr.ac.tec.ic7602.dnsapi.geo.Ipv4;
import io.javalin.http.Context;
import io.javalin.http.Handler;

import java.util.Map;

/**
 * GET /api/ip-to-country/lookup?ip=8.8.8.8
 *
 * Devuelve el país (y ciudad/coordenadas si existen) de una IPv4 según la base
 * IP-to-Country de Firebase. Útil para depurar registros geo y para la UI.
 */
public class IpLookupHandler implements Handler {

    private final IpToCountryService service;

    public IpLookupHandler(IpToCountryService service) {
        this.service = service;
    }

    @Override
    public void handle(Context ctx) {
        String ip = ctx.queryParam("ip");
        if (ip == null || Ipv4.toLong(ip) < 0) {
            Json.send(ctx, 400, Map.of("error", "Parámetro 'ip' requerido (IPv4 válida)"));
            return;
        }
        try {
            Json.send(ctx, 200, service.lookup(ip));
        } catch (FirebaseAuth.FirebaseException e) {
            Json.send(ctx, 502, Map.of("error", "Error consultando Firebase: " + e.getMessage()));
        }
    }
}
