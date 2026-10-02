#if defined(__linux__)
#include <fcntl.h>
#include <linux/openat2.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>
#include <dirent.h>
#include <cerrno>
#include <string>
#include "platform.h"

int OpenWorkspaceRoot(const std::string& path) {
  return open(path.c_str(), O_RDONLY | O_CLOEXEC | O_DIRECTORY);
}

int OpenWorkspaceRelative(int root_fd, const std::string& relative, bool directory) {
  struct open_how how = {};
  how.flags = O_RDONLY | O_CLOEXEC | O_NONBLOCK | (directory ? O_DIRECTORY : 0);
  how.resolve = RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV;
  const int fd = static_cast<int>(syscall(SYS_openat2, root_fd, relative.c_str(), &how, sizeof(how)));
  if (fd < 0) return -1;
  struct stat information;
  if (fstat(fd, &information) < 0 ||
      (directory ? !S_ISDIR(information.st_mode) : !S_ISREG(information.st_mode) || information.st_nlink != 1)) {
    close(fd);
    errno = EACCES;
    return -1;
  }
  return fd;
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
