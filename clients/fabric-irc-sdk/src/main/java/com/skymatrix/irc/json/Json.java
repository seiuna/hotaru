package com.skymatrix.irc.json;

/* Copied from the MC Auth Java client (com.skymatrix.mcauth.json.Json) so this
 * library stays standalone and dependency-free. Keep the two in sync when the
 * parser changes; the value model and limits are identical. */

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * A minimal, dependency-free JSON reader/writer.
 *
 * <p>Fabric mods cannot rely on Jackson or Gson being on the classpath, and shading a JSON library
 * into an SDK this small would be disproportionate. This class implements exactly what the MC Auth
 * protocol needs — RFC 8259 objects, arrays, strings, numbers, booleans and {@code null} — with no
 * reflection and no dependencies.
 *
 * <p><strong>Value model</strong> (what {@link #parse(String)} returns and {@link #write(Object)}
 * accepts):
 *
 * <table border="1">
 *   <caption>JSON to Java mapping</caption>
 *   <tr><th>JSON</th><th>Java</th></tr>
 *   <tr><td>object</td><td>{@code LinkedHashMap<String, Object>} (insertion order kept)</td></tr>
 *   <tr><td>array</td><td>{@code ArrayList<Object>}</td></tr>
 *   <tr><td>string</td><td>{@code String}</td></tr>
 *   <tr><td>integer</td><td>{@code Long}, or {@code BigDecimal} when it does not fit in a long</td></tr>
 *   <tr><td>fraction / exponent</td><td>{@code Double}</td></tr>
 *   <tr><td>true / false</td><td>{@code Boolean}</td></tr>
 *   <tr><td>null</td><td>{@code null}</td></tr>
 * </table>
 *
 * <p>The parser is strict about structure (it rejects trailing commas, unterminated strings and
 * trailing garbage) and bounds nesting depth so a malicious server cannot overflow the stack.
 * Parsing never evaluates anything and never touches the network.
 *
 * <p>This class is thread-safe: it holds no mutable state.
 */
public final class Json {

    /** Maximum object/array nesting the parser and the writer accept. */
    private static final int MAX_DEPTH = 64;

    private Json() {
        // Static utility class.
    }

    /* ------------------------------------------------------------------ */
    /* Parsing                                                             */
    /* ------------------------------------------------------------------ */

    /** Parses a complete JSON document. */
    public static Object parse(String text) {
        if (text == null) throw new ParseException("JSON text is null");
        return new Parser(text).parseDocument();
    }

    /** Parses a JSON document that must be an object. */
    @SuppressWarnings("unchecked")
    public static Map<String, Object> parseObject(String text) {
        Object value = parse(text);
        if (!(value instanceof Map<?, ?>)) {
            throw new ParseException("expected a JSON object, got " + typeName(value));
        }
        return (Map<String, Object>) value;
    }

    /* ------------------------------------------------------------------ */
    /* Writing                                                             */
    /* ------------------------------------------------------------------ */

    /** Serialises a value from the model above into compact JSON text. */
    public static String write(Object value) {
        StringBuilder out = new StringBuilder(128);
        writeValue(out, value, 0);
        return out.toString();
    }

    /**
     * Builds an object literal from alternating keys and values:
     * {@code Json.object("username", "Notch", "client", "fabric")}. Keys must be strings; {@code null}
     * values are written as JSON {@code null}.
     */
    public static Map<String, Object> object(Object... keysAndValues) {
        if (keysAndValues.length % 2 != 0) {
            throw new IllegalArgumentException("object(...) needs an even number of arguments");
        }
        Map<String, Object> object = new LinkedHashMap<>();
        for (int i = 0; i < keysAndValues.length; i += 2) {
            if (!(keysAndValues[i] instanceof String key)) {
                throw new IllegalArgumentException("object(...) key at index " + i + " is not a String");
            }
            object.put(key, keysAndValues[i + 1]);
        }
        return object;
    }

    /** Builds an array literal. */
    public static List<Object> array(Object... items) {
        List<Object> list = new ArrayList<>(items.length);
        for (Object item : items) list.add(item);
        return list;
    }

    /* ------------------------------------------------------------------ */
    /* Typed accessors                                                     */
    /* ------------------------------------------------------------------ */

    /** Returns the value for {@code key}, or throws if it is missing. */
    public static Object require(Map<String, Object> object, String key) {
        if (!object.containsKey(key)) {
            throw new ParseException("missing required field '" + key + "'");
        }
        return object.get(key);
    }

    /** Returns a required string field. */
    public static String requireString(Map<String, Object> object, String key) {
        Object value = require(object, key);
        if (!(value instanceof String text)) {
            throw new ParseException("field '" + key + "' must be a string, got " + typeName(value));
        }
        return text;
    }

    /** Returns an optional string field, or {@code null}. */
    public static String optString(Map<String, Object> object, String key) {
        Object value = object.get(key);
        if (value == null) return null;
        if (!(value instanceof String text)) {
            throw new ParseException("field '" + key + "' must be a string, got " + typeName(value));
        }
        return text;
    }

    /** Returns a required integer field as an {@code int}, rejecting fractions. */
    public static int requireInt(Map<String, Object> object, String key) {
        Object value = require(object, key);
        long number;
        if (value instanceof Long asLong) {
            number = asLong;
        } else if (value instanceof Integer asInteger) {
            number = asInteger;
        } else if (value instanceof BigDecimal decimal && decimal.scale() <= 0) {
            try {
                number = decimal.longValueExact();
            } catch (ArithmeticException e) {
                throw new ParseException("field '" + key + "' is out of range");
            }
        } else {
            throw new ParseException("field '" + key + "' must be an integer, got " + typeName(value));
        }
        if (number < Integer.MIN_VALUE || number > Integer.MAX_VALUE) {
            throw new ParseException("field '" + key + "' is out of int range: " + number);
        }
        return (int) number;
    }

    /** Returns a required object field. */
    @SuppressWarnings("unchecked")
    public static Map<String, Object> requireObject(Map<String, Object> object, String key) {
        Object value = require(object, key);
        if (!(value instanceof Map<?, ?>)) {
            throw new ParseException("field '" + key + "' must be an object, got " + typeName(value));
        }
        return (Map<String, Object>) value;
    }

    /** Returns a required array field. */
    @SuppressWarnings("unchecked")
    public static List<Object> requireArray(Map<String, Object> object, String key) {
        Object value = require(object, key);
        if (!(value instanceof List<?>)) {
            throw new ParseException("field '" + key + "' must be an array, got " + typeName(value));
        }
        return (List<Object>) value;
    }

    /** Returns a required array of strings, in order. */
    public static List<String> requireStringArray(Map<String, Object> object, String key) {
        List<Object> raw = requireArray(object, key);
        List<String> strings = new ArrayList<>(raw.size());
        for (Object item : raw) {
            if (!(item instanceof String text)) {
                throw new ParseException("field '" + key + "' must contain only strings, got " + typeName(item));
            }
            strings.add(text);
        }
        return strings;
    }

    private static String typeName(Object value) {
        if (value == null) return "null";
        if (value instanceof Map<?, ?>) return "object";
        if (value instanceof List<?>) return "array";
        if (value instanceof String) return "string";
        if (value instanceof Boolean) return "boolean";
        if (value instanceof Number) return "number";
        return value.getClass().getName();
    }

    /* ------------------------------------------------------------------ */
    /* Writer internals                                                    */
    /* ------------------------------------------------------------------ */

    private static void writeValue(StringBuilder out, Object value, int depth) {
        if (depth > MAX_DEPTH) {
            throw new IllegalArgumentException("cannot serialise JSON nested deeper than " + MAX_DEPTH);
        }
        if (value == null) {
            out.append("null");
        } else if (value instanceof String text) {
            writeString(out, text);
        } else if (value instanceof Boolean flag) {
            out.append(flag.booleanValue() ? "true" : "false");
        } else if (value instanceof Double || value instanceof Float) {
            double number = ((Number) value).doubleValue();
            if (!Double.isFinite(number)) {
                throw new IllegalArgumentException("cannot serialise non-finite number: " + number);
            }
            out.append(value instanceof Double ? Double.toString(number) : Float.toString(((Number) value).floatValue()));
        } else if (value instanceof Number number) {
            out.append(number.toString());
        } else if (value instanceof Map<?, ?> map) {
            out.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                if (!(entry.getKey() instanceof String key)) {
                    throw new IllegalArgumentException("JSON object keys must be strings, got " + typeName(entry.getKey()));
                }
                if (!first) out.append(',');
                first = false;
                writeString(out, key);
                out.append(':');
                writeValue(out, entry.getValue(), depth + 1);
            }
            out.append('}');
        } else if (value instanceof Iterable<?> items) {
            out.append('[');
            boolean first = true;
            for (Object item : items) {
                if (!first) out.append(',');
                first = false;
                writeValue(out, item, depth + 1);
            }
            out.append(']');
        } else if (value instanceof Object[] items) {
            out.append('[');
            for (int i = 0; i < items.length; i++) {
                if (i > 0) out.append(',');
                writeValue(out, items[i], depth + 1);
            }
            out.append(']');
        } else {
            throw new IllegalArgumentException("cannot serialise " + value.getClass().getName() + " to JSON");
        }
    }

    private static void writeString(StringBuilder out, String text) {
        out.append('"');
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            switch (c) {
                case '"' -> out.append("\\\"");
                case '\\' -> out.append("\\\\");
                case '\b' -> out.append("\\b");
                case '\f' -> out.append("\\f");
                case '\n' -> out.append("\\n");
                case '\r' -> out.append("\\r");
                case '\t' -> out.append("\\t");
                default -> {
                    if (c < 0x20) {
                        out.append(String.format("\\u%04x", (int) c));
                    } else {
                        out.append(c);
                    }
                }
            }
        }
        out.append('"');
    }

    /* ------------------------------------------------------------------ */
    /* Parser internals                                                    */
    /* ------------------------------------------------------------------ */

    /** Thrown when JSON text is malformed or violates the expected shape. */
    public static final class ParseException extends IllegalArgumentException {
        private static final long serialVersionUID = 1L;

        public ParseException(String message) {
            super(message);
        }
    }

    private static final class Parser {
        private final String src;
        private int pos;
        private int depth;

        Parser(String src) {
            this.src = src;
        }

        Object parseDocument() {
            skipWhitespace();
            Object value = parseValue();
            skipWhitespace();
            if (pos != src.length()) {
                throw error("unexpected trailing characters");
            }
            return value;
        }

        private Object parseValue() {
            char c = peek();
            return switch (c) {
                case '{' -> parseObject();
                case '[' -> parseArray();
                case '"' -> parseString();
                case 't' -> parseLiteral("true", Boolean.TRUE);
                case 'f' -> parseLiteral("false", Boolean.FALSE);
                case 'n' -> parseLiteral("null", null);
                default -> {
                    if (c == '-' || (c >= '0' && c <= '9')) {
                        yield parseNumber();
                    }
                    throw error("unexpected character '" + c + "'");
                }
            };
        }

        private Map<String, Object> parseObject() {
            expect('{');
            enter();
            Map<String, Object> object = new LinkedHashMap<>();
            skipWhitespace();
            if (peekOrEnd() == '}') {
                pos++;
                depth--;
                return object;
            }
            while (true) {
                skipWhitespace();
                if (peek() != '"') throw error("expected an object key");
                String key = parseString();
                skipWhitespace();
                expect(':');
                skipWhitespace();
                object.put(key, parseValue());
                skipWhitespace();
                char c = peek();
                if (c == ',') {
                    pos++;
                    continue;
                }
                if (c == '}') {
                    pos++;
                    depth--;
                    return object;
                }
                throw error("expected ',' or '}'");
            }
        }

        private List<Object> parseArray() {
            expect('[');
            enter();
            List<Object> array = new ArrayList<>();
            skipWhitespace();
            if (peekOrEnd() == ']') {
                pos++;
                depth--;
                return array;
            }
            while (true) {
                skipWhitespace();
                array.add(parseValue());
                skipWhitespace();
                char c = peek();
                if (c == ',') {
                    pos++;
                    continue;
                }
                if (c == ']') {
                    pos++;
                    depth--;
                    return array;
                }
                throw error("expected ',' or ']'");
            }
        }

        private String parseString() {
            expect('"');
            StringBuilder out = new StringBuilder();
            while (true) {
                if (pos >= src.length()) throw error("unterminated string");
                char c = src.charAt(pos++);
                if (c == '"') return out.toString();
                if (c == '\\') {
                    if (pos >= src.length()) throw error("unterminated escape sequence");
                    char escape = src.charAt(pos++);
                    switch (escape) {
                        case '"' -> out.append('"');
                        case '\\' -> out.append('\\');
                        case '/' -> out.append('/');
                        case 'b' -> out.append('\b');
                        case 'f' -> out.append('\f');
                        case 'n' -> out.append('\n');
                        case 'r' -> out.append('\r');
                        case 't' -> out.append('\t');
                        case 'u' -> out.append(parseUnicodeEscape());
                        default -> throw error("invalid escape '\\" + escape + "'");
                    }
                } else if (c < 0x20) {
                    throw error("unescaped control character U+" + String.format("%04x", (int) c) + " in string");
                } else {
                    out.append(c);
                }
            }
        }

        private char parseUnicodeEscape() {
            if (pos + 4 > src.length()) throw error("truncated \\u escape");
            int value = 0;
            for (int i = 0; i < 4; i++) {
                char c = src.charAt(pos++);
                int digit = Character.digit(c, 16);
                if (digit < 0) throw error("invalid hex digit '" + c + "' in \\u escape");
                value = (value << 4) | digit;
            }
            return (char) value;
        }

        private Object parseLiteral(String literal, Object value) {
            if (!src.startsWith(literal, pos)) throw error("invalid literal, expected '" + literal + "'");
            pos += literal.length();
            return value;
        }

        private Object parseNumber() {
            int start = pos;
            if (peekOrEnd() == '-') pos++;
            int digits = skipDigits();
            if (digits == 0) throw error("expected a digit");
            boolean fractional = false;
            if (pos < src.length() && src.charAt(pos) == '.') {
                pos++;
                if (skipDigits() == 0) throw error("expected a digit after '.'");
                fractional = true;
            }
            if (pos < src.length() && (src.charAt(pos) == 'e' || src.charAt(pos) == 'E')) {
                pos++;
                if (pos < src.length() && (src.charAt(pos) == '+' || src.charAt(pos) == '-')) pos++;
                if (skipDigits() == 0) throw error("expected a digit in exponent");
                fractional = true;
            }
            String lexeme = src.substring(start, pos);
            if (!fractional) {
                try {
                    return Long.parseLong(lexeme);
                } catch (NumberFormatException ignored) {
                    // Too large for a long: keep exact precision.
                    return new BigDecimal(lexeme);
                }
            }
            return Double.parseDouble(lexeme);
        }

        private int skipDigits() {
            int count = 0;
            while (pos < src.length() && src.charAt(pos) >= '0' && src.charAt(pos) <= '9') {
                pos++;
                count++;
            }
            return count;
        }

        private void enter() {
            depth++;
            if (depth > MAX_DEPTH) throw error("JSON nested deeper than " + MAX_DEPTH);
        }

        private void skipWhitespace() {
            while (pos < src.length()) {
                char c = src.charAt(pos);
                if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
                    pos++;
                } else {
                    return;
                }
            }
        }

        private void expect(char expected) {
            if (pos >= src.length()) throw error("unexpected end of input, expected '" + expected + "'");
            char actual = src.charAt(pos);
            if (actual != expected) throw error("expected '" + expected + "', got '" + actual + "'");
            pos++;
        }

        private char peek() {
            if (pos >= src.length()) throw error("unexpected end of input");
            return src.charAt(pos);
        }

        private char peekOrEnd() {
            return pos >= src.length() ? '\0' : src.charAt(pos);
        }

        private ParseException error(String message) {
            return new ParseException(message + " at offset " + pos);
        }
    }
}
