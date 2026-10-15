# Context maintenance verification — 2026-10-15

Base HEAD: `f9818ef628435f010714bc5bd39b17252cc07954`, with local uncommitted changes. The [source snapshot](contributor-helpers-2026-10-15.snapshot.json) identifies the exact helper and test contents, rather than attributing local changes to that commit. Its root records the original checkout location; when reviewing elsewhere, compare the relative file paths and SHA-256 values against that checkout.

## Scope

Clarify source and diagnostic data boundaries, preserve cumulative checkpoint budgets, define established terms in the root glossary, extract the contributor maintenance guide, and distinguish progress status, implementation paths, evidence, and inspected revision.

## Checks

- `node scripts/ci/check-context.mjs`: exit 0; 14 Markdown files and three canonical facts passed. Local links from checked context pages include the new glossary and maintenance guide.
- `node --test`: exit 0; 47 passed, zero failed, one skipped. The skip is the existing Windows file-symlink test because the environment did not grant link creation. All four context-updater tests passed.
- `node scripts/agents/agent-context.mjs verify --snapshot docs/verification/contributor-helpers-2026-10-15.snapshot.json`: exit 0; all 13 helper and test files matched the captured hashes before and after the suite.
- `git diff --check`: exit 0.
- Manual review: glossary definitions match the documented contributor/runtime boundary; source excerpts remain subject to path, content, and size validation; source bodies are excluded from traces; cumulative budget scope and interrupted reservations are covered by the target verification matrix; extracted maintenance instructions preserve their command paths and plan schema.

## Limits

Contributor helper tests and document checks do not demonstrate enforcement by the planned product runtime. The new source-data and checkpoint-budget requirements remain target contracts. Overall helper verification remains partial because of the skipped platform-specific case; the context-updater CLI's tested behavior is verified at the captured source hashes. Semantic review remains required for agent-written context.
