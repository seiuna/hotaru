package com.skymatrix.irc;

/** Connection lifecycle, mirroring the design's state machine. */
public enum IrcState {
    DISCONNECTED,
    CONNECTING,
    CONNECTED,
    RECONNECTING,
    /** Terminal: authentication failed, or the client was closed on purpose. */
    CLOSED
}
