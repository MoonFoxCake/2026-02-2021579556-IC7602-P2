package cr.ac.tec.ic7602.dnsapi;

import cr.ac.tec.ic7602.dnsapi.config.Config;
import cr.ac.tec.ic7602.dnsapi.dns.UdpDnsClient;
import cr.ac.tec.ic7602.dnsapi.firebase.FirebaseAuth;
import cr.ac.tec.ic7602.dnsapi.firebase.FirebaseDnsExistsChecker;
import cr.ac.tec.ic7602.dnsapi.firebase.FirebaseRestClient;
import cr.ac.tec.ic7602.dnsapi.geo.IpToCountryService;
import cr.ac.tec.ic7602.dnsapi.health.HealthEvaluator;
import cr.ac.tec.ic7602.dnsapi.http.Cors;
import cr.ac.tec.ic7602.dnsapi.http.DnsResolverHandler;
import cr.ac.tec.ic7602.dnsapi.http.ExistsHandler;
import cr.ac.tec.ic7602.dnsapi.http.HealthHandler;
import cr.ac.tec.ic7602.dnsapi.http.IpLookupHandler;
import cr.ac.tec.ic7602.dnsapi.http.RecordsHandler;
import cr.ac.tec.ic7602.dnsapi.http.UiHandlers;
import cr.ac.tec.ic7602.dnsapi.service.DnsDataRepository;
import cr.ac.tec.ic7602.dnsapi.service.RecordService;
import cr.ac.tec.ic7602.dnsapi.service.UiService;
import io.javalin.Javalin;

import java.net.http.HttpClient;
import java.time.Clock;
import java.time.Duration;

/**
 * Punto de entrada del DNS API.
 *
 * Toda la configuración viene de variables de entorno (ver env.example).
 * Javalin corre sobre Jetty, que atiende cada petición en su propio hilo del
 * pool, por lo que el API soporta múltiples peticiones concurrentes.
 */
public class App {

    public static void main(String[] args) throws java.io.IOException {
        Config config = Config.fromEnv();

        if (!"firebase".equalsIgnoreCase(config.dbProvider())) {
            System.err.println("DB_PROVIDER='" + config.dbProvider() + "' no soportado. Use DB_PROVIDER=firebase");
            System.exit(1);
        }
        if (config.dbUrl().isBlank() || (config.googleApplicationCredentials().isBlank()
                && (config.firebaseEmail().isBlank() || config.firebasePassword().isBlank()))) {
            System.err.println("Faltan variables: DB_URL y GOOGLE_APPLICATION_CREDENTIALS o FIREBASE_EMAIL/FIREBASE_PASSWORD");
            System.exit(1);
        }

        HttpClient http = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(5))
                .build();
        Clock clock = Clock.systemUTC();

        // --- Firebase ---
        FirebaseAuth auth = config.googleApplicationCredentials().isBlank()
                ? new FirebaseAuth(http, config.firebaseAuthUrl(),
                        config.dbApiKey(), config.firebaseEmail(), config.firebasePassword())
                : new FirebaseAuth(java.nio.file.Path.of(config.googleApplicationCredentials()));
        FirebaseRestClient firebase = new FirebaseRestClient(http, auth,
                config.dbUrl(), config.firebaseNamespace());
        FirebaseDnsExistsChecker checker = new FirebaseDnsExistsChecker(firebase);

        // --- Servicios ---
        DnsDataRepository repository = new DnsDataRepository(firebase, checker, clock,
                config.checkerOnlineSeconds());
        IpToCountryService ipToCountry = new IpToCountryService(firebase);
        HealthEvaluator healthEvaluator = new HealthEvaluator(config.healthResultMaxAgeSeconds(),
                config.unknownHealthIsHealthy(), clock);
        RecordService recordService = new RecordService(repository, ipToCountry, healthEvaluator,
                config.defaultRecordTtl());
        UiService uiService = new UiService(repository, healthEvaluator, config.defaultRecordTtl(), clock);
        UiHandlers ui = new UiHandlers(uiService, ipToCountry);

        UdpDnsClient udpDnsClient = new UdpDnsClient(
                config.remoteDnsServer(), config.remoteDnsPort(), config.udpTimeoutMs());

        // --- Rutas ---
        Javalin app = Javalin.create();
        Cors.enable(app, config.corsAllowedOrigin());

        app.get("/health", new HealthHandler());

        // DNS Interceptor
        app.post("/api/exists", new ExistsHandler(checker));
        app.get("/api/records/{hostname}", new RecordsHandler(recordService));
        app.post("/api/dns_resolver", new DnsResolverHandler(udpDnsClient));

        // Compartido
        app.get("/api/ip-to-country/lookup", new IpLookupHandler(ipToCountry));

        // DNS UI (solo lectura)
        app.get("/api/ui/summary", ui.summary());
        app.get("/api/ui/records", ui.records());
        app.get("/api/ui/records/{recordId}", ui.recordById());
        app.get("/api/ui/health-checkers", ui.healthCheckers());
        app.get("/api/ui/ip-to-country", ui.ipToCountry());
        app.get("/api/ui/record-types", ui.recordTypes());

        app.start(config.port());

        System.out.printf("DNS API escuchando en el puerto %d (DNS remoto %s:%d, DB_URL: %s, AUTH_URL: %s)%n",
                config.port(), config.remoteDnsServer(), config.remoteDnsPort(),
                config.dbUrl(), config.firebaseAuthUrl());
    }
}
