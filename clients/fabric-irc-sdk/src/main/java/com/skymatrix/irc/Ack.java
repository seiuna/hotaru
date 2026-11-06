package com.skymatrix.irc;

/**
 * Server acknowledgement for one outbound message.
 *
 * <p>{@code status} is {@code accepted}, {@code delivered} or {@code failed}.
 * <strong>{@code delivered} means the server handed the frame to the recipient's
 * socket — not that the recipient's mod processed it.</strong>
 *
 * @param replyTo the client-generated message id this ACK refers to
 * @param status accepted / delivered / failed
 * @param recipients how many sockets the server enqueued the frame on ({@code -1} when not reported)
 * @param reason failure reason (e.g. {@code TARGET_OFFLINE}) when {@code status == failed}
 */
public record Ack(String replyTo, String status, int recipients, String reason) {

    public boolean isAccepted() {
        return "accepted".equals(status);
    }

    public boolean isDelivered() {
        return "delivered".equals(status);
    }

    public boolean isFailed() {
        return "failed".equals(status);
    }

    @Override
    public String toString() {
        return "Ack[replyTo=" + replyTo + ", status=" + status
                + ", recipients=" + recipients
                + (reason == null ? "" : ", reason=" + reason) + "]";
    }
}
