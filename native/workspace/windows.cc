#if defined(_WIN32)
#include <windows.h>
#include <winternl.h>
#include <winioctl.h>
#include <io.h>
#include <fcntl.h>
#include <algorithm>
#include <cstddef>
#include <string>
#include <vector>
#include <cwctype>
#include "platform.h"

static bool SafeHandle(HANDLE handle, bool directory);

static std::wstring DecodeUtf8(const std::string& source) {
  const int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, source.data(),
                                         static_cast<int>(source.size()), nullptr, 0);
  if (length <= 0) return {};
  std::wstring result(static_cast<size_t>(length), L'\0');
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, source.data(),
                          static_cast<int>(source.size()), result.data(), length) != length) return {};
  return result;
}

int OpenWorkspaceRoot(const std::string& path) {
  const std::wstring wide = DecodeUtf8(path);
  if (wide.empty()) return -1;
  const HANDLE handle = CreateFileW(wide.c_str(), FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY | SYNCHRONIZE,
                                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
                                    OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (handle == INVALID_HANDLE_VALUE || !SafeHandle(handle, true)) {
    if (handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
    return -1;
  }
  const int fd = _open_osfhandle(reinterpret_cast<intptr_t>(handle), _O_RDONLY | _O_BINARY);
  if (fd < 0) CloseHandle(handle);
  return fd;
}

using NtCreateFileFunction = NTSTATUS(NTAPI*)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES,
                                              PIO_STATUS_BLOCK, PLARGE_INTEGER, ULONG, ULONG,
                                              ULONG, ULONG, PVOID, ULONG);

bool ProbeWorkspaceWalk(int root_fd) {
  if (root_fd < 0) { SetLastError(ERROR_INVALID_HANDLE); return false; }
  const intptr_t raw = _get_osfhandle(root_fd);
  if (raw == -1) { SetLastError(ERROR_INVALID_HANDLE); return false; }
  const HMODULE module = GetModuleHandleW(L"ntdll.dll");
  if (!module) { SetLastError(ERROR_NOT_SUPPORTED); return false; }
  const auto nt_create = reinterpret_cast<NtCreateFileFunction>(GetProcAddress(module, "NtCreateFile"));
  if (!nt_create) { SetLastError(ERROR_NOT_SUPPORTED); return false; }
  std::wstring child_name = L".git";
  UNICODE_STRING name;
  name.Length = static_cast<USHORT>(child_name.size() * sizeof(wchar_t));
  name.MaximumLength = name.Length;
  name.Buffer = child_name.data();
  OBJECT_ATTRIBUTES attributes;
  InitializeObjectAttributes(&attributes, &name, OBJ_CASE_INSENSITIVE,
                             reinterpret_cast<HANDLE>(raw), nullptr);
  IO_STATUS_BLOCK status;
  HANDLE child = INVALID_HANDLE_VALUE;
  const NTSTATUS outcome = nt_create(&child, FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                                     &attributes, &status, nullptr, FILE_ATTRIBUTE_NORMAL,
                                     FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                                     FILE_OPEN, FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
                                     nullptr, 0);
  if (outcome < 0) {
    const auto to_dos = reinterpret_cast<ULONG(WINAPI*)(NTSTATUS)>(GetProcAddress(module, "RtlNtStatusToDosError"));
    SetLastError(to_dos == nullptr ? ERROR_NOT_SUPPORTED : to_dos(outcome));
    return false;
  }
  CloseHandle(child);
  return true;
}

static bool SafeHandle(HANDLE handle, bool directory) {
  FILE_ATTRIBUTE_TAG_INFO tag;
  if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &tag, sizeof(tag))) return false;
  if ((tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) { SetLastError(ERROR_ACCESS_DENIED); return false; }
  BY_HANDLE_FILE_INFORMATION info;
  if (!GetFileInformationByHandle(handle, &info)) return false;
  if (((info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) != directory) {
    SetLastError(ERROR_ACCESS_DENIED); return false;
  }
  if (!directory) {
    if (info.nNumberOfLinks != 1) { SetLastError(ERROR_ACCESS_DENIED); return false; }
  }
  return true;
}

static bool NormalizeParts(const std::string& raw, std::vector<std::string>* parts,
                           size_t verified_prefix = 0) {
  parts->clear();
  if (raw.empty() || raw.size() > 4096 || raw[0] == '/') return false;
  size_t start = 0;
  while (start < raw.size()) {
    const size_t end = raw.find('/', start);
    const std::string part = raw.substr(start, end == std::string::npos ? end : end - start);
    if (part == "..") {
      // Never erase a target component that has not been opened and checked.
      if (parts->empty() || parts->size() > verified_prefix) return false;
      parts->pop_back();
      --verified_prefix;
    } else if (!part.empty() && part != ".") {
      if (part.find('\\') != std::string::npos || part.find(':') != std::string::npos ||
          part.find('\0') != std::string::npos)
        return false;
      parts->push_back(part);
    }
    if (end == std::string::npos) break;
    start = end + 1;
  }
  return true;
}

struct SymlinkReparseData {
  DWORD tag;
  WORD length;
  WORD reserved;
  WORD substitute_offset;
  WORD substitute_length;
  WORD print_offset;
  WORD print_length;
  ULONG flags;
  WCHAR path[1];
};

static bool RelativeSymlinkTarget(HANDLE link, const std::wstring& root,
                                  const std::vector<std::string>& prefix, std::string* target,
                                  bool* absolute) {
  alignas(SymlinkReparseData) char data[MAXIMUM_REPARSE_DATA_BUFFER_SIZE];
  DWORD length = 0;
  if (!DeviceIoControl(link, FSCTL_GET_REPARSE_POINT, nullptr, 0, data, sizeof(data),
                       &length, nullptr)) {
    SetLastError(ERROR_NOT_SUPPORTED);
    return false;
  }
  SetLastError(ERROR_ACCESS_DENIED);
  const auto* reparse = reinterpret_cast<const SymlinkReparseData*>(data);
  if (reparse->tag != IO_REPARSE_TAG_SYMLINK ||
      length < offsetof(SymlinkReparseData, path)) return false;
  const size_t offset = reparse->substitute_offset;
  const size_t size = reparse->substitute_length;
  const size_t base = offsetof(SymlinkReparseData, path);
  if (offset % sizeof(wchar_t) != 0 || size % sizeof(wchar_t) != 0 ||
      base + offset + size > length || size == 0) return false;
  std::wstring wide(reparse->path + offset / sizeof(wchar_t), size / sizeof(wchar_t));
  const bool relative = (reparse->flags & 1UL) != 0;
  *absolute = !relative;
  if (!relative) {
    if (wide.rfind(L"\\??\\", 0) == 0 || wide.rfind(L"\\\\?\\", 0) == 0)
      wide.erase(0, 4);
    std::wstring physical = root;
    if (physical.rfind(L"\\\\?\\", 0) == 0) physical.erase(0, 4);
    const auto equal = [](wchar_t left, wchar_t right) { return towlower(left) == towlower(right); };
    if (wide.size() < physical.size() ||
        !std::equal(physical.begin(), physical.end(), wide.begin(), equal) ||
        (wide.size() > physical.size() && wide[physical.size()] != L'\\')) return false;
    wide.erase(0, physical.size());
    if (!wide.empty()) wide.erase(0, 1);
  } else if (wide[0] == L'\\' || wide[0] == L'/') {
    return false;
  }
  std::replace(wide.begin(), wide.end(), L'\\', L'/');
  const int needed = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide.data(),
                                         static_cast<int>(wide.size()), nullptr, 0, nullptr, nullptr);
  if (needed < 0 || (needed == 0 && !wide.empty())) return false;
  std::string utf8(static_cast<size_t>(needed), '\0');
  if (needed > 0 && WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide.data(),
                                        static_cast<int>(wide.size()), utf8.data(), needed,
                                        nullptr, nullptr) != needed) return false;
  target->clear();
  if (relative) for (const auto& part : prefix) *target += part + "/";
  *target += utf8.empty() ? "." : utf8;
  return true;
}

static int OpenWorkspaceFrom(int root_fd, int start_fd, const std::string& relative, bool directory) {
  if (root_fd < 0 || start_fd < 0) { SetLastError(ERROR_INVALID_HANDLE); return -1; }
  if (relative == ".") {
    if (!directory) { SetLastError(ERROR_ACCESS_DENIED); return -1; }
  }
  const intptr_t raw = _get_osfhandle(root_fd);
  if (raw == -1) { SetLastError(ERROR_INVALID_HANDLE); return -1; }
  const intptr_t start_raw = _get_osfhandle(start_fd);
  if (start_raw == -1) { SetLastError(ERROR_INVALID_HANDLE); return -1; }
  HANDLE parent = reinterpret_cast<HANDLE>(start_raw);
  bool owns_parent = false;
  const HMODULE module = GetModuleHandleW(L"ntdll.dll");
  if (!module) { SetLastError(ERROR_NOT_SUPPORTED); return -1; }
  const auto nt_create = reinterpret_cast<NtCreateFileFunction>(GetProcAddress(module, "NtCreateFile"));
  if (!nt_create) { SetLastError(ERROR_NOT_SUPPORTED); return -1; }
  if (relative == ".") {
    const int copy = _dup(start_fd);
    if (copy < 0) SetLastError(ERROR_TOO_MANY_OPEN_FILES);
    return copy;
  }
  std::vector<std::string> parts;
  if (!NormalizeParts(relative, &parts) || parts.empty()) { SetLastError(ERROR_ACCESS_DENIED); return -1; }
  const std::wstring root_path = DecodeUtf8(GetWorkspacePath(root_fd));
  if (root_path.empty()) { SetLastError(ERROR_INVALID_HANDLE); return -1; }
  std::vector<std::string> prefix;
  const std::wstring start_path = DecodeUtf8(GetWorkspacePath(start_fd));
  const auto equal = [](wchar_t left, wchar_t right) { return towlower(left) == towlower(right); };
  if (start_path.empty() || start_path.size() < root_path.size() ||
      !std::equal(root_path.begin(), root_path.end(), start_path.begin(), equal) ||
      (start_path.size() > root_path.size() && start_path[root_path.size()] != L'\\')) {
    SetLastError(ERROR_ACCESS_DENIED); return -1;
  }
  if (start_path.size() > root_path.size()) {
    const std::wstring suffix = start_path.substr(root_path.size() + 1);
    const int bytes = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, suffix.data(),
                                          static_cast<int>(suffix.size()), nullptr, 0, nullptr, nullptr);
    if (bytes <= 0) { SetLastError(ERROR_ACCESS_DENIED); return -1; }
    std::string utf8(static_cast<size_t>(bytes), '\0');
    if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, suffix.data(),
                            static_cast<int>(suffix.size()), utf8.data(), bytes,
                            nullptr, nullptr) != bytes) { SetLastError(ERROR_ACCESS_DENIED); return -1; }
    std::replace(utf8.begin(), utf8.end(), '\\', '/');
    size_t from = 0;
    while (from < utf8.size()) {
      const size_t to = utf8.find('/', from);
      prefix.push_back(utf8.substr(from, to == std::string::npos ? to : to - from));
      if (to == std::string::npos) break;
      from = to + 1;
    }
  }
  size_t index = 0;
  unsigned int links = 0;
  while (index < parts.size()) {
    const std::string part = parts[index];
    const int needed = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, part.data(),
                                            static_cast<int>(part.size()), nullptr, 0);
    if (needed <= 0 || needed > 32767) {
      SetLastError(ERROR_ACCESS_DENIED);
      if (owns_parent) CloseHandle(parent);
      return -1;
    }
    std::wstring wide(static_cast<size_t>(needed), L'\0');
    if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, part.data(),
                            static_cast<int>(part.size()), wide.data(), needed) != needed) {
      SetLastError(ERROR_ACCESS_DENIED);
      if (owns_parent) CloseHandle(parent);
      return -1;
    }
    UNICODE_STRING name;
    name.Length = static_cast<USHORT>(wide.size() * sizeof(wchar_t));
    name.MaximumLength = name.Length;
    name.Buffer = wide.data();
    OBJECT_ATTRIBUTES attributes;
    InitializeObjectAttributes(&attributes, &name, OBJ_CASE_INSENSITIVE, parent, nullptr);
    IO_STATUS_BLOCK status;
    HANDLE child = INVALID_HANDLE_VALUE;
    const bool final = index + 1 == parts.size();
    const bool want_directory = !final || directory;
    const ULONG options = FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT;
    const NTSTATUS outcome = nt_create(&child, FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                                       &attributes, &status, nullptr, FILE_ATTRIBUTE_NORMAL,
                                       FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                                       FILE_OPEN, options, nullptr, 0);
    if (outcome < 0) {
      if (owns_parent) CloseHandle(parent);
      const auto to_dos = reinterpret_cast<ULONG(WINAPI*)(NTSTATUS)>(GetProcAddress(module, "RtlNtStatusToDosError"));
      SetLastError(to_dos == nullptr ? ERROR_NOT_SUPPORTED : to_dos(outcome));
      return -1;
    }
    FILE_ATTRIBUTE_TAG_INFO tag;
    if (!GetFileInformationByHandleEx(child, FileAttributeTagInfo, &tag, sizeof(tag))) {
      const DWORD failure = GetLastError();
      CloseHandle(child);
      if (owns_parent) CloseHandle(parent);
      SetLastError(failure);
      return -1;
    }
    if ((tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
      std::string expanded;
      bool absolute = false;
      SetLastError(ERROR_ACCESS_DENIED);
      const bool safe = tag.ReparseTag == IO_REPARSE_TAG_SYMLINK && links++ < 40 &&
                        RelativeSymlinkTarget(child, root_path, prefix, &expanded, &absolute);
      const DWORD failure = GetLastError();
      CloseHandle(child);
      if (owns_parent) CloseHandle(parent);
      if (!safe) { SetLastError(failure); return -1; }
      for (size_t remaining = index + 1; remaining < parts.size(); ++remaining)
        expanded += "/" + parts[remaining];
      std::vector<std::string> resolved;
      if (!NormalizeParts(expanded, &resolved, absolute ? 0 : prefix.size())) {
        SetLastError(ERROR_ACCESS_DENIED); return -1;
      }
      if (resolved.empty()) {
        if (directory) {
          const int copy = _dup(root_fd);
          if (copy < 0) SetLastError(ERROR_TOO_MANY_OPEN_FILES);
          return copy;
        }
        SetLastError(ERROR_ACCESS_DENIED);
        return -1;
      }
      parts.swap(resolved);
      prefix.clear();
      parent = reinterpret_cast<HANDLE>(raw);
      owns_parent = false;
      index = 0;
      continue;
    }
    if (!SafeHandle(child, want_directory)) {
      const DWORD failure = GetLastError();
      CloseHandle(child);
      if (owns_parent) CloseHandle(parent);
      SetLastError(failure);
      return -1;
    }
    if (final) {
      if (owns_parent) CloseHandle(parent);
      const int fd = _open_osfhandle(reinterpret_cast<intptr_t>(child), _O_RDONLY | _O_BINARY);
      if (fd < 0) CloseHandle(child);
      return fd;
    }
    if (owns_parent) CloseHandle(parent);
    parent = child;
    owns_parent = true;
    prefix.push_back(part);
    ++index;
  }
  if (owns_parent) CloseHandle(parent);
  SetLastError(ERROR_ACCESS_DENIED);
  return -1;
}

int OpenWorkspaceRelative(int root_fd, const std::string& relative, bool directory) {
  return OpenWorkspaceFrom(root_fd, root_fd, relative, directory);
}

int OpenWorkspaceChild(int root_fd, int parent_fd, const std::string& name, bool directory) {
  return OpenWorkspaceFrom(root_fd, parent_fd, name, directory);
}

void CloseWorkspaceDescriptor(int fd) { _close(fd); }

int ReadWorkspaceDescriptor(int fd, char* output, unsigned int capacity) {
  if (_lseeki64(fd, 0, SEEK_SET) < 0) return -1;
  unsigned int total = 0;
  while (total < capacity) {
    const int length = _read(fd, output + total, capacity - total);
    if (length > 0) { total += static_cast<unsigned int>(length); continue; }
    if (length == 0) break;
    return -1;
  }
  return static_cast<int>(total);
}

bool GetWorkspaceIdentity(int fd, WorkspaceIdentity* identity) {
  if (fd < 0) return false;
  BY_HANDLE_FILE_INFORMATION information;
  if (!GetFileInformationByHandle(reinterpret_cast<HANDLE>(_get_osfhandle(fd)), &information)) return false;
  identity->device = information.dwVolumeSerialNumber;
  identity->inode = (static_cast<uint64_t>(information.nFileIndexHigh) << 32) | information.nFileIndexLow;
  identity->links = information.nNumberOfLinks;
  identity->directory = (information.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
  identity->size = (static_cast<uint64_t>(information.nFileSizeHigh) << 32) | information.nFileSizeLow;
  identity->mode = (information.dwFileAttributes & FILE_ATTRIBUTE_READONLY) ? 0444 : 0644;
  return true;
}

std::string GetWorkspacePath(int fd) {
  if (fd < 0) return {};
  const HANDLE handle = reinterpret_cast<HANDLE>(_get_osfhandle(fd));
  wchar_t wide[4096];
  const DWORD length = GetFinalPathNameByHandleW(handle, wide, 4096, FILE_NAME_NORMALIZED);
  if (length == 0 || length >= 4096) return {};
  const int bytes = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide,
                                        static_cast<int>(length), nullptr, 0, nullptr, nullptr);
  if (bytes <= 0) return {};
  std::string result(static_cast<size_t>(bytes), '\0');
  if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide, static_cast<int>(length),
                          result.data(), bytes, nullptr, nullptr) != bytes) return {};
  return result;
}

bool ListWorkspaceDirectory(int fd, unsigned int limit, std::vector<std::string>* names) {
  if (fd < 0) return false;
  if (limit == 0) return true;
  const HANDLE handle = reinterpret_cast<HANDLE>(_get_osfhandle(fd));
  alignas(FILE_ID_BOTH_DIR_INFO) char buffer[64 * 1024];
  bool first = true;
  while (names->size() < limit) {
    const FILE_INFO_BY_HANDLE_CLASS info_class = first
      ? FileIdBothDirectoryRestartInfo : FileIdBothDirectoryInfo;
    first = false;
    if (!GetFileInformationByHandleEx(handle, info_class, buffer, sizeof(buffer))) {
      return GetLastError() == ERROR_NO_MORE_FILES;
    }
    auto* entry = reinterpret_cast<FILE_ID_BOTH_DIR_INFO*>(buffer);
    while (entry != nullptr && names->size() < limit) {
      const int chars = static_cast<int>(entry->FileNameLength / sizeof(wchar_t));
      const int bytes = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, entry->FileName,
                                            chars, nullptr, 0, nullptr, nullptr);
      if (bytes <= 0) return false;
      std::string name(static_cast<size_t>(bytes), '\0');
      if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, entry->FileName, chars,
                              name.data(), bytes, nullptr, nullptr) != bytes) return false;
      if (name != "." && name != "..") names->push_back(name);
      if (entry->NextEntryOffset == 0) break;
      entry = reinterpret_cast<FILE_ID_BOTH_DIR_INFO*>(reinterpret_cast<char*>(entry) + entry->NextEntryOffset);
    }
  }
  return true;
}

bool WorkspaceOpenUnavailable() {
  const DWORD error = GetLastError();
  return error != ERROR_FILE_NOT_FOUND && error != ERROR_PATH_NOT_FOUND &&
         error != ERROR_ACCESS_DENIED && error != ERROR_DIRECTORY &&
         error != ERROR_CANT_ACCESS_FILE && error != ERROR_INVALID_REPARSE_DATA;
}
#endif
