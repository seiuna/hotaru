package cn.seiua.irc;

/** Client-side failure: not connected, ACK timeout, or a protocol error reply. */
public class IrcException extends RuntimeException {

    private static final long serialVersionUID = 1L;

    private final String code;

    public IrcException(String code, String message) {
        super(message);
        this.code = code;
    }

    public IrcException(String code, String message, Throwable cause) {
        super(message, cause);
        this.code = code;
    }

    /** SRP error code, or a client-side code such as {@code NOT_CONNECTED}. */
    public String code() {
        return code;
    }
}
