#pragma once

#include <cstdint>
#include <string>
#include <vector>

struct WorkspaceIdentity {
  uint64_t device;
  uint64_t inode;
  uint32_t links;
  bool directory;
};

int OpenWorkspaceRoot(const std::string& path);
int OpenWorkspaceRelative(int root_fd, const std::string& relative, bool directory);
void CloseWorkspaceDescriptor(int fd);
int ReadWorkspaceDescriptor(int fd, char* output, unsigned int capacity);
bool GetWorkspaceIdentity(int fd, WorkspaceIdentity* identity);
std::string GetWorkspacePath(int fd);
bool ListWorkspaceDirectory(int fd, unsigned int limit, std::vector<std::string>* names);
bool WorkspaceOpenUnavailable();
