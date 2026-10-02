#if defined(__linux__)
#include <fcntl.h>
#include <linux/openat2.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>
#include <dirent.h>
#include <cerrno>
#include <string>
#include <vector>
#include "platform.h"

int OpenWorkspaceRoot(const std::string& path) {
  return open(path.c_str(), O_RDONLY | O_CLOEXEC | O_DIRECTORY);
}

static int OpenComponent(int parent, const std::string& name, uint64_t flags) {
  struct open_how how = {};
  how.flags = flags | O_CLOEXEC | O_NOFOLLOW;
  how.resolve = RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV;
  return static_cast<int>(syscall(SYS_openat2, parent, name.c_str(), &how, sizeof(how)));
}

static bool NormalizePath(const std::string& raw, std::vector<std::string>* components,
                          size_t verified_prefix = 0) {
  components->clear();
  if (raw.empty() || raw.size() > 4096 || raw[0] == '/') return false;
  size_t start = 0;
  while (start < raw.size()) {
    const size_t end = raw.find('/', start);
    const std::string part = raw.substr(start, end == std::string::npos ? end : end - start);
    if (part == "..") {
      // A target's name/.. must not erase a mount, missing entry, or reparse point
      // that has not yet been opened. Only held, already-inspected parents may pop.
      if (components->empty() || components->size() > verified_prefix) return false;
      components->pop_back();
      --verified_prefix;
    } else if (!part.empty() && part != ".") {
      components->push_back(part);
    }
    if (end == std::string::npos) break;
    start = end + 1;
  }
  return true;
}

int OpenWorkspaceRelative(int root_fd, const std::string& relative, bool directory) {
  if (root_fd < 0) return -1;
  if (relative == ".") return directory ? dup(root_fd) : -1;
  std::vector<std::string> parts;
  if (!NormalizePath(relative, &parts) || parts.empty()) { errno = EACCES; return -1; }
  const std::string root_path = GetWorkspacePath(root_fd);
  if (root_path.empty()) { errno = EIO; return -1; }
  int parent = root_fd;
  std::vector<std::string> prefix;
  unsigned int links = 0;
  size_t index = 0;
  while (index < parts.size()) {
    const std::string name = parts[index];
    const int entry = OpenComponent(parent, name, O_PATH);
    if (entry < 0) break;
    struct stat inspected;
    if (fstat(entry, &inspected) < 0) { close(entry); break; }
    if (S_ISLNK(inspected.st_mode)) {
      if (++links > 40) { close(entry); errno = ELOOP; break; }
      char link[4097];
      const ssize_t count = readlinkat(entry, "", link, sizeof(link));
      close(entry);
      if (count < 0) { errno = EIO; break; }
      if (count == 0 || count >= static_cast<ssize_t>(sizeof(link))) { errno = EACCES; break; }
      const std::string target(link, static_cast<size_t>(count));
      std::string expanded;
      if (target[0] == '/') {
        if (target == root_path) expanded = ".";
        else if (target.compare(0, root_path.size(), root_path) == 0 &&
                 target.size() > root_path.size() && target[root_path.size()] == '/')
          expanded = target.substr(root_path.size() + 1);
        else { errno = EXDEV; break; }
      } else {
        for (const std::string& component : prefix) expanded += component + "/";
        expanded += target;
      }
      for (size_t remaining = index + 1; remaining < parts.size(); ++remaining)
        expanded += "/" + parts[remaining];
      std::vector<std::string> resolved;
      if (!NormalizePath(expanded, &resolved, target[0] == '/' ? 0 : prefix.size())) {
        errno = EACCES; break;
      }
      if (resolved.empty()) {
        if (parent != root_fd) close(parent);
        return directory ? dup(root_fd) : -1;
      }
      if (parent != root_fd) close(parent);
      parent = root_fd;
      prefix.clear();
      parts.swap(resolved);
      index = 0;
      continue;
    }
    const bool final = index + 1 == parts.size();
    if (!final) {
      if (!S_ISDIR(inspected.st_mode)) { close(entry); errno = ENOTDIR; break; }
      if (parent != root_fd) close(parent);
      parent = entry;
      prefix.push_back(name);
      ++index;
      continue;
    }
    if (directory ? !S_ISDIR(inspected.st_mode) : !S_ISREG(inspected.st_mode) || inspected.st_nlink != 1) {
      close(entry); errno = EACCES; break;
    }
    const int opened = OpenComponent(parent, name,
        O_RDONLY | O_NONBLOCK | (directory ? O_DIRECTORY : 0));
    if (opened < 0) { close(entry); break; }
    struct stat actual;
    const bool same = fstat(opened, &actual) == 0 && actual.st_dev == inspected.st_dev &&
        actual.st_ino == inspected.st_ino &&
        (directory ? S_ISDIR(actual.st_mode) : S_ISREG(actual.st_mode) && actual.st_nlink == 1);
    close(entry);
    if (parent != root_fd) close(parent);
    if (!same) { close(opened); errno = EACCES; return -1; }
    return opened;
  }
  if (parent != root_fd) close(parent);
  return -1;
}

void CloseWorkspaceDescriptor(int fd) { close(fd); }

int ReadWorkspaceDescriptor(int fd, char* output, unsigned int capacity) {
  unsigned int total = 0;
  while (total < capacity) {
    const ssize_t length = read(fd, output + total, capacity - total);
    if (length > 0) { total += static_cast<unsigned int>(length); continue; }
    if (length == 0) break;
    if (errno != EINTR) return -1;
  }
  return static_cast<int>(total);
}

bool GetWorkspaceIdentity(int fd, WorkspaceIdentity* identity) {
  struct stat information;
  if (fstat(fd, &information) < 0) return false;
  identity->device = static_cast<uint64_t>(information.st_dev);
  identity->inode = static_cast<uint64_t>(information.st_ino);
  identity->links = static_cast<uint32_t>(information.st_nlink);
  identity->directory = S_ISDIR(information.st_mode);
  return true;
}

std::string GetWorkspacePath(int fd) {
  const std::string link = "/proc/self/fd/" + std::to_string(fd);
  char output[4096];
  const ssize_t length = readlink(link.c_str(), output, sizeof(output));
  return length > 0 && length < static_cast<ssize_t>(sizeof(output))
             ? std::string(output, static_cast<size_t>(length))
             : std::string();
}

bool ListWorkspaceDirectory(int fd, unsigned int limit, std::vector<std::string>* names) {
  const int copy = dup(fd);
  if (copy < 0) return false;
  DIR* directory = fdopendir(copy);
  if (directory == nullptr) { close(copy); return false; }
  rewinddir(directory);
  errno = 0;
  while (names->size() < limit) {
    struct dirent* entry = readdir(directory);
    if (entry == nullptr) break;
    if (std::string(entry->d_name) != "." && std::string(entry->d_name) != "..")
      names->emplace_back(entry->d_name);
  }
  const bool ok = errno == 0;
  closedir(directory);
  return ok;
}

bool WorkspaceOpenUnavailable() {
  return errno != ENOENT && errno != ENOTDIR && errno != ELOOP && errno != EXDEV &&
         errno != EACCES && errno != EPERM && errno != EISDIR && errno != EMLINK;
}
#endif
