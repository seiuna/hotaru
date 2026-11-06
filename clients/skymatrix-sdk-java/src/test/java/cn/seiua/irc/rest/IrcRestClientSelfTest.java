package cn.seiua.irc.rest;

import cn.seiua.json.Json;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Offline self-test for {@link IrcRestClient}: a local HTTP server records the
 * requests and replays canned answers, so URL construction, the auth header, the
 * JSON bodies, response parsing and error mapping are all asserted without a real
 * relay.
 *
 * <pre>java -cp out cn.seiua.irc.rest.IrcRestClientSelfTest</pre>
 */
public final class IrcRestClientSelfTest {

    private static int checks;
    private static int failures;

    public static void main(String[] args) throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 4);
        Recorder recorder = new Recorder();
        server.createContext("/", recorder::handle);
        server.start();
        String base = "http://127.0.0.1:" + server.getAddress().getPort();

        try {
            groupsIgnoredScenarios(base, recorder);
            errorMapping(base, recorder);
            tokenRefresh(base, recorder);
            presence(base, recorder);
            filters(base, recorder);
            badInputIsRejectedLocally(base, recorder);
        } finally {
            server.stop(0);
        }

        System.out.println();
        System.out.println("checks passed: " + (checks - failures) + ", failed: " + failures);
        if (failures > 0) {
            System.out.println("RESULT: FAIL");
            System.exit(1);
        }
        System.out.println("RESULT: PASS");
    }

    /* ------------------------------------------------------------------ */

    private static void groupsIgnoredScenarios(String base, Recorder recorder) {
        IrcRestClient api = client(base);

        recorder.reply(201, Json.write(Json.object("group", group("grp_1", "周末小队"))));
        IrcRestClient.Group created = api.groups().create("周末小队", "PRIVATE", 20);
        Recorded create = recorder.last();
        check("create uses POST /v1/groups", create.method.equals("POST") && create.path.equals("/v1/groups"), create.describe());
        check("create sends a bearer token", create.authorization.startsWith("Bearer "), create.authorization);
        Map<String, Object> body = Json.parseObject(create.body);
        check("create body carries name/visibility/maxMembers",
                "周末小队".equals(body.get("name")) && "PRIVATE".equals(body.get("visibility"))
                        && ((Number) body.get("maxMembers")).intValue() == 20,
                create.body);
        check("response is parsed into a Group", created.id().equals("grp_1") && created.maxMembers() == 100, created.toString());

        recorder.reply(200, Json.write(Json.object("groups", Json.array(group("grp_1", "A"), group("grp_2", "B")))));
        List<IrcRestClient.Group> groups = api.groups().list();
        check("list parses every group", groups.size() == 2 && groups.get(1).id().equals("grp_2"), groups.toString());
        check("list uses GET /v1/groups", recorder.last().path.equals("/v1/groups") && recorder.last().method.equals("GET"));

        recorder.reply(200, Json.write(Json.object("group", group("grp 1", "spaced"))));
        api.groups().get("grp 1");
        check("path segments are percent-encoded", recorder.last().path.equals("/v1/groups/grp%201"), recorder.last().path);

        recorder.reply(204, "");
        api.groups().delete("grp_1");
        check("delete tolerates a 204 with no body", recorder.last().method.equals("DELETE"));

        recorder.reply(201, Json.write(Json.object("member",
                Json.object("groupId", "grp_1", "userUuid", "4c1099df-e202-4e64-9ea2-9039be420143",
                        "role", "MEMBER", "joinedAt", "2026-01-01T00:00:00.000Z"))));
        IrcRestClient.GroupMember member = api.groups().addMember("grp_1", "4c1099df-e202-4e64-9ea2-9039be420143", "MEMBER");
        check("add member parses the membership", member.role().equals("MEMBER"), member.toString());
        check("add member posts to /members", recorder.last().path.equals("/v1/groups/grp_1/members"));

        recorder.reply(200, Json.write(Json.object("member",
                Json.object("groupId", "grp_1", "userUuid", "u1", "role", "ADMIN", "joinedAt", "x"))));
        IrcRestClient.GroupMember promoted = api.groups().setMemberRole("grp_1", "u1", "ADMIN");
        check("role change parses the new role", promoted.role().equals("ADMIN"), promoted.toString());
        check("role change uses PATCH", recorder.last().method.equals("PATCH"));
    }

    private static void errorMapping(String base, Recorder recorder) {
        IrcRestClient api = client(base);

        recorder.reply(403, Json.write(Json.object("error",
                Json.object("code", "GROUP_ACCESS_DENIED", "message", "No access to this group"))));
        ApiException forbidden = expectApiError(() -> api.groups().get("grp_x"));
        check("error envelope becomes ApiException", forbidden != null && forbidden.code().equals("GROUP_ACCESS_DENIED"),
                String.valueOf(forbidden));
        check("status is preserved", forbidden != null && forbidden.statusCode() == 403);
        check("isForbidden() recognises 403", forbidden != null && forbidden.isForbidden());

        recorder.reply(404, Json.write(Json.object("error",
                Json.object("code", "GROUP_NOT_FOUND", "message", "Group not found"))));
        ApiException notFound = expectApiError(() -> api.groups().get("grp_missing"));
        check("404 maps to isNotFound()", notFound != null && notFound.isNotFound());

        recorder.reply(500, "not json at all");
        ApiException internal = expectApiError(() -> api.presence().me());
        check("non-envelope errors still surface a code", internal != null && internal.code().equals("HTTP_500"),
                String.valueOf(internal));
    }

    private static void tokenRefresh(String base, Recorder recorder) {
        AtomicInteger calls = new AtomicInteger();
        List<Integer> refreshes = new ArrayList<>();
        String[] token = {"old-token"};
        IrcRestClient api = IrcRestClient.builder(base)
                .tokenProvider(new cn.seiua.irc.TokenProvider() {
                    @Override
                    public String accessToken() {
                        calls.incrementAndGet();
                        return token[0];
                    }

                    @Override
                    public void onTokenRejected() {
                        refreshes.add(1);
                        token[0] = "new-token";
                    }
                })
                .build();

        recorder.reply(401, Json.write(Json.object("error", Json.object("code", "TOKEN_EXPIRED", "message", "expired"))));
        recorder.reply(200, Json.write(Json.object("groups", Json.array())));

        List<IrcRestClient.Group> groups = api.groups().list();
        check("a 401 triggers one token refresh", refreshes.size() == 1, refreshes.toString());
        check("the retry uses the refreshed token", recorder.last().authorization.equals("Bearer new-token"),
                recorder.last().authorization);
        check("the retried request succeeds", groups.isEmpty());
        check("token provider read once per attempt", calls.get() == 2, String.valueOf(calls.get()));
    }

    private static void presence(String base, Recorder recorder) {
        IrcRestClient api = client(base);

        recorder.reply(200, Json.write(Json.object("online", true, "connections", 2, "instanceId", "irc-01")));
        IrcRestClient.PresenceMe me = api.presence().me();
        check("presence/me parses online + connections", me.online() && me.connections() == 2, me.toString());
        check("presence/me keeps the instance id", me.instanceId().equals("irc-01"));

        recorder.reply(200, Json.write(Json.object(
                "minecraftUuid", "4c1099df-e202-4e64-9ea2-9039be420143", "online", false, "connections", 0)));
        IrcRestClient.PresenceView other = api.presence().of("4c1099df-e202-4e64-9ea2-9039be420143");
        check("presence/:uuid parses offline", !other.online() && other.connections() == 0, other.toString());
        check("presence uses the right path", recorder.last().path.equals("/v1/presence/4c1099df-e202-4e64-9ea2-9039be420143"));
    }

    private static void filters(String base, Recorder recorder) {
        IrcRestClient api = client(base);

        recorder.reply(200, Json.write(Json.object("rules", Json.array(
                Json.object("id", "r1", "scope", "USER", "targetId", "u1", "pattern", "chat.typing",
                        "action", "DENY", "enabled", true, "createdAt", "2026-01-01T00:00:00.000Z")))));
        List<IrcRestClient.FilterRule> rules = api.filters().mine();
        check("filter rules parse", rules.size() == 1 && rules.get(0).enabled(), rules.toString());
        check("filter rules keep a null-capable targetId", rules.get(0).targetId().equals("u1"));

        recorder.reply(200, Json.write(Json.object("rules", Json.array())));
        api.filters().replaceMine(List.of(
                IrcRestClient.RuleSpec.deny("chat.typing"),
                IrcRestClient.RuleSpec.allow("skymatrix.*")));
        Map<String, Object> body = Json.parseObject(recorder.last().body);
        List<?> serialised = (List<?>) body.get("rules");
        Map<?, ?> first = (Map<?, ?>) serialised.get(0);
        check("replace sends PUT with a rules array",
                recorder.last().method.equals("PUT") && serialised.size() == 2, recorder.last().describe());
        check("each rule is pattern+action only",
                first.get("pattern").equals("chat.typing") && first.get("action").equals("DENY") && first.size() == 2,
                body.toString());

        recorder.reply(200, Json.write(Json.object("rules", Json.array())));
        api.filters().replaceGroupRules("grp_1", List.of(IrcRestClient.RuleSpec.deny("chat.*")));
        check("group filters use the group path",
                recorder.last().path.equals("/v1/groups/grp_1/filters") && recorder.last().method.equals("PUT"));

        recorder.reply(200, Json.write(Json.object("rules", Json.array())));
        api.filters().globalRules();
        check("global filters use the admin path",
                recorder.last().path.equals("/v1/admin/filters/global") && recorder.last().method.equals("GET"));
    }

    private static void badInputIsRejectedLocally(String base, Recorder recorder) {
        IrcRestClient api = client(base);
        int before = recorder.count();

        boolean blankName = false;
        try {
            api.groups().create("  ");
        } catch (IllegalArgumentException expected) {
            blankName = true;
        }
        check("blank group name fails before any HTTP call", blankName && recorder.count() == before);

        boolean badAction = false;
        try {
            new IrcRestClient.RuleSpec("chat.message", "MAYBE");
        } catch (IllegalArgumentException expected) {
            badAction = true;
        }
        check("unknown filter action is rejected locally", badAction);

        boolean badRole = false;
        try {
            api.groups().setMemberRole("grp_1", "u1", "OWNER");
        } catch (IllegalArgumentException expected) {
            badRole = true;
        }
        check("OWNER cannot be assigned through the API", badRole);
    }

    /* ------------------------------------------------------------------ */

    private static IrcRestClient client(String base) {
        return IrcRestClient.builder(base).tokenProvider(() -> "test-token").build();
    }

    private static ApiException expectApiError(Runnable action) {
        try {
            action.run();
            return null;
        } catch (ApiException expected) {
            return expected;
        }
    }

    private static Map<String, Object> group(String id, String name) {
        return Json.object(
                "id", id,
                "name", name,
                "ownerUuid", "4c1099df-e202-4e64-9ea2-9039be420143",
                "visibility", "PRIVATE",
                "maxMembers", 100,
                "status", "ACTIVE",
                "createdAt", "2026-01-01T00:00:00.000Z",
                "updatedAt", "2026-01-01T00:00:00.000Z");
    }

    private static void check(String name, boolean condition) {
        check(name, condition, "");
    }

    private static void check(String name, boolean condition, String detail) {
        checks++;
        if (condition) {
            System.out.println("  PASS  " + name);
        } else {
            failures++;
            System.out.println("  FAIL  " + name + (detail.isBlank() ? "" : " -> " + detail));
        }
    }

    /* ------------------------------------------------------------------ */

    private record Recorded(String method, String path, String authorization, String body) {
        String describe() {
            return method + " " + path;
        }
    }

    private record Reply(int status, String body) {
    }

    private static final class Recorder {

        private final List<Recorded> requests = new CopyOnWriteArrayList<>();
        private final Deque<Reply> replies = new ArrayDeque<>();

        synchronized void reply(int status, String body) {
            replies.addLast(new Reply(status, body));
        }

        Recorded last() {
            return requests.get(requests.size() - 1);
        }

        int count() {
            return requests.size();
        }

        void handle(HttpExchange exchange) throws IOException {
            String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            String authorization = exchange.getRequestHeaders().getFirst("Authorization");
            Recorded recorded = new Recorded(
                    exchange.getRequestMethod(),
                    exchange.getRequestURI().getRawPath(),
                    authorization == null ? "" : authorization,
                    body);
            requests.add(recorded);

            Reply reply;
            synchronized (this) {
                reply = replies.isEmpty() ? new Reply(200, "{}") : replies.pollFirst();
            }

            byte[] bytes = reply.body().getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            if (bytes.length == 0) {
                exchange.sendResponseHeaders(reply.status(), -1);
            } else {
                exchange.sendResponseHeaders(reply.status(), bytes.length);
                try (OutputStream out = exchange.getResponseBody()) {
                    out.write(bytes);
                }
            }
            exchange.close();
        }
    }
}
