package cr.ac.tec.ic7602.dnsapi.config;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Configuración de la aplicación, leída desde variables de entorno y/o archivo .env.
 *
 * Ver .env.example para las variables esperadas.
 */
public record Config(
        int port,
        String remoteDnsServer,
        int remoteDnsPort,
        int udpTimeoutMs,
        String dbProvider,
        String dbUrl,
        String dbApiKey,
        String firebaseAuthUrl,
        String firebaseNamespace,
        String firebaseEmail,
        String firebasePassword,
        String googleApplicationCredentials,
        int defaultRecordTtl,
        int healthResultMaxAgeSeconds,
        boolean unknownHealthIsHealthy,
        int checkerOnlineSeconds,
        String corsAllowedOrigin
) {

    private static final Map<String, String> DOT_ENV = loadDotEnv();

    public static Config fromEnv() {
        return new Config(
                intEnv("DNS_API_PORT", 8080),
                strEnv("REMOTE_DNS_SERVER", "8.8.8.8"),
                intEnv("REMOTE_DNS_PORT", 53),
                intEnv("UDP_TIMEOUT_MS", 2000),
                strEnv("DB_PROVIDER", "firebase"),
                strEnv("DB_URL", ""),
                strEnv("DB_API_KEY", ""),
                strEnv("FIREBASE_AUTH_URL", ""),          // vacío = producción
                strEnv("FIREBASE_DATABASE_NAMESPACE", ""), // solo emulador
                strEnv("FIREBASE_EMAIL", ""),
                strEnv("FIREBASE_PASSWORD", ""),
                strEnv("GOOGLE_APPLICATION_CREDENTIALS", ""),
                intEnv("DEFAULT_RECORD_TTL", 60),              // TTL (s) si el registro no define "ttl"
                intEnv("HEALTH_RESULT_MAX_AGE_SECONDS", 0),    // 0 = no descartar resultados viejos
                boolEnv("HEALTH_UNKNOWN_AS_HEALTHY", true),    // target sin resultados todavía
                intEnv("CHECKER_ONLINE_SECONDS", 120),         // checker "online" si reportó hace menos de esto
                strEnv("CORS_ALLOWED_ORIGIN", "*")             // origen permitido para la DNS UI
        );
    }

    private static String strEnv(String key, String defaultValue) {
        String value = System.getenv(key);
        if (value == null || value.isBlank()) {
            value = DOT_ENV.get(key);
        }
        return (value == null || value.isBlank()) ? defaultValue : value.trim();
    }

    private static boolean boolEnv(String key, boolean defaultValue) {
        String value = strEnv(key, "");
        if (value.isBlank()) {
            return defaultValue;
        }
        return value.equalsIgnoreCase("true") || value.equals("1") || value.equalsIgnoreCase("yes");
    }

    private static int intEnv(String key, int defaultValue) {
        String value = System.getenv(key);
        if (value == null || value.isBlank()) {
            value = DOT_ENV.get(key);
        }
        if (value == null || value.isBlank()) {
            return defaultValue;
        }
        try {
            return Integer.parseInt(value.trim());
        } catch (NumberFormatException e) {
            System.err.printf("Valor invalido para %s: '%s', usando default %d%n", key, value, defaultValue);
            return defaultValue;
        }
    }

    private static Map<String, String> loadDotEnv() {
        Map<String, String> map = new HashMap<>();

        List<Path> algunaRuta = List.of(
                Path.of(".env"),
                Path.of("DNS API", ".env"),
                Path.of("..", ".env"),
                Path.of("src", "main", "java", "cr", "ac", "tec", "ic7602", "dnsapi", ".env"),
                Path.of("DNS API", "src", "main", "java", "cr", "ac", "tec", "ic7602", "dnsapi", ".env")
        );

        for (Path path : algunaRuta) {
            if (Files.isRegularFile(path)) {
                try {
                    parseEnvLines(Files.readAllLines(path, StandardCharsets.UTF_8), map);
                    System.out.printf("Variables de entorno cargadas desde archivo .env: %s%n", path.toAbsolutePath().normalize());
                    return map;
                } catch (IOException e) {
                    System.err.printf("No se pudo leer el archivo .env en %s: %s%n", path, e.getMessage());
                }
            }
        }

        // Intento de lectura desde classpath como recurso
        try (InputStream is = Config.class.getResourceAsStream("/.env")) {
            if (is != null) {
                try (BufferedReader reader = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8))) {
                    parseEnvLines(reader.lines().toList(), map);
                    System.out.println("Variables de entorno cargadas desde /.env en classpath");
                    return map;
                }
            }
        } catch (Exception ignored) {
        }

        return map;
    }

    private static void parseEnvLines(List<String> lines, Map<String, String> targetMap) {
        for (String rawLine : lines) {
            String line = rawLine.trim();
            if (line.isEmpty() || line.startsWith("#")) {
                continue;
            }
            int eqIdx = line.indexOf('=');
            if (eqIdx <= 0) {
                continue;
            }
            String key = line.substring(0, eqIdx).trim();
            String val = line.substring(eqIdx + 1).trim();

            if ((val.startsWith("\"") && val.endsWith("\"") && val.length() >= 2) ||
                (val.startsWith("'") && val.endsWith("'") && val.length() >= 2)) {
                val = val.substring(1, val.length() - 1);
            }
            targetMap.putIfAbsent(key, val);
        }
    }
}
