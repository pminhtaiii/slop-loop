# Research: Paired PR Eligibility Preview

## Read-only seam

- **Decision**: A standalone CLI with injected structured executor.
- **Rationale**: `pr-workflow.mjs` creates the workflow store and saves status. `submission-pr.mjs` verification reaches `submission-pr-shared.mjs` record paths through `dataDirectory`, which creates directories. Reuse pure target/branch validators and check assessment where safe; discover root/primary through the CLI's own bounded Git inventory instead of imported `repository()`, whose direct executor lacks the required environment.
- **Read-only enforcement**: Every Git child receives `GIT_NO_LAZY_FETCH=1` and `GIT_OPTIONAL_LOCKS=0`; missing promisor objects fail instead of causing a fetch. This applies to discovery and any helper calls as well as diff/blob reads.
- **Alternatives considered**: Adding a merge command or reusing status would mix observations with writes and broaden this authorized scope.

## Complete change evidence

- **Decision**: Require the exact live public base object locally and prove it is an ancestor of the public head; classify a complete NUL-delimited `git diff --raw --no-renames` between those immutable revisions.
- **Rationale**: This avoids PR-files pagination and truncation ambiguity. A stale or missing base stops evaluation without fetching. Submission history is separate, so its diff is not the public documentation change set. An added file's absent preimage is valid, contributes zero bytes and is never read as an object.
- **Alternatives considered**: Paginated PR-files data requires additional completeness and file-mode evidence; a stale tracking ref cannot identify the live base.

## Narrow documentation policy

- **Decision**: Allow only ordinary prose changes to root `README.md`, `docs/user/**/*.md`, or `docs/guides/**/*.md`, subject to explicit governance/content exclusions.
- **Rationale**: Current docs directories are `docs/adr` and `docs/agents`; broad Markdown matching would admit decisions and agent policy. Future user/guides paths are valid without widening the current governance boundary.
- **Alternatives considered**: All Markdown, unchanged graphs, coverage, and mutation scores cannot establish unchanged behavior. Such categories remain future work.

## Race and readiness evidence

- **Decision**: Reobserve both PR heads/bases/merge states, exact-head required checks, commit trees, targets, records and local checkout identity before eligibility. Include normalized effective remote identities and live repository visibility in both canonical observations; keep private identities internal.
- **Rationale**: Public readiness assessment does not establish submission mergeability or snapshot stability. Both PRs must be open, non-draft, non-fork and clean against development. Missing/changed evidence fails closed.
- **Alternatives considered**: A cached READY status or head equality alone permits stale base and check evidence.

## Planning environment

Templates were resolved through `.specify/scripts/powershell/common.ps1` (`Resolve-TemplateContent`) for spec, plan and tasks. `.specify/extensions.yml` and `.specify/feature.json` were absent before this feature; no hooks apply and there is no previous selector value to preserve. The constitution remains a placeholder. Planning review evidence is recorded by the coordinator after independent reviews, not inferred from automated validation.
