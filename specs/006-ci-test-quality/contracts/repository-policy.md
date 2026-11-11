# Repository Content and Metadata Policy

## Environment-file admission

Enumerate candidate tracked paths through Git, not a recursive working-tree scan. Match basenames case-insensitively for `.env`, `.env.*`, `*.env` and `*.env.*`. Reject matches except the exact lowercase basename `.env.example`. Existing dependency/local-verification artifact refusals remain in force. Force-added ignored files are still tracked and must be rejected. Never open ignored/untracked local env files.

For an admitted example, read the candidate Git blob only after checking regular-file mode and a 64 KiB maximum; reject symlinks, binary/NUL data, malformed UTF-8 and unsupported syntax. Parse as data without expansion or shell execution. Allow blank lines, full-line comments and assignments with an optional `export ` prefix and conventional identifier keys. An optional matching quote pair may wrap a value. Values must be empty or one of the exact placeholder literals `CHANGE_ME`, `YOUR_VALUE_HERE`, `EXAMPLE_VALUE`, `https://example.invalid`. Reject multiline values, escape/interpolation syntax, unmatched quotes and other non-placeholder values. Diagnostics identify path/line/rule only, never value or source text.

This deliberately narrow initial syntax is a documented policy choice, not a general dotenv parser. Fixture tests cover nested/mixed-case names, force-added ignored files, zero/maximum/oversized blobs, malformed encoding, symlinks, comments/quotes/export, real-looking values and zero reads of local env files.

## Secret detection

The Linux repository-policy job uses Gitleaks CLI v8.30.1, installed from the exact release and verified against its release checksum manifest. Pin the installer source/actions; no unverified `latest` binary and no credential-requiring hosted scanner action. Capture scanner output with bounded buffers/timeouts and `--redact=100`; emit only an allowlisted summary containing rule ID, path, line and commit. Never upload raw stdout/stderr, raw matches or secret fields. Scanner setup/parse/integrity failures fail the job with fixed sanitized diagnostics.

Always scan an isolated snapshot of the complete admitted H tree, including unchanged candidate files. In addition, for PRs scan the admitted base/head commit range to detect commits that introduce and later delete a secret. For push/manual runs additionally scan a verified reachable before/head range where available; if before is missing/zero/unavailable, retain the complete tree scan and record the unavailable range explicitly. Report modes as tree-plus-range or tree-only-with-range-unavailable; no missing-base condition skips candidate-tree scanning. A failed requested tree/range scan is an execution failure, not a clean result. Reject unsafe revision syntax; Git arguments remain structured and bounded. The scanner reads candidate Git content, not the author's local env files. A clean report detects no configured patterns; it does not prove all possible credentials absent.

Synthetic scanner fixtures exercise unchanged-tree findings, add-then-delete range findings, no findings, unavailable range, malformed output, nonzero setup errors, timeouts and redaction failures. Existing synthetic secret-pattern fixtures may require narrowly fingerprinted reviewed exemptions; no blanket tests-directory allowlist and no actual keys are introduced for testing. Pin exemptions to exact synthetic evidence with a reason, preserving refusal for nearby unapproved findings.

## PR metadata

Validate base `development`, existing scoped branch/title conventions and ordered nonempty Summary/Evidence/Merge Danger sections with required Door/Blast Radius fields. Invoke existing validators through a pure data adapter; reject missing/wrong-typed event fields with a sanitized reason. Retained legacy convention identity is selected only through the explicit historical bindings in [ci-checks.md](ci-checks.md), never inferred from attacker-supplied version fields. CLI event parsing and live readiness use the same behavior.

PR titles/bodies never enter shell source, command substitution or diagnostic echoes. Preserve paired privacy and historical receipts. A draft with valid metadata can pass this check while remaining a draft; metadata validation does not grant review or merge approval.
