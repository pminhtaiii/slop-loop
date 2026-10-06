# Quickstart: Repository Read Tools Validation

These commands are the planned implementation gate, not evidence that missing Phase 6 tests/scripts exist or pass today. This planning PR uses the artifact checks in the final section.

## Prerequisites

- Node.js 24 LTS and Corepack pnpm 12.5.1 from `package.json`.
- Git, supported Ubuntu/Windows host and the pinned built native workspace addon.
- Phase 4 available-fixture prerequisite satisfied under explicit T088 exception. Retain Phase 5 Windows Docker gate OPEN; Docker is not needed for these read-tool checks.

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm native:build
corepack pnpm exec vitest run tests/workspace tests/tools tests/orchestration
```

Expected: existing regressions pass on the host; unavailable mount/native fixtures are named explicitly, never counted as passing security evidence.

## Targeted Phase 6 behavior

```powershell
corepack pnpm exec vitest run tests/tools/read.test.ts tests/tools/output-contracts.test.ts
corepack pnpm exec vitest run tests/tools/read.integration.test.ts tests/tools/read.security.test.ts
corepack pnpm exec vitest run tests/orchestration/context.test.ts tests/orchestration/runner.test.ts
corepack pnpm exec vitest run tests/retrieval/evaluation.test.ts tests/retrieval/performance.test.ts
```

Expected: strict schemas/caps/hashes; safe 4 MiB+1 detection; literal file/directory search; sorted bounded listing; aliases/cycles/work limits; denied targets/audit outages never deliver content; cancellation closes handles/fences late output; bootstrap charges normal allowances and loads root-only discovered instructions.

Fixture E2E uses real native boundary and gateway/runner plus fake audit/model ports. Demonstrate root bootstrap -> scoped literal search -> complete read -> expected evidence checks, then hostile variants. Assertions require zero host/forbidden deliveries and explicit incomplete no-match. Scripted answer/verification checks are labeled as such; live answer correctness is NOT_MEASURED. Do not execute repository code to measure verification selection.

## Dedicated performance evidence

```powershell
corepack pnpm retrieval:bench -- --calibrate
corepack pnpm retrieval:bench -- --check
```

T150/T151 add these application-development commands. Calibration writes only private benchmark outputs until reviewed baseline metadata is selected for `tests/fixtures/retrieval/performance-baselines.json`; do not auto-rewrite thresholds in check mode. Benchmark maximum-size normal/adversarial read/search payloads, 100 warmups and >=1,000 measured sanitizer iterations; >=30 end-to-end fixture runs per host. Record CPU/OS/runtime/sample counts, p50/p95/p99 and isolated/end-to-end overhead.

Expected: calibrated host thresholds and baseline*1.25+1 ms sanitizer regression gates pass before enablement. The initial <=10 ms sanitizer p95 target is a goal to test, not passed evidence. Missing host baseline or failed correctness/timing blocks enablement; no scanner bypass or security relaxation is permitted. Ordinary unit CI contains correctness tests, not noisy timing assertions. Record unavailable reference-host timing explicitly.

## Full implementation gate

```powershell
corepack pnpm lint
corepack pnpm format:check
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm smoke
```

After both-host native retrieval/security and performance evidence, complete security convergence, separate standards/spec review and context sync. Phase 6 gate: scripted fixture retrieval understands declared evidence without host escape. Do not claim real-provider or earlier open Docker gates are complete.

## Planning PR validation

```powershell
$env:SPECIFY_FEATURE = 'feat/007-repository-read-tools'
$env:SPECIFY_FEATURE_DIRECTORY = 'specs/007-repository-read-tools'
.specify/scripts/powershell/check-prerequisites.ps1 -Json -RequireTasks -IncludeTasks
git diff --check
corepack pnpm exec prettier --check specs/007-repository-read-tools docs/phase6-design-checkpoint.md docs/adr/0012-automatic-context-retrieval-authority.md AGENTS.md .specify/feature.json
```

Also validate local document links, task IDs/order/story labels/paths, FR-to-task coverage, review findings and issue deduplication. Planning quality checks are distinct from the future implementation gate above.
