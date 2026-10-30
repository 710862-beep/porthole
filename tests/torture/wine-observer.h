/* Porthole harness observer. Included into a generated copy of Wine test.h.
 * Upstream test sources are untouched; assertion accounting remains winetest_ok(). */
static void porthole_json_string(char *out, size_t cap, const char *text)
{
    size_t j = 0;
    if (!cap) return;
    out[j++] = '"';
    for (const unsigned char *p = (const unsigned char *)text; p && *p && j + 7 < cap - 1; ++p) {
        if (*p == '"' || *p == '\\') { out[j++] = '\\'; out[j++] = *p; }
        else if (*p == '\n') { out[j++] = '\\'; out[j++] = 'n'; }
        else if (*p == '\r') { out[j++] = '\\'; out[j++] = 'r'; }
        else if (*p == '\t') { out[j++] = '\\'; out[j++] = 't'; }
        else if (*p < 0x20) j += snprintf(out + j, cap - j, "\\u%04x", *p);
        else out[j++] = *p;
    }
    out[j++] = '"'; out[j] = 0;
}
static void porthole_assert_emit(const char *file, int line, const char *expr, int actual, const char *fmt, ...)
{
    winetest_set_location(file, line);
    struct winetest_thread_data *data = winetest_get_thread_data();
    char message[4096], expr_json[8192], msg_json[16384], file_json[4096];
    char json[32768], debug[33000];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(message, sizeof(message), fmt, ap);
    va_end(ap);
    if (!actual || (data->todo_level && actual)) {
        porthole_json_string(expr_json, sizeof(expr_json), expr);
        porthole_json_string(msg_json, sizeof(msg_json), message);
        porthole_json_string(file_json, sizeof(file_json), data->current_file ? data->current_file : file);
        const char *kind = data->todo_level ? (actual ? "todo-success" : "todo-failure") : "assertion";
        snprintf(json, sizeof(json),
            "{\"kind\":\"%s\",\"expression\":%s,\"expected\":true,\"actual\":%s,\"message\":%s,"
            "\"file\":%s,\"line\":%d,\"todo\":%d,\"flaky\":%u}",
            kind, expr_json, actual ? "true" : "false",
            msg_json, file_json, line, data->todo_level, data->flaky_level);
        snprintf(debug, sizeof(debug), "PORTHOLE_ASSERT %s", json);
        OutputDebugStringA(debug);
        printf("%s\n", debug);
    }
    winetest_ok(actual, "%s", message);
}
static void porthole_assert_explicit(int actual, const char *fmt, ...)
{
    struct winetest_thread_data *data = winetest_get_thread_data();
    char message[4096];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(message, sizeof(message), fmt, ap);
    va_end(ap);
    porthole_assert_emit(data->current_file ? data->current_file : "(unknown)",
                         data->current_line, "(explicit ok_)", actual, "%s", message);
}
#define PORTHOLE_OK(file, line, cond, ...) porthole_assert_emit(file, line, #cond, !!(cond), __VA_ARGS__)
#undef ok_
#define ok_(file, line) (winetest_set_location(file, line), 0) ? (void)0 : porthole_assert_explicit
#undef ok
#define ok(...) PORTHOLE_OK(__FILE__, __LINE__, __VA_ARGS__)
