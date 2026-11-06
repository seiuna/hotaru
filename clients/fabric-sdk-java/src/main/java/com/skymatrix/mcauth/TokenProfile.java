package com.skymatrix.mcauth;

/**
 * The Minecraft profile the server derived from Mojang — never from anything the client claimed.
 *
 * @param uuid canonical dashed lowercase Mojang UUID, e.g. {@code 069a79f4-44e9-4726-a5be-fca90e38aaf5}
 * @param username the Mojang username Mojang returned for the joined session
 */
public record TokenProfile(String uuid, String username) {

    public TokenProfile {
        if (uuid == null || uuid.isBlank()) throw new IllegalArgumentException("uuid is blank");
        if (username == null || username.isBlank()) throw new IllegalArgumentException("username is blank");
    }
}
