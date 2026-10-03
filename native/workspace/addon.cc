#include <node_api.h>
#include <string>
#include <vector>
#include <mutex>
#include <unordered_map>
#include <cctype>
#include <cstdint>
#include <limits>
#include "platform.h"

namespace {

std::mutex descriptor_mutex;
std::unordered_map<int32_t, int> root_descriptors;
std::unordered_map<int32_t, int> target_descriptors;
int32_t next_token = 1;

int32_t AllocateToken() {
  if (next_token == std::numeric_limits<int32_t>::max()) return -1;
  return next_token++;
}

int LookupDescriptor(int32_t token) {
  const auto root = root_descriptors.find(token);
  if (root != root_descriptors.end()) return root->second;
  const auto target = target_descriptors.find(token);
  return target == target_descriptors.end() ? -1 : target->second;
}

void SetString(napi_env env, napi_value target, const char* key, const char* value) {
  napi_value field;
  if (napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &field) != napi_ok) return;
  napi_set_named_property(env, target, key, field);
}

void ThrowDenied(napi_env env) {
  napi_throw_error(env, "WORKSPACE_OPEN_DENIED", "Workspace target could not be opened safely");
}

void ThrowOpenFailure(napi_env env) {
  napi_throw_error(env,
                   WorkspaceOpenUnavailable() ? "WORKSPACE_OPEN_UNAVAILABLE" : "WORKSPACE_OPEN_DENIED",
                   "Workspace target could not be opened safely");
}

bool ReadString(napi_env env, napi_value input, std::string* value) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, input, nullptr, 0, &length) != napi_ok || length > 4096) return false;
  value->assign(length + 1, '\0');
  if (napi_get_value_string_utf8(env, input, value->data(), value->size(), &length) != napi_ok) return false;
  value->resize(length);
  return value->find('\0') == std::string::npos;
}

napi_value OpenRoot(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  std::string path;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1 ||
      !ReadString(env, argv[0], &path) || path.empty()) {
    ThrowDenied(env); return nullptr;
  }
  const int fd = OpenWorkspaceRoot(path);
  if (fd < 0) { ThrowDenied(env); return nullptr; }
  std::lock_guard<std::mutex> guard(descriptor_mutex);
  const int32_t token = AllocateToken();
  napi_value result;
  if (token < 0 || napi_create_int32(env, token, &result) != napi_ok) {
    CloseWorkspaceDescriptor(fd); ThrowDenied(env); return nullptr;
  }
  root_descriptors.emplace(token, fd);
  return result;
}

bool SafeRelative(const std::string& value) {
  if (value.empty() || value.size() > 1024 || value[0] == '/' || value.find('\\') != std::string::npos ||
      value.find(':') != std::string::npos ||
      value.find('\0') != std::string::npos || (value.size() > 1 && value[1] == ':')) return false;
  if (value == ".") return true;
  size_t start = 0;
  while (start < value.size()) {
    const size_t end = value.find('/', start);
    const std::string part = value.substr(start, end == std::string::npos ? end : end - start);
    std::string lower = part;
    for (char& letter : lower) letter = static_cast<char>(std::tolower(static_cast<unsigned char>(letter)));
    if (part.empty() || part == "." || part == ".." || lower == ".git") return false;
    if (end == std::string::npos) return true;
    start = end + 1;
  }
  return false;
}

napi_value OpenRelative(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 3) {
    ThrowDenied(env);
    return nullptr;
  }
  int32_t root_token = -1;
  bool directory = false;
  std::string relative;
  if (napi_get_value_int32(env, argv[0], &root_token) != napi_ok ||
      !ReadString(env, argv[1], &relative) ||
      napi_get_value_bool(env, argv[2], &directory) != napi_ok) {
    ThrowDenied(env);
    return nullptr;
  }
  if (!SafeRelative(relative)) {
    ThrowDenied(env);
    return nullptr;
  }
  std::lock_guard<std::mutex> guard(descriptor_mutex);
  const auto root = root_descriptors.find(root_token);
  if (root == root_descriptors.end()) { ThrowDenied(env); return nullptr; }
  const int opened = OpenWorkspaceRelative(root->second, relative, directory);
  if (opened < 0) {
    ThrowOpenFailure(env);
    return nullptr;
  }
  const int32_t token = AllocateToken();
  napi_value result;
  if (token < 0 || napi_create_int32(env, token, &result) != napi_ok) {
    CloseWorkspaceDescriptor(opened);
    ThrowDenied(env);
    return nullptr;
  }
  target_descriptors.emplace(token, opened);
  return result;
}

napi_value OpenChild(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 4) {
    ThrowDenied(env); return nullptr;
  }
  int32_t root_token = -1;
  int32_t parent_token = -1;
  bool directory = false;
  std::string name;
  if (napi_get_value_int32(env, argv[0], &root_token) != napi_ok ||
      napi_get_value_int32(env, argv[1], &parent_token) != napi_ok ||
      !ReadString(env, argv[2], &name) ||
      napi_get_value_bool(env, argv[3], &directory) != napi_ok ||
      !SafeRelative(name) || name == "." || name.find('/') != std::string::npos) {
    ThrowDenied(env); return nullptr;
  }
  std::lock_guard<std::mutex> guard(descriptor_mutex);
  const auto root = root_descriptors.find(root_token);
  const auto parent = target_descriptors.find(parent_token);
  WorkspaceIdentity parent_identity = {};
  if (root == root_descriptors.end() || parent == target_descriptors.end() ||
      !GetWorkspaceIdentity(parent->second, &parent_identity) || !parent_identity.directory) {
    ThrowDenied(env); return nullptr;
  }
  const int opened = OpenWorkspaceChild(root->second, parent->second, name, directory);
  if (opened < 0) { ThrowOpenFailure(env); return nullptr; }
  const int32_t token = AllocateToken();
  napi_value result;
  if (token < 0 || napi_create_int32(env, token, &result) != napi_ok) {
    CloseWorkspaceDescriptor(opened); ThrowDenied(env); return nullptr;
  }
  target_descriptors.emplace(token, opened);
  return result;
}

napi_value ProbeWalk(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  int32_t root_token = -1;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1 ||
      napi_get_value_int32(env, argv[0], &root_token) != napi_ok) {
    ThrowDenied(env); return nullptr;
  }
  std::lock_guard<std::mutex> guard(descriptor_mutex);
  const auto root = root_descriptors.find(root_token);
  if (root == root_descriptors.end()) { ThrowDenied(env); return nullptr; }
  if (!ProbeWorkspaceWalk(root->second)) { ThrowOpenFailure(env); return nullptr; }
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

napi_value CloseDescriptor(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  int32_t token = -1;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1 ||
      napi_get_value_int32(env, argv[0], &token) != napi_ok || token < 0) {
    ThrowDenied(env); return nullptr;
  }
  {
    std::lock_guard<std::mutex> guard(descriptor_mutex);
    const int fd = LookupDescriptor(token);
    if (fd < 0) { ThrowDenied(env); return nullptr; }
    CloseWorkspaceDescriptor(fd);
    root_descriptors.erase(token);
    target_descriptors.erase(token);
  }
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

napi_value TargetPath(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  int32_t token = -1;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1 ||
      napi_get_value_int32(env, argv[0], &token) != napi_ok || token < 0) {
    ThrowDenied(env); return nullptr;
  }
  std::string path;
  {
    std::lock_guard<std::mutex> guard(descriptor_mutex);
    const int fd = LookupDescriptor(token);
    if (fd < 0) { ThrowDenied(env); return nullptr; }
    path = GetWorkspacePath(fd);
  }
  if (path.empty()) { ThrowDenied(env); return nullptr; }
  napi_value result;
  if (napi_create_string_utf8(env, path.c_str(), path.size(), &result) != napi_ok) {
    ThrowDenied(env); return nullptr;
  }
  return result;
}

napi_value TargetIdentity(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  int32_t token = -1;
  WorkspaceIdentity identity = {};
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1 ||
      napi_get_value_int32(env, argv[0], &token) != napi_ok || token < 0) {
    ThrowDenied(env); return nullptr;
  }
  {
    std::lock_guard<std::mutex> guard(descriptor_mutex);
    const int fd = LookupDescriptor(token);
    if (fd < 0 || !GetWorkspaceIdentity(fd, &identity)) { ThrowDenied(env); return nullptr; }
  }
  napi_value result;
  napi_create_object(env, &result);
  SetString(env, result, "device", std::to_string(identity.device).c_str());
  SetString(env, result, "inode", std::to_string(identity.inode).c_str());
  napi_value links, directory;
  napi_create_uint32(env, identity.links, &links);
  napi_get_boolean(env, identity.directory, &directory);
  napi_set_named_property(env, result, "links", links);
  napi_set_named_property(env, result, "directory", directory);
  return result;
}

napi_value ReadTarget(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  int32_t token = -1;
  uint32_t capacity = 0;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 2 ||
      napi_get_value_int32(env, argv[0], &token) != napi_ok || token < 0 ||
      napi_get_value_uint32(env, argv[1], &capacity) != napi_ok || capacity > 4 * 1024 * 1024) {
    ThrowDenied(env); return nullptr;
  }
  std::vector<char> buffer(capacity);
  int length;
  {
    std::lock_guard<std::mutex> guard(descriptor_mutex);
    const auto target = target_descriptors.find(token);
    if (target == target_descriptors.end()) { ThrowDenied(env); return nullptr; }
    length = ReadWorkspaceDescriptor(target->second, buffer.data(), capacity);
  }
  if (length < 0) { ThrowDenied(env); return nullptr; }
  napi_value result;
  if (napi_create_buffer_copy(env, static_cast<size_t>(length), buffer.data(), nullptr, &result) != napi_ok) {
    ThrowDenied(env); return nullptr;
  }
  return result;
}

napi_value ListDirectory(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  int32_t token = -1;
  uint32_t limit = 0;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 2 ||
      napi_get_value_int32(env, argv[0], &token) != napi_ok || token < 0 ||
      napi_get_value_uint32(env, argv[1], &limit) != napi_ok || limit > 1024) {
    ThrowDenied(env); return nullptr;
  }
  std::vector<std::string> names;
  {
    std::lock_guard<std::mutex> guard(descriptor_mutex);
    const auto target = target_descriptors.find(token);
    if (target == target_descriptors.end() || !ListWorkspaceDirectory(target->second, limit, &names)) {
      ThrowDenied(env); return nullptr;
    }
  }
  napi_value result;
  if (napi_create_array_with_length(env, names.size(), &result) != napi_ok) {
    ThrowDenied(env); return nullptr;
  }
  for (size_t index = 0; index < names.size(); ++index) {
    napi_value name;
    if (napi_create_string_utf8(env, names[index].c_str(), names[index].size(), &name) != napi_ok ||
        napi_set_element(env, result, static_cast<uint32_t>(index), name) != napi_ok) {
      ThrowDenied(env); return nullptr;
    }
  }
  return result;
}

void ExportFunction(napi_env env, napi_value exports, const char* name, napi_callback callback) {
  napi_value function;
  if (napi_create_function(env, name, NAPI_AUTO_LENGTH, callback, nullptr, &function) == napi_ok)
    napi_set_named_property(env, exports, name, function);
}

napi_value Initialize(napi_env env, napi_value exports) {
  napi_value abi;
  if (napi_create_uint32(env, 2, &abi) != napi_ok) return exports;
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
  SetString(env, exports, "capability", "identity-v2");
  ExportFunction(env, exports, "openRoot", OpenRoot);
  ExportFunction(env, exports, "openRelative", OpenRelative);
  ExportFunction(env, exports, "openChild", OpenChild);
  ExportFunction(env, exports, "probeWalk", ProbeWalk);
  ExportFunction(env, exports, "closeDescriptor", CloseDescriptor);
  ExportFunction(env, exports, "targetPath", TargetPath);
  ExportFunction(env, exports, "targetIdentity", TargetIdentity);
  ExportFunction(env, exports, "readTarget", ReadTarget);
  ExportFunction(env, exports, "listDirectory", ListDirectory);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Initialize)
