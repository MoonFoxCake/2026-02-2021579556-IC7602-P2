package cr.ac.tec.ic7602;

import java.net.URI;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentSkipListMap;
import java.util.concurrent.atomic.AtomicLong;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class ItemController {
    private final AtomicLong nextId = new AtomicLong(1);
    private final ConcurrentSkipListMap<Long, Map<String, Object>> items = new ConcurrentSkipListMap<>();

    @GetMapping("/api/health")
    public Map<String, Object> health() {
        return Map.of("ok", true, "service", "rest-api-java");
    }

    @GetMapping("/api/items.json")
    public List<Map<String, Object>> list() {
        return items.entrySet().stream().map(entry -> withId(entry.getKey(), entry.getValue())).toList();
    }

    @GetMapping("/api/items/{id}.json")
    public ResponseEntity<Map<String, Object>> get(@PathVariable long id) {
        Map<String, Object> item = items.get(id);
        return item == null ? ResponseEntity.notFound().build() : ResponseEntity.ok(withId(id, item));
    }

    @PostMapping("/api/items.json")
    public ResponseEntity<Map<String, Object>> create(@RequestBody Map<String, Object> body) {
        long id = nextId.getAndIncrement();
        Map<String, Object> item = fields(body);
        items.put(id, item);
        return ResponseEntity.created(URI.create("/api/items/" + id + ".json")).body(withId(id, item));
    }

    @PutMapping("/api/items/{id}.json")
    public ResponseEntity<Map<String, Object>> replace(@PathVariable long id,
                                                        @RequestBody Map<String, Object> body) {
        Map<String, Object> item = fields(body);
        return items.computeIfPresent(id, (key, old) -> item) == null
                ? ResponseEntity.notFound().build()
                : ResponseEntity.ok(withId(id, item));
    }

    @DeleteMapping("/api/items/{id}.json")
    public ResponseEntity<Void> delete(@PathVariable long id) {
        return items.remove(id) == null ? ResponseEntity.notFound().build() : ResponseEntity.noContent().build();
    }

    private Map<String, Object> fields(Map<String, Object> body) {
        Map<String, Object> copy = new LinkedHashMap<>(body);
        copy.remove("id");
        return copy;
    }

    private Map<String, Object> withId(long id, Map<String, Object> fields) {
        Map<String, Object> result = new LinkedHashMap<>(fields);
        result.put("id", id);
        return result;
    }
}
