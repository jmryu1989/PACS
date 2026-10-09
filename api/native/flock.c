#include <node_api.h>
#include <sys/file.h>
#include <errno.h>

/* The Node process owns the descriptor for its lifetime. EINTR does not abandon
 * acquisition; OS process death releases every lock without a lease or PID test. */
static napi_value lock_file(napi_env env, napi_callback_info info) {
    size_t argc = 3;
    napi_value args[3], result;
    int32_t fd;
    bool exclusive, probe = false;
    if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc < 2 ||
        napi_get_value_int32(env, args[0], &fd) != napi_ok || fd < 0 ||
        napi_get_value_bool(env, args[1], &exclusive) != napi_ok) {
        napi_throw_type_error(env, "SealUnavailable", "Invalid lock arguments");
        return NULL;
    }
    if (argc == 3 && napi_get_value_bool(env, args[2], &probe) != napi_ok) {
        napi_throw_type_error(env, "SealUnavailable", "Invalid lock probe"); return NULL;
    }
    int rc;
    do { rc = flock(fd, (exclusive ? LOCK_EX : LOCK_UN) | (probe ? LOCK_NB : 0)); } while (rc < 0 && errno == EINTR);
    if (rc < 0 && probe && errno == EWOULDBLOCK) { napi_get_boolean(env, false, &result); return result; }
    if (rc < 0) {
        napi_throw_error(env, "SealUnavailable", "Protected state lock unavailable");
        return NULL;
    }
    napi_get_boolean(env, true, &result);
    return result;
}
static napi_value initialize(napi_env env, napi_value exports) {
    napi_value fn;
    napi_create_function(env, "flock", NAPI_AUTO_LENGTH, lock_file, NULL, &fn);
    napi_set_named_property(env, exports, "flock", fn);
    return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
