# Edit the current checkout with session-scoped file permission

The local MVP edits the developer's current checkout because task worktree lifecycle and recovery would delay the first usable product. Before updating or creating a text file, the runtime requires developer permission for its canonical repository-relative path and intended update/create operation; one request may include several path-operation pairs, and permissions expire with session, mode, branch, or relevant file-state changes. The developer retains all Git writes, verification runs against an ephemeral Docker copy, and separate task worktrees remain a future isolation option.

---

## Final constraints

Permission binds canonical repository-relative path and update/create operation. Immediately before mutation, the runtime resolves again, rejects symlinks in the target or parents, and verifies repository state plus target identity. Create is exclusive and fails if the target exists.
