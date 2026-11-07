package cn.seiua.irc.rest;

import cn.seiua.irc.TokenProvider;
import cn.seiua.json.Json;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * REST half of the Hotaru API: groups, presence and message-type filters.
 *
 * <p>The WebSocket carries real-time traffic; everything that configures it is a
 * plain HTTPS call authenticated with the same JWT. This client wraps those calls
 * so a mod never hand-builds URLs or parses the error envelope.
 *
 * <pre>{@code
 * IrcRestClient api = IrcRestClient.builder("wss://irc.example.com")
 *         .tokenProvider(() -> session.accessToken())
 *         .build();
 *
 * Group group = api.groups().create("周末小队");
 * api.groups().addMember(group.id(), friendUuid, "MEMBER");
 * PresenceView me = api.presence().me();
 * api.filters().replaceMine(List.of(new RuleSpec("chat.typing", "DENY")));
 * }</pre>
 *
 * <p>Accepts {@code http(s)://} or {@code ws(s)://} — the scheme is normalised, so
 * the same base URL used for the relay works here.
 *
 * <p><strong>Threading:</strong> calls block on HTTP; do not run them on the render
 * thread. All returned records are immutable.
 */
public final class IrcRestClient {

    private final String baseUrl;
    private final TokenProvider tokenProvider;
    private final HttpClient http;
    private final Duration requestTimeout;

    private IrcRestClient(Builder builder) {
        this.baseUrl = builder.baseUrl;
        this.tokenProvider = builder.tokenProvider;
        this.http = HttpClient.newBuilder()
                .connectTimeout(builder.connectTimeout)
                .followRedirects(HttpClient.Redirect.NEVER)
                // Pinned: over cleartext HTTP the default HTTP/2 preference makes the
                // JDK send an h2c Upgrade, which WebSocket-aware servers may mishandle.
                .version(HttpClient.Version.HTTP_1_1)
                .build();
        this.requestTimeout = builder.requestTimeout;
    }

    public static Builder builder(String baseUrl) {
        return new Builder(baseUrl);
    }

    /* ------------------------------------------------------------------ */
    /* DTOs                                                                */
    /* ------------------------------------------------------------------ */

    public record Group(
            String id,
            String name,
            String ownerUuid,
            String visibility,
            int maxMembers,
            String status,
            String createdAt,
            String updatedAt) {
    }

    public record GroupMember(String groupId, String userUuid, String role, String joinedAt) {
    }

    public record PresenceView(String minecraftUuid, boolean online, int connections) {
    }

    public record PresenceMe(boolean online, int connections, String instanceId) {
    }

    public record FilterRule(
            String id,
            String scope,
            String targetId,
            String pattern,
            String action,
            boolean enabled,
            String createdAt) {
    }

    /** What {@code PUT} sends for one rule. */
    public record RuleSpec(String pattern, String action) {
        public RuleSpec {
            if (pattern == null || pattern.isBlank()) throw new IllegalArgumentException("pattern is blank");
            if (!"ALLOW".equals(action) && !"DENY".equals(action)) {
                throw new IllegalArgumentException("action must be ALLOW or DENY");
            }
        }

        public static RuleSpec deny(String pattern) {
            return new RuleSpec(pattern, "DENY");
        }

        public static RuleSpec allow(String pattern) {
            return new RuleSpec(pattern, "ALLOW");
        }
    }

    /* ------------------------------------------------------------------ */
    /* namespaces                                                          */
    /* ------------------------------------------------------------------ */

    /** Group management (all calls require {@code hotaru:ircserver}). */
    public GroupApi groups() {
        return new GroupApi();
    }

    /** Presence queries, restricted to yourself and players you share a group with. */
    public PresenceApi presence() {
        return new PresenceApi();
    }

    /** Global / group / personal message-type filters (deny-first). */
    public FilterApi filters() {
        return new FilterApi();
    }

    public final class GroupApi {

        public Group create(String name) {
            return create(name, null, null);
        }

        public Group create(String name, String visibility, Integer maxMembers) {
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("name", requireText(name, "name"));
            if (visibility != null) body.put("visibility", visibility);
            if (maxMembers != null) body.put("maxMembers", maxMembers);
            return toGroup(request("POST", "/v1/groups", body));
        }

        public List<Group> list() {
            Map<String, Object> response = request("GET", "/v1/groups", null);
            List<Group> groups = new ArrayList<>();
            for (Object entry : Json.requireArray(response, "groups")) {
                @SuppressWarnings("unchecked")
                Map<String, Object> map = (Map<String, Object>) entry;
                groups.add(parseGroup(map));
            }
            return groups;
        }

        public Group get(String groupId) {
            return toGroup(request("GET", "/v1/groups/" + encode(groupId), null));
        }

        public Group update(String groupId, String name, String visibility, Integer maxMembers) {
            Map<String, Object> body = new LinkedHashMap<>();
            if (name != null) body.put("name", name);
            if (visibility != null) body.put("visibility", visibility);
            if (maxMembers != null) body.put("maxMembers", maxMembers);
            if (body.isEmpty()) throw new IllegalArgumentException("nothing to update");
            return toGroup(request("PATCH", "/v1/groups/" + encode(groupId), body));
        }

        /** Deletes the group; only its OWNER may do this. */
        public void delete(String groupId) {
            request("DELETE", "/v1/groups/" + encode(groupId), null);
        }

        public GroupMember addMember(String groupId, String userUuid, String role) {
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("userUuid", requireText(userUuid, "userUuid"));
            if (role != null) body.put("role", role);
            return toMember(request("POST", "/v1/groups/" + encode(groupId) + "/members", body));
        }

        public void removeMember(String groupId, String userUuid) {
            request("DELETE", "/v1/groups/" + encode(groupId) + "/members/" + encode(userUuid), null);
        }

        /** Role changes are OWNER-only on the server; {@code OWNER} is not assignable. */
        public GroupMember setMemberRole(String groupId, String userUuid, String role) {
            if (!"ADMIN".equals(role) && !"MEMBER".equals(role)) {
                throw new IllegalArgumentException("role must be ADMIN or MEMBER");
            }
            Map<String, Object> body = Map.of("role", role);
            return toMember(request(
                    "PATCH", "/v1/groups/" + encode(groupId) + "/members/" + encode(userUuid), body));
        }
    }

    public final class PresenceApi {

        public PresenceMe me() {
            Map<String, Object> response = request("GET", "/v1/presence/me", null);
            return new PresenceMe(
                    Boolean.TRUE.equals(response.get("online")),
                    intOf(response.get("connections")),
                    String.valueOf(response.getOrDefault("instanceId", "")));
        }

        /** Only allowed for yourself, admins, and players you share a group with. */
        public PresenceView of(String minecraftUuid) {
            Map<String, Object> response = request("GET", "/v1/presence/" + encode(minecraftUuid), null);
            return new PresenceView(
                    String.valueOf(response.getOrDefault("minecraftUuid", minecraftUuid)),
                    Boolean.TRUE.equals(response.get("online")),
                    intOf(response.get("connections")));
        }
    }

    public final class FilterApi {

        public List<FilterRule> mine() {
            return toRules(request("GET", "/v1/filters/me", null));
        }

        public List<FilterRule> replaceMine(List<RuleSpec> rules) {
            return toRules(request("PUT", "/v1/filters/me", rulesBody(rules)));
        }

        public List<FilterRule> groupRules(String groupId) {
            return toRules(request("GET", "/v1/groups/" + encode(groupId) + "/filters", null));
        }

        public List<FilterRule> replaceGroupRules(String groupId, List<RuleSpec> rules) {
            return toRules(request("PUT", "/v1/groups/" + encode(groupId) + "/filters", rulesBody(rules)));
        }

        /** Admin only (the caller's UUID must be listed in the server's ADMIN_UUIDS). */
        public List<FilterRule> globalRules() {
            return toRules(request("GET", "/v1/admin/filters/global", null));
        }

        public List<FilterRule> replaceGlobalRules(List<RuleSpec> rules) {
            return toRules(request("PUT", "/v1/admin/filters/global", rulesBody(rules)));
        }
    }

    /* ------------------------------------------------------------------ */
    /* transport                                                           */
    /* ------------------------------------------------------------------ */

    private Map<String, Object> request(String method, String path, Object body) {
        Objects.requireNonNull(path, "path");
        for (int attempt = 0; attempt < 2; attempt++) {
            String token = tokenProvider.accessToken();
            if (token == null || token.isBlank()) {
                throw new ApiException(401, "UNAUTHORIZED", "token provider returned an empty token");
            }

            HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(baseUrl + path))
                    .timeout(requestTimeout)
                    .header("Authorization", "Bearer " + token)
                    .header("Accept", "application/json")
                    .header("User-Agent", "hotaru-irc-java-rest/0.1.0");

            if (body == null) {
                builder.method(method, HttpRequest.BodyPublishers.noBody());
            } else {
                builder.header("Content-Type", "application/json")
                        .method(method, HttpRequest.BodyPublishers.ofString(Json.write(body), StandardCharsets.UTF_8));
            }

            HttpResponse<String> response;
            try {
                response = http.send(builder.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            } catch (IOException io) {
                throw new ApiException(0, "NETWORK", "cannot reach " + baseUrl + ": " + io.getMessage());
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new ApiException(0, "INTERRUPTED", "request interrupted");
            }

            int status = response.statusCode();
            if (status == 401 && attempt == 0) {
                // Same one-shot refresh contract as the WebSocket client.
                tokenProvider.onTokenRejected();
                continue;
            }
            if (status >= 400) {
                throw errorOf(status, response.body());
            }
            if (status == 204 || response.body() == null || response.body().isBlank()) {
                return Map.of();
            }
            try {
                return Json.parseObject(response.body());
            } catch (RuntimeException malformed) {
                throw new ApiException(status, "INVALID_RESPONSE", "server sent malformed JSON");
            }
        }
        throw new ApiException(401, "UNAUTHORIZED", "token was rejected twice");
    }

    private static ApiException errorOf(int status, String body) {
        try {
            Map<String, Object> envelope = Json.parseObject(body);
            Map<String, Object> error = Json.requireObject(envelope, "error");
            return new ApiException(
                    status,
                    String.valueOf(error.getOrDefault("code", "UNKNOWN")),
                    String.valueOf(error.getOrDefault("message", "request failed")));
        } catch (RuntimeException notAnEnvelope) {
            return new ApiException(status, "HTTP_" + status, "request failed with HTTP " + status);
        }
    }

    /* ------------------------------------------------------------------ */
    /* parsing helpers                                                     */
    /* ------------------------------------------------------------------ */

    private static Group toGroup(Map<String, Object> response) {
        return parseGroup(Json.requireObject(response, "group"));
    }

    private static Group parseGroup(Map<String, Object> map) {
        return new Group(
                String.valueOf(map.getOrDefault("id", "")),
                String.valueOf(map.getOrDefault("name", "")),
                String.valueOf(map.getOrDefault("ownerUuid", "")),
                String.valueOf(map.getOrDefault("visibility", "")),
                intOf(map.get("maxMembers")),
                String.valueOf(map.getOrDefault("status", "")),
                String.valueOf(map.getOrDefault("createdAt", "")),
                String.valueOf(map.getOrDefault("updatedAt", "")));
    }

    private static GroupMember toMember(Map<String, Object> response) {
        Map<String, Object> map = Json.requireObject(response, "member");
        return new GroupMember(
                String.valueOf(map.getOrDefault("groupId", "")),
                String.valueOf(map.getOrDefault("userUuid", "")),
                String.valueOf(map.getOrDefault("role", "")),
                String.valueOf(map.getOrDefault("joinedAt", "")));
    }

    private static List<FilterRule> toRules(Map<String, Object> response) {
        List<FilterRule> rules = new ArrayList<>();
        for (Object entry : Json.requireArray(response, "rules")) {
            @SuppressWarnings("unchecked")
            Map<String, Object> map = (Map<String, Object>) entry;
            rules.add(new FilterRule(
                    String.valueOf(map.getOrDefault("id", "")),
                    String.valueOf(map.getOrDefault("scope", "")),
                    map.get("targetId") == null ? null : String.valueOf(map.get("targetId")),
                    String.valueOf(map.getOrDefault("pattern", "")),
                    String.valueOf(map.getOrDefault("action", "")),
                    Boolean.TRUE.equals(map.get("enabled")),
                    String.valueOf(map.getOrDefault("createdAt", ""))));
        }
        return rules;
    }

    private static Map<String, Object> rulesBody(List<RuleSpec> rules) {
        Objects.requireNonNull(rules, "rules");
        List<Object> serialised = new ArrayList<>(rules.size());
        for (RuleSpec rule : rules) {
            serialised.add(Json.object("pattern", rule.pattern(), "action", rule.action()));
        }
        return Json.object("rules", serialised);
    }

    private static int intOf(Object value) {
        return value instanceof Number number ? number.intValue() : 0;
    }

    private static String requireText(String value, String name) {
        if (value == null || value.isBlank()) throw new IllegalArgumentException(name + " is blank");
        return value;
    }

    /** Percent-encodes a path segment (group ids and UUIDs are ASCII, but do it properly). */
    private static String encode(String segment) {
        return java.net.URLEncoder.encode(requireText(segment, "segment"), StandardCharsets.UTF_8)
                .replace("+", "%20");
    }

    /* ------------------------------------------------------------------ */
    /* builder                                                             */
    /* ------------------------------------------------------------------ */

    public static final class Builder {

        private final String baseUrl;
        private TokenProvider tokenProvider = () -> {
            throw new ApiException(401, "UNAUTHORIZED", "no TokenProvider configured");
        };
        private Duration connectTimeout = Duration.ofSeconds(5);
        private Duration requestTimeout = Duration.ofSeconds(10);

        private Builder(String baseUrl) {
            this.baseUrl = normalizeBaseUrl(requireText(baseUrl, "baseUrl"));
        }

        public Builder tokenProvider(TokenProvider provider) {
            this.tokenProvider = Objects.requireNonNull(provider, "tokenProvider");
            return this;
        }

        public Builder connectTimeout(Duration timeout) {
            this.connectTimeout = Objects.requireNonNull(timeout, "connectTimeout");
            return this;
        }

        public Builder requestTimeout(Duration timeout) {
            this.requestTimeout = Objects.requireNonNull(timeout, "requestTimeout");
            return this;
        }

        public IrcRestClient build() {
            return new IrcRestClient(this);
        }

        private static String normalizeBaseUrl(String raw) {
            String value = raw.trim();
            if (value.startsWith("wss://")) value = "https://" + value.substring("wss://".length());
            else if (value.startsWith("ws://")) value = "http://" + value.substring("ws://".length());
            else if (!value.startsWith("https://") && !value.startsWith("http://")) {
                throw new IllegalArgumentException("baseUrl must be http(s):// or ws(s)://, got " + raw);
            }
            while (value.endsWith("/")) value = value.substring(0, value.length() - 1);
            if (value.endsWith("/v1/connect")) value = value.substring(0, value.length() - "/v1/connect".length());
            return value;
        }
    }
}
