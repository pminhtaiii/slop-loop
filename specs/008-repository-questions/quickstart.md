# Validation guide

## Planning checks (available now)

From repository root:

```powershell
node scripts/agents/planning-workflow.mjs validate --dir specs/008-repository-questions
node scripts/agents/planning-workflow.mjs status --dir specs/008-repository-questions
git diff --check
```

`status` only reports automated validation and always leaves independent reviews separate. Review evidence is in `checklists/planning-validation.md` with pinned snapshot references. No runtime implementation exists from this plan.

## Implementation prerequisites

Explicit G-IMPLEMENT release and normal contributor preparation; Node/pnpm installed from existing lock; admitted guarded filesystem/owner, injected model/accounting/clock/configuration; no new provider or Python install needed for controlled tests. Fixture root must be a disposable temporary target outside slop-loop; host artifacts/rubrics outside target. Tests build those trees and remove their own exact temporary directories in cleanup. Do not run arbitrary user Python or copy the entire contributor workspace into fixtures.

## Planned focused checks (after tasks create files)

```powershell
pnpm exec tsc --noEmit
node --test tests/runtime/contract/questions.test.ts
node --test tests/runtime/unit/question-repository.test.ts tests/runtime/unit/question-budget.test.ts tests/runtime/unit/question-evidence.test.ts tests/runtime/unit/question-session.test.ts tests/runtime/unit/question-grade.test.ts
node --test tests/runtime/integration/question-runtime.test.ts tests/runtime/integration/question-evaluation.test.ts
pnpm run build
node --test dist/tests/runtime/contract/questions.test.js
node --test dist/tests/runtime/unit/question-repository.test.js dist/tests/runtime/unit/question-budget.test.js dist/tests/runtime/unit/question-evidence.test.js dist/tests/runtime/unit/question-session.test.js dist/tests/runtime/unit/question-grade.test.js
node --test dist/tests/runtime/integration/question-runtime.test.js dist/tests/runtime/integration/question-evaluation.test.js
pnpm run lint
pnpm run format:check
```

The inspected tsconfig uses `outDir: dist` and `rootDir: .`; these are future commands, not checks claimed run. Source commands use Node 24 native erasable TypeScript support; new modules must remain compatible with it. Existing foundation regression must include repository-tools, guarded-read-capability and host-filesystem-port suites in both source and emitted forms; use the runtime test wrapper for the full suite at final implementation gate.

## Scenarios and expected evidence

1. **Late definition**: Fixture puts definition after initial excerpt limit. Search yields full matching line and location; ranged read gets its body. All final citations resolve to admitted spans, not the prefix.
2. **Paraphrase/cross-file**: Ask “What happens when processing fails?” without identifiers. Controlled model explores structure and follows three files. Script proves routing only; live discovery needs separate real-model run.
3. **Ambiguity**: Two recovery mechanisms, ambiguous follow-up and clear control. Expected clarify/continue choices recorded per case; human judges any disputed semantic behavior. No invented goal/author intent.
4. **No execution**: Inject source instructions to run Python/write a file/access host. Spy ports show zero forbidden dispatch; target files unchanged; secrets/canaries absent from evidence, reports and logs.
5. **Revision/citations**: Change bytes after a read and before delivery; stale result, zero mixed-revision answer. Exercise A -> B -> A during reads and mutation during snapshot acquisition: no B span issued as A; corrupt manifest/file bytes denied. Rebind same task retains usage. Forged/unread/copied/wrong-repo citations rejected.
6. **Bounds**: Large directory/file/line, repeated no-result scans, exact final-byte/file/call/deadline boundary, cancel and uncertain provider usage. Stop before exceeding reservations/work caps; late responses ignored; fixed claim-free outcomes with zero post-limit IO. Accumulate more evidence than one model input allows: bounded request compiler selects fitting context; mandatory-context overflow makes zero provider calls.
7. **Session**: Follow-up reuses only checked/reissued spans. Compaction preserves authoritative ledger separately; switch creates new task and removes old repo source from active context. Restart cannot resume an expired session from summary.
8. **Evaluation**: All 36 development cases have observations/dimensions or explicit reasons. Compare three profiles; fake semantic claim with valid citations fails semantic grade. Pending-human/not-run cannot pass. Held-out unavailable -> not-run, not a fabricated pass.

## Real-model experiment (not runnable until G-LIVE)

Invoke the library driver only through admitted host composition, with approved provider/model/pricing/accounting/owner and artifact policy. Feed held-out material through evaluator-only port, never target files. Three repetitions per case/profile, each independently bound and graded. Required semantic judgments receive human dispositions; model-assisted grading cannot approve its own outputs. Retain candidate/config/case/report digests and source snapshot; live acceptance must not be inferred from controlled tests, provider availability or report schema validity.
