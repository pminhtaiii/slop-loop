# 08: Context Compactor & Advisory Long-Term Memory Store

**What to build:**  
1. Context Compactor: Extracts structured summary fields (`goal`, `constraints`, `completedSteps`, `currentState`, `openRisks`, `nextAction`) from verbose traces so the LLM reasoning context stays bounded.
2. Long-Term Repository Memory: Persists durable conventions, build commands, and constraints across sessions; strictly advisory and validated against repository facts.

**Blocked by:**  
- 01: Data Contracts and Runtime Validation for State & Checkpoints

**Status:**  
`completed`

- [x] Implement `compactContext(traceEvents, currentState)` in `src/memory/compactor.ts`.
- [x] Ensure compacted summary always preserves the 6 mandatory fields.
- [x] Implement `LongTermMemoryStore` in `src/memory/long-term-store.ts` supporting inspect, add, update, delete conventions.
- [x] Enforce that repository memory is advisory only and current code/config overrides memory.
- [x] Add unit test suite in `tests/runtime/uc04/compactor.test.ts` and `tests/runtime/uc04/long-term-memory.test.ts`.
