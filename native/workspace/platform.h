#pragma once

#include <cstdint>
#include <string>
#include <vector>

struct WorkspaceIdentity {
  uint64_t device;
  uint64_t inode;
  uint32_t links;
  uint64_t size;
  uint32_t mode;
  bool directory;
};

int OpenWorkspaceRoot(const std::string& path);
int OpenWorkspaceRelative(int root_fd, const std::string& relative, bool directory);
int OpenWorkspaceChild(int root_fd, int parent_fd, const std::string& name, bool directory);
bool ProbeWorkspaceWalk(int root_fd);
void CloseWorkspaceDescriptor(int fd);
int ReadWorkspaceDescriptor(int fd, char* output, unsigned int capacity);
bool GetWorkspaceIdentity(int fd, WorkspaceIdentity* identity);
std::string GetWorkspacePath(int fd);
bool ListWorkspaceDirectory(int fd, unsigned int limit, std::vector<std::string>* names);
bool WorkspaceOpenUnavailable();
