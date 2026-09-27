# Quickstart: Implement and Verify Phase 2

1. Read `CONTEXT.md`, context README, tool policy, workflow, testing, progress checker, ADR 0005, and this feature's contract. ADR 0006/0007 are separate future refinements.
2. Add a focused failing test in `tests/tools/registry.test.ts` for each behavior in `tasks.md`; confirm RED for the intended reason.
3. Implement the minimum pure registry in `src/tools/registry.ts` and trusted candidate-name selector in `src/tools/selection.ts`; rerun the focused test after each slice.
4. Run `pnpm exec vitest run tests/tools/registry.test.ts` and then the repository gate:

```sh
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
pnpm smoke
```

5. Review against tool policy and both specification and standards/security axes. Update phase-relevant context and mark Phase 2 complete in `progress-checker.md` only after source and required verification exist. Keep Phase 1's separate pinned pnpm integration gate visible if still pending.

Expected security demonstration: unknown names and fields fail; Ask shows four names and Edit nine; advertised arguments agree with runtime Zod acceptance; the registry cannot execute a tool or grant permission.
