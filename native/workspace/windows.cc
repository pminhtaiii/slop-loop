#if defined(_WIN32)
#include <windows.h>
#include <winternl.h>
#include <io.h>
#include <fcntl.h>
#include <string>
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

static bool IsDirectory(HANDLE handle) {
  BY_HANDLE_FILE_INFORMATION info;
  return GetFileInformationByHandle(handle, &info) &&
         (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
}

static bool SafeHandle(HANDLE handle, bool directory) {
  FILE_ATTRIBUTE_TAG_INFO tag;
  if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &tag, sizeof(tag))) return false;
  if ((tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) { SetLastError(ERROR_ACCESS_DENIED); return false; }
  if (IsDirectory(handle) != directory) { SetLastError(ERROR_ACCESS_DENIED); return false; }
  if (!directory) {
    BY_HANDLE_FILE_INFORMATION info;
    if (!GetFileInformationByHandle(handle, &info)) return false;
    if (info.nNumberOfLinks != 1) { SetLastError(ERROR_ACCESS_DENIED); return false; }
  }
  return true;
}

int OpenWorkspaceRelative(int root_fd, const std::string& relative, bool directory) {
  if (root_fd < 0) return -1;
  if (relative == ".") return directory ? _dup(root_fd) : -1;
  const intptr_t raw = _get_osfhandle(root_fd);
  if (raw == -1) { SetLastError(ERROR_INVALID_HANDLE); return -1; }
  HANDLE parent = reinterpret_cast<HANDLE>(raw);
  const HMODULE module = GetModuleHandleW(L"ntdll.dll");
  if (!module) { SetLastError(ERROR_NOT_SUPPORTED); return -1; }
  const auto nt_create = reinterpret_cast<NtCreateFileFunction>(GetProcAddress(module, "NtCreateFile"));
  if (!nt_create) { SetLastError(ERROR_NOT_SUPPORTED); return -1; }
  size_t start = 0;
  while (true) {
    const size_t end = relative.find('/', start);
    const std::string part = relative.substr(start, end == std::string::npos ? end : end - start);
    const int needed = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, part.data(),
                                            static_cast<int>(part.size()), nullptr, 0);
    if (needed <= 0 || needed > 32767) {
      if (parent != reinterpret_cast<HANDLE>(raw)) CloseHandle(parent);
      return -1;
    }
    std::wstring wide(static_cast<size_t>(needed), L'\0');
    if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, part.data(),
                            static_cast<int>(part.size()), wide.data(), needed) != needed) {
      if (parent != reinterpret_cast<HANDLE>(raw)) CloseHandle(parent);
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
    const bool final = end == std::string::npos;
    const bool want_directory = !final || directory;
    const ULONG options = FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT |
                          (want_directory ? FILE_DIRECTORY_FILE : FILE_NON_DIRECTORY_FILE);
    const NTSTATUS outcome = nt_create(&child, FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                                       &attributes, &status, nullptr, FILE_ATTRIBUTE_NORMAL,
                                       FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                                       FILE_OPEN, options, nullptr, 0);
    if (parent != reinterpret_cast<HANDLE>(raw)) CloseHandle(parent);
    if (outcome < 0) {
      const auto to_dos = reinterpret_cast<ULONG(WINAPI*)(NTSTATUS)>(GetProcAddress(module, "RtlNtStatusToDosError"));
      SetLastError(to_dos == nullptr ? ERROR_NOT_SUPPORTED : to_dos(outcome));
      return -1;
    }
    if (!SafeHandle(child, want_directory)) {
      const DWORD failure = GetLastError();
      CloseHandle(child);
      SetLastError(failure);
      return -1;
    }
    if (final) {
      const int fd = _open_osfhandle(reinterpret_cast<intptr_t>(child), _O_RDONLY | _O_BINARY);
      if (fd < 0) CloseHandle(child);
      return fd;
    }
    parent = child;
    start = end + 1;
  }
}

void CloseWorkspaceDescriptor(int fd) { _close(fd); }

int ReadWorkspaceDescriptor(int fd, char* output, unsigned int capacity) {
  return _read(fd, output, capacity);
}

bool GetWorkspaceIdentity(int fd, WorkspaceIdentity* identity) {
  if (fd < 0) return false;
  BY_HANDLE_FILE_INFORMATION information;
  if (!GetFileInformationByHandle(reinterpret_cast<HANDLE>(_get_osfhandle(fd)), &information)) return false;
  identity->device = information.dwVolumeSerialNumber;
  identity->inode = (static_cast<uint64_t>(information.nFileIndexHigh) << 32) | information.nFileIndexLow;
  identity->links = information.nNumberOfLinks;
  identity->directory = (information.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
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
