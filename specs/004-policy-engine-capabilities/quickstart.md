# Phase 3 Implementation Quickstart

## Prerequisite audit (2026-09-28)

- Phase 0 foundation and its standalone exit gate are complete on `development`; the combined local pinned-manager gate passed on 2026-09-28 after a tracked LF checkout rule resolved the Windows CRLF mismatch.
- Phase 1 domain source and tests exist. T038–T040 have reconciled its runner with ADR 0006/0007: fixed task mode, separate turn and attempt counters, finite promotion and retry budgets, active-work time excluding permission waits, safe stop, and bounded budget handoff. Gateway integration remains open.
- Phase 2's nine-name registry source is present in this checkout through the Phase 2 cherry-pick (`deb83ae`); its focused suite now passes 90 tests with T041 metadata. It validates calls and selects schemas but provides no authorization or execution. Phase 2 T035/T036 reviews remain open.
- T041 adds trusted capability/effect metadata to the nine-name registry. No Phase 3 policy engine, gateway, real authority providers, or executable adapters exist at this checkpoint. T042–T058 and the Phase 3 integration gate remain open.

1. Read CONTEXT.md, coding-agent-context/README.md, tool-policy.md, workflow.md, testing.md, progress-checker.md, ADR 0006–0008, and the Phase 1/2 plans. Confirm implementation status before coding.
2. Ensure Phase 2's closed registry source exists before gateway integration. Reconcile the Phase 1 runner and its old lifecycle tests first.
3. Build pure policy, then the gateway, then scripted runner → gateway → fake executor scenarios. Keep real path, grant, process, and audit adapters in their scheduled phases.
4. Run focused Vitest files for orchestration, policy, registry, and gateway. Verify:
   - wrong mode, missing capability, forbidden path, malformed/unknown call, bad trusted facts, and policy exception all cause zero executor calls;
   - every executed read or effect follows a successful canonical pre-execution append;
   - unavailable pre-append blocks all model-visible tools, including reads;
   - uncertain result append retries the same event ID without duplicate event or executor call;
   - bad result reports possible/completed effects and never enters audit or model context raw;
   - each individually dispatched call consumes one attempt; later proposals after the first denial consume none;
   - shared recovery exhaustion never promotes or refills after productive promotion;
   - human waits do not use active-work time, stop during pending pre-append prevents executor start, late results are fenced, and every finite-budget terminal outcome has a bounded handoff.
5. On a combined checkout with Node.js 24 and pinned pnpm 12.5.1, run the full gate:

~~~sh
pnpm install --frozen-lockfile
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
pnpm smoke
~~~

T037–T041 now provide the reconciled runner, bounded budget handoff, and trusted registry metadata. The policy engine, gateway, fake-boundary routing tests, and full Phase 3 exit gate remain open at T042–T058. The current code does not prove actual symlink containment or JSONL durability.
