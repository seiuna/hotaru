package com.skymatrix.mcauth;

import com.skymatrix.mcauth.json.Json;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;

/**
 * Resolves "who does this access token belong to?" via Mojang's own profile endpoint.
 *
 * <p>This is what lets the library offer a single-method integration surface: give it a token, and it
 * learns the UUID and username itself instead of asking the host application for data it may not have.
 * The call is a plain {@code GET https://api.minecraftservices.com/minecraft/profile} with the token as
 * a bearer credential — the same thing the vanilla client does at startup.
 *
 * <p>No third-party dependency: {@link HttpClient} and the SDK's own JSON reader.
 */
public final class MinecraftProfileResolver {

    /** Mojang's profile endpoint (returns {@code {id, name, skins, capes}}). */
    public static final String DEFAULT_ENDPOINT = "https://api.minecraftservices.com/minecraft/profile";

    private final URI endpoint;
    private final HttpClient http;
    private final Duration timeout;

    public MinecraftProfileResolver() {
        this(URI.create(DEFAULT_ENDPOINT), Duration.ofSeconds(10));
    }

    public MinecraftProfileResolver(String endpoint) {
        this(URI.create(Objects.requireNonNull(endpoint, "endpoint")), Duration.ofSeconds(10));
    }

    public MinecraftProfileResolver(URI endpoint, Duration timeout) {
        this.endpoint = Objects.requireNonNull(endpoint, "endpoint");
        this.timeout = Objects.requireNonNull(timeout, "timeout");
        this.http = HttpClient.newBuilder()
                .connectTimeout(timeout)
                .followRedirects(HttpClient.Redirect.NEVER)
                .build();
    }

    /**
     * @throws McAuthException {@code UNAUTHORIZED} when Mojang rejects the token (expired/revoked),
     *     {@code TRANSPORT_ERROR} (retryable) when the endpoint cannot be reached, or
     *     {@code INVALID_RESPONSE} when the payload is not the expected shape
     */
    public PlayerProfile resolve(String accessToken) throws McAuthException, InterruptedException {
        if (accessToken == null || accessToken.isBlank()) {
            throw new McAuthException(ApiErrorCode.UNAUTHORIZED, "access token is blank", 0, false, null, null);
        }

        HttpRequest request = HttpRequest.newBuilder(endpoint)
                .timeout(timeout)
                .header("Authorization", "Bearer " + accessToken)
                .header("Accept", "application/json")
                .header("User-Agent", McAuthClient.USER_AGENT)
                .GET()
                .build();

        HttpResponse<String> response;
        try {
            response = http.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        } catch (IOException failure) {
            throw new McAuthException(
                    ApiErrorCode.TRANSPORT_ERROR,
                    "could not reach Mojang to resolve the profile: " + failure.getMessage(),
                    0,
                    true,
                    null,
                    failure);
        }

        int status = response.statusCode();
        if (status == 401 || status == 403) {
            throw new McAuthException(
                    ApiErrorCode.UNAUTHORIZED,
                    "Mojang rejected the access token (expired or revoked)",
                    status,
                    false,
                    null,
                    null);
        }
        if (status >= 500) {
            throw new McAuthException(
                    ApiErrorCode.TRANSPORT_ERROR,
                    "Mojang profile endpoint is unavailable (HTTP " + status + ")",
                    status,
                    true,
                    null,
                    null);
        }
        if (status != 200) {
            throw new McAuthException(
                    ApiErrorCode.INVALID_RESPONSE,
                    "unexpected profile response (HTTP " + status + ")",
                    status,
                    false,
                    null,
                    null);
        }

        Map<String, Object> body;
        try {
            body = Json.parseObject(response.body());
        } catch (RuntimeException malformed) {
            throw new McAuthException(
                    ApiErrorCode.INVALID_RESPONSE,
                    "profile payload is not valid JSON",
                    status,
                    false,
                    null,
                    malformed);
        }

        String id = Json.optString(body, "id");
        String name = Json.optString(body, "name");
        if (id == null || id.isBlank() || name == null || name.isBlank()) {
            throw new McAuthException(
                    ApiErrorCode.INVALID_RESPONSE,
                    "profile payload has no id/name (is this a Minecraft account?)",
                    status,
                    false,
                    null,
                    null);
        }

        return new PlayerProfile(id.replace("-", "").toLowerCase(Locale.ROOT), name);
    }
}
