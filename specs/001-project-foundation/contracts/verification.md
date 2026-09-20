# Verification Contract

| Command | Contract |
| --- | --- |
| `pnpm lint` | Run non-mutating static lint checks. |
| `pnpm format` | Intentionally rewrite repository files using the configured formatter. |
| `pnpm format:check` | Verify formatting without modifying files. |
| `pnpm typecheck` | Type-check production and test configuration without emitting output. |
| `pnpm test` | Run source-level behavior tests without requiring `dist/`. |
| `pnpm build` | Compile the private application to `dist/`. |
| `pnpm smoke` | Execute `node dist/index.js`; requires a successful build and never imports source or package self-reference. |

Ubuntu CI runs install plus every non-mutating verification command, including build and smoke. Windows CI runs frozen install, test, build, and smoke.

