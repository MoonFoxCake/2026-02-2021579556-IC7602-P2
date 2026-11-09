package cr.ac.tec.ic7602.dnsapi.testutil;

/**
 * Base de datos de prueba con un registro de cada tipo, dos Health Checkers
 * (Cartago y Miami), resultados de salud y una base IP-to-Country pequeña.
 * Los tiempos (checkedAt, lastSeenAt) usan 1_000_000 ms como "ahora".
 */
public final class TestData {

    public static final long NOW = 1_000_000L;

    private TestData() {
    }

    public static final String DB = """
            {
              "dnsRecords": {
                "rec-single": {"hostname": "single.test", "type": "single", "enabled": true, "ttl": 30,
                  "targets": {"t1": {"address": "10.0.0.1", "port": 80}}},
                "rec-multi": {"hostname": "multi.test", "type": "multi", "enabled": true,
                  "targets": {"t1": {"address": "10.0.1.1"}, "t2": {"address": "10.0.1.2"}, "t3": {"address": "10.0.1.3"}}},
                "rec-weight": {"hostname": "weight.test", "type": "weight", "enabled": true,
                  "targets": {"t1": {"address": "10.0.2.1", "weight": 3}, "t2": {"address": "10.0.2.2"}}},
                "rec-geo": {"hostname": "geo.test", "type": "geo", "enabled": true,
                  "targets": {"cr": {"address": "10.0.3.1", "country": "cr"}, "us": {"address": "10.0.3.2", "country": "US"}}},
                "rec-rtt": {"hostname": "rtt.test", "type": "round-trip", "enabled": true,
                  "targets": {"t1": {"address": "10.0.4.1"}, "t2": {"address": "10.0.4.2"}}},
                "rec-down": {"hostname": "down.test", "type": "single", "enabled": true,
                  "targets": {"t1": {"address": "10.0.5.1",
                    "healthCheck": {"protocol": "tcp", "timeoutMs": 2000, "retries": 2, "intervalSeconds": 30}}}},
                "rec-off": {"hostname": "off.test", "type": "single", "enabled": false,
                  "targets": {"t1": {"address": "10.0.6.1"}}}
              },
              "healthCheckers": {
                "checker-cartago": {"city": "Cartago", "country": "CR", "latitude": 9.8644, "longitude": -83.9194, "lastSeenAt": 990000},
                "checker-miami": {"city": "Miami", "country": "US", "latitude": 25.7617, "longitude": -80.1918, "lastSeenAt": 100000}
              },
              "healthResults": {
                "rec-multi": {
                  "t3": {"checker-cartago": {"healthy": false, "attempts": 3, "successes": 0, "latencyMs": 2000, "checkedAt": 990000},
                         "checker-miami":   {"healthy": false, "attempts": 3, "successes": 1, "latencyMs": 1500, "checkedAt": 990000}}
                },
                "rec-rtt": {
                  "t1": {"checker-cartago": {"healthy": true, "attempts": 3, "successes": 3, "latencyMs": 15, "checkedAt": 990000},
                         "checker-miami":   {"healthy": true, "attempts": 3, "successes": 3, "latencyMs": 120, "checkedAt": 990000}},
                  "t2": {"checker-cartago": {"healthy": true, "attempts": 3, "successes": 3, "latencyMs": 80, "checkedAt": 990000},
                         "checker-miami":   {"healthy": true, "attempts": 3, "successes": 3, "latencyMs": 10, "checkedAt": 990000}}
                },
                "rec-down": {
                  "t1": {"checker-cartago": {"healthy": false, "attempts": 3, "successes": 0, "latencyMs": 2000, "checkedAt": 990000},
                         "checker-miami":   {"healthy": true, "attempts": 3, "successes": 2, "latencyMs": 40, "checkedAt": 990000}}
                }
              },
              "ipToCountry": {
                "r-loopback": {"ipFrom": 2130706432, "ipTo": 2147483647, "countryCode": "CR", "countryName": "Costa Rica",
                               "city": "San José", "latitude": 9.9281, "longitude": -84.0907},
                "r-google":   {"ipFrom": 134744064, "ipTo": 134744319, "countryCode": "US", "countryName": "United States",
                               "city": "Miami", "latitude": 25.7617, "longitude": -80.1918},
                "r-onlycountry": {"ipFrom": 16777216, "ipTo": 16777471, "countryCode": "CR", "countryName": "Costa Rica"}
              }
            }
            """;
}
