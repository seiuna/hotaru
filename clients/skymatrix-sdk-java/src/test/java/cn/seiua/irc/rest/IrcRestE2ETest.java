package cn.seiua.irc.rest;

import java.util.List;
import java.util.UUID;

/**
 * End-to-end check of {@link IrcRestClient} against a running relay.
 *
 * <p>Requires {@code IRC_HTTP_URL} (e.g. {@code http://127.0.0.1:3001}) and
 * {@code IRC_TOKEN} (a JWT with {@code skymatrix:ircserver}). It creates a group,
 * exercises membership, deletes it, and round-trips the personal filter rules —
 * restoring them afterwards so the account is left as it was found.
 *
 * <pre>java -cp out cn.seiua.irc.rest.IrcRestE2ETest</pre>
 */
public final class IrcRestE2ETest {

    private static int checks;
    private static int failures;

    public static void main(String[] args) {
        String baseUrl = System.getenv("IRC_HTTP_URL");
        String token = System.getenv("IRC_TOKEN");
        String myUuid = System.getenv("IRC_UUID");
        if (baseUrl == null || baseUrl.isBlank() || token == null || token.isBlank()) {
            System.out.println("SKIP: set IRC_HTTP_URL and IRC_TOKEN to run the REST end-to-end test");
            return;
        }

        IrcRestClient api = IrcRestClient.builder(baseUrl).tokenProvider(() -> token).build();
        String groupId = null;
        List<IrcRestClient.FilterRule> originalRules = null;

        try {
            IrcRestClient.PresenceMe me = api.presence().me();
            check("presence/me answers", me.instanceId() != null && !me.instanceId().isBlank(), me.toString());
            check("presence reports a connection count", me.connections() >= 0);

            String suffix = Long.toString(System.currentTimeMillis(), 36);
            IrcRestClient.Group group = api.groups().create("sdk-e2e-" + suffix, "PRIVATE", 10);
            groupId = group.id();
            check("create returns a group id", groupId != null && !groupId.isBlank(), group.toString());
            check("creator owns the group", myUuid == null || group.ownerUuid().equalsIgnoreCase(myUuid), group.ownerUuid());
            check("visibility round-trips", "PRIVATE".equals(group.visibility()), group.visibility());

            final String createdId = groupId;
            List<IrcRestClient.Group> groups = api.groups().list();
            check("the new group is listed", groups.stream().anyMatch(candidate -> candidate.id().equals(createdId)),
                    groups.toString());

            IrcRestClient.Group fetched = api.groups().get(groupId);
            check("get returns the same group", fetched.id().equals(groupId) && fetched.name().equals(group.name()));

            String friend = UUID.randomUUID().toString();
            IrcRestClient.GroupMember member = api.groups().addMember(groupId, friend, "MEMBER");
            check("a member can be added", member.userUuid().equalsIgnoreCase(friend) && "MEMBER".equals(member.role()),
                    member.toString());

            IrcRestClient.GroupMember promoted = api.groups().setMemberRole(groupId, friend, "ADMIN");
            check("a member can be promoted to ADMIN", "ADMIN".equals(promoted.role()), promoted.toString());

            api.groups().removeMember(groupId, friend);
            check("a member can be removed", true);

            IrcRestClient.Group renamed = api.groups().update(groupId, "sdk-e2e-renamed-" + suffix, null, 20);
            check("the group can be renamed / resized",
                    renamed.name().startsWith("sdk-e2e-renamed-") && renamed.maxMembers() == 20, renamed.toString());

            originalRules = api.filters().mine();
            List<IrcRestClient.FilterRule> replaced = api.filters().replaceMine(
                    List.of(IrcRestClient.RuleSpec.deny("chat.typing")));
            check("personal filter rules can be replaced",
                    replaced.size() == 1 && "chat.typing".equals(replaced.get(0).pattern())
                            && "DENY".equals(replaced.get(0).action()),
                    replaced.toString());
            List<IrcRestClient.FilterRule> reread = api.filters().mine();
            check("replaced rules persist", reread.size() == 1 && "chat.typing".equals(reread.get(0).pattern()),
                    reread.toString());

            api.groups().delete(groupId);
            String deletedId = groupId;
            ApiException gone = null;
            try {
                api.groups().get(deletedId);
            } catch (ApiException expected) {
                gone = expected;
            }
            check("a deleted group is gone", gone != null && gone.isNotFound(), String.valueOf(gone));
            groupId = null;
        } finally {
            if (originalRules != null) {
                try {
                    api.filters().replaceMine(toSpecs(originalRules));
                } catch (RuntimeException ignored) {
                    // Best-effort restore; the test result already reflects the assertions.
                }
            }
            if (groupId != null) {
                try {
                    api.groups().delete(groupId);
                } catch (RuntimeException ignored) {
                    // Already deleted or not owned.
                }
            }
        }

        System.out.println();
        System.out.println("checks passed: " + (checks - failures) + ", failed: " + failures);
        if (failures > 0) {
            System.out.println("RESULT: FAIL");
            System.exit(1);
        }
        System.out.println("RESULT: PASS");
    }

    private static List<IrcRestClient.RuleSpec> toSpecs(List<IrcRestClient.FilterRule> rules) {
        return rules.stream()
                .map(rule -> new IrcRestClient.RuleSpec(rule.pattern(), rule.action()))
                .toList();
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
}
