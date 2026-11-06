package com.skymatrix.mcauth;

/**
 * The identity Mojang reports for an access token.
 *
 * @param uuid the player UUID as <strong>undashed lowercase hex</strong> (32 chars) — the form the
 *     Mojang join payload expects; {@link McAuthClient} normalises either form internally
 * @param username the current Minecraft username as returned by Mojang
 */
public record PlayerProfile(String uuid, String username) {

    public PlayerProfile {
        if (uuid == null || uuid.isBlank()) throw new IllegalArgumentException("uuid is blank");
        if (username == null || username.isBlank()) throw new IllegalArgumentException("username is blank");
    }
}
