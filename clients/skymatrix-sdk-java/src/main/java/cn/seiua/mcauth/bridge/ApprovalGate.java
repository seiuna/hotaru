package cn.seiua.mcauth.bridge;

import java.time.Duration;

/**
 * Asks the player to authorise a browser origin, and blocks until they answer.
 *
 * <p>The bridge never logs anyone in silently. A page that guesses the port still cannot obtain a
 * token: it must first pass this gate, which in a Fabric mod is an in-game prompt such as
 * {@code "允许 https://admin.example.com 登录 Skymatrix？[是/否]"}.
 *
 * <p>Implementations must be thread-safe: several origins may ask at once.
 */
@FunctionalInterface
public interface ApprovalGate {

    /**
     * @param origin the normalised browser origin requesting a token
     * @param timeout how long the caller will wait; return {@code false} when it elapses
     * @return {@code true} to mint and release a token, {@code false} to refuse
     */
    boolean approve(String origin, Duration timeout);

    /** Refuses everything — useful when the mod is in a "logged out" state. */
    static ApprovalGate denyAll() {
        return (origin, timeout) -> false;
    }
}
