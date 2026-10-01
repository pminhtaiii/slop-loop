#include <node_api.h>

namespace {

void SetString(napi_env env, napi_value target, const char* key, const char* value) {
  napi_value field;
  if (napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &field) != napi_ok) return;
  napi_set_named_property(env, target, key, field);
}

napi_value Initialize(napi_env env, napi_value exports) {
  napi_value abi;
  if (napi_create_uint32(env, 1, &abi) != napi_ok) return exports;
  napi_set_named_property(env, exports, "abi", abi);
#if defined(_WIN32)
  SetString(env, exports, "platform", "win32");
#elif defined(__linux__)
  SetString(env, exports, "platform", "linux");
#else
  SetString(env, exports, "platform", "unsupported");
#endif
#if defined(_M_X64) || defined(__x86_64__)
  SetString(env, exports, "arch", "x64");
#elif defined(_M_ARM64) || defined(__aarch64__)
  SetString(env, exports, "arch", "arm64");
#else
  SetString(env, exports, "arch", "unsupported");
#endif
  SetString(env, exports, "capability", "identity-v1");
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Initialize)
