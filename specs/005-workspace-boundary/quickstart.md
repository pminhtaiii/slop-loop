# Quickstart: Verify the Workspace Boundary

This guide describes the validation gate for the planned Phase 4 implementation. The commands and native build target become runnable as the tasks are completed; the current progress checker still marks Phase 4 open.

## Prerequisites

- Node.js 24, pnpm 12.5.1 from `package.json`, Git, and a checkout containing the completed Phase 0–3 source.
- Ubuntu with Linux `openat2` support (kernel 5.6 or later), Python, `make`, and a C/C++ compiler; or Windows with Python and Visual C++ Build Tools.
- Permission to run the OS-specific adversarial fixtures. A skipped mount/junction fixture is not evidence that the Phase 4 host-boundary exit gate passed.

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm native:build
pnpm exec vitest run tests/workspace tests/tools/workspace-gateway.test.ts tests/policy/engine.test.ts tests/tools/registry.test.ts
```

`pnpm native:build` is introduced by this plan. It must build the local Node-API helper for the current OS and architecture; a failed or unavailable build must not fall back to path-only file access.

## Scenario checks

1. **Checkout selection**: Admit from the root and a subdirectory and confirm one held-root/gitdir identity. Reject a missing or forged ID, non-repository directory, bare repository, sibling repository, nested repository, submodule, altered Git-discovery environment, and same-path replacement checkout including a linked-worktree gitfile.
2. **Path syntax and identity**: Deny `..`, absolute/drive/UNC paths, prefix-collision siblings, malformed names, and target swaps. Confirm the gateway receives exactly one matching fact for explicit paths, implicit root list/search, and `search_code.scope`; missing, duplicate, extra, or wrong-alias facts produce no executor call.
3. **Link and mount boundary**: Permit a safe in-repository read symlink; deny outside/nested-repo/secret aliases, write symlinks, hard links, cycles, Linux bind mounts below the root, Windows junctions/mounted folders, unknown reparse tags, and nonregular files. Swap an eligible alias to ignored or secret content between checks and confirm no bytes return. Confirm the checkout root itself may be on a mounted volume.
4. **Git and secrets**: Permit tracked plus nonignored untracked files. Exclude ignored untracked files, `.git` internals, gitlinks, nested repositories, and all default secret patterns on both alias and resolved path.
5. **Output bounds**: A file over 64 KiB or result over 64 KiB yields an explicit nonpartial read limit result. Search returns no more than 200 matches, 32 KiB total, or 4 KiB per line; files over 4 MiB and binary files are skipped with bounded metadata. Omitted matches and shortened lines are distinct.
6. **Failure behavior**: Native helper unavailable, unsupported kernel, uncheckable target, invalid facts, and cancelled open/walk all fail closed and release handles. A policy denial never reaches the fake executor.

## Full project gate

```sh
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
pnpm smoke
```

Run the focused and full gates on both supported OSes. `pnpm smoke` currently covers only the compiled Phase 0 entrypoint; it does not replace native boundary or gateway integration tests. Record exact commands, platform/kernel, fixture availability, results, and any blocked adversarial case in `coding-agent-context/context/testing.md`. Only then update `coding-agent-context/context/progress-checker.md` from planned to verified. The later Phase 6/7 adapters must prove that they use the same safe open primitive before their own exit gates can pass.

See [contracts/workspace-boundary.md](contracts/workspace-boundary.md) for outcomes and [data-model.md](data-model.md) for the sealed identity and fact lifetimes.
