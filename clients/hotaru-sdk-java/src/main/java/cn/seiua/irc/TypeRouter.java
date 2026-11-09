package cn.seiua.irc;

import cn.seiua.json.Json;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Consumer;

/**
 * Routes incoming business messages to handlers by type.
 *
 * <p>Patterns are the same three shapes the server's filter engine accepts, so a
 * mod can subscribe exactly the way an operator writes rules:
 *
 * <pre>{@code
 * router.on("chat.message", handler);   // exact
 * router.on("hotaru.*", handler);    // one namespace
 * router.on("*", auditHandler);         // everything
 * }</pre>
 *
 * <p>Dispatch order is most-specific first: exact type, then the longest matching
 * namespace, then {@code *}. Every handler runs inside the configured executor, so
 * a Minecraft mod can hand the SDK its client thread and touch game state safely.
 */
public final class TypeRouter {

    private final Map<String, List<Consumer<IncomingMessage>>> handlers = new ConcurrentHashMap<>();

    public TypeRouter on(String pattern, Consumer<IncomingMessage> handler) {
        validatePattern(pattern);
        Objects.requireNonNull(handler, "handler");
        handlers.computeIfAbsent(pattern, key -> new CopyOnWriteArrayList<>()).add(handler);
        return this;
    }

    public void dispatch(IncomingMessage message) {
        for (Consumer<IncomingMessage> handler : handlersFor(message.type())) {
            handler.accept(message);
        }
    }

    /** Handlers that match, ordered exact → longest namespace → {@code *}. */
    public List<Consumer<IncomingMessage>> handlersFor(String type) {
        List<Consumer<IncomingMessage>> result = new ArrayList<>();
        addAll(result, type);

        List<String> namespaces = new ArrayList<>();
        for (String pattern : handlers.keySet()) {
            if (pattern.endsWith(".*") && matchesNamespace(type, pattern)) namespaces.add(pattern);
        }
        namespaces.sort((left, right) -> Integer.compare(right.length(), left.length()));
        for (String pattern : namespaces) addAll(result, pattern);

        addAll(result, "*");
        return result;
    }

    public int patternCount() {
        return handlers.size();
    }

    public int handlerCount() {
        return handlers.values().stream().mapToInt(List::size).sum();
    }

    private void addAll(List<Consumer<IncomingMessage>> target, String pattern) {
        List<Consumer<IncomingMessage>> found = handlers.get(pattern);
        if (found != null) target.addAll(found);
    }

    private static boolean matchesNamespace(String type, String pattern) {
        String namespace = pattern.substring(0, pattern.length() - 2);
        return type.startsWith(namespace + ".");
    }

    private static void validatePattern(String pattern) {
        Objects.requireNonNull(pattern, "pattern");
        if (pattern.isEmpty()) throw new IllegalArgumentException("pattern is empty");
        if (!pattern.equals("*") && !pattern.endsWith(".*") && pattern.contains("*")) {
            throw new IllegalArgumentException("only a trailing * is supported: " + pattern);
        }
    }

    /** Parses a server {@code MESSAGE} frame into the public record. */
    public static IncomingMessage parse(Map<String, Object> frame) {
        String id = Json.optString(frame, "id");
        String type = Json.optString(frame, "type");
        Map<String, Object> route = Json.requireObject(frame, "route");
        Object payload = frame.get("payload");
        Map<String, Object> sender = Json.requireObject(frame, "sender");
        long receivedAt = ((Number) frame.getOrDefault("receivedAt", 0L)).longValue();
        long expireAt = ((Number) frame.getOrDefault("expireAt", 0L)).longValue();
        return new IncomingMessage(
                id == null ? "" : id,
                type == null ? "" : type,
                String.valueOf(route.getOrDefault("mode", "")),
                route.get("target") == null ? null : String.valueOf(route.get("target")),
                payload,
                String.valueOf(sender.getOrDefault("minecraftUuid", "")),
                String.valueOf(sender.getOrDefault("userId", "")),
                receivedAt,
                expireAt,
                String.valueOf(sender.getOrDefault("nickname", "")),
                stringList(sender.get("tags")));
    }

    public static List<String> stringList(Object value) {
        if (!(value instanceof List<?> list)) return List.of();
        return list.stream()
                .filter(String.class::isInstance)
                .map(String.class::cast)
                .toList();
    }
}
