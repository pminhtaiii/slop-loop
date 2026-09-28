# Phase 3 Implementation Quickstart

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

This branch contains plans, not a Phase 3 implementation. Fake-boundary tests can prove routing and fail-closed decisions but cannot prove actual symlink containment or JSONL durability.
