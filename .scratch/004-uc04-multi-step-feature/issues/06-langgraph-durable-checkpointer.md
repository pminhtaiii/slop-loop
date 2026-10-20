# 06: LangGraph Custom Durable Checkpointer

**What to build:**  
A custom `BaseCheckpointSaver` implementation for LangGraph (`DurableFileCheckpointer` in `src/state/checkpointer.ts`) that persists graph state directly through `DurableStore`. This wires the slop-loop runtime's LangGraph StateGraph to atomic disk persistence.

**Blocked by:**  
- 02: Atomic Durable File Store with Concurrency Protection
- 03: Step State Machine & Checkpoint Lifecycle Transitions

**Status:**  
`completed`

- [x] Implement `DurableFileCheckpointer` extending `@langchain/langgraph` checkpoint saver contracts.
- [x] Implement `put(config, checkpoint, metadata)` writing thread state atomically.
- [x] Implement `getTuple(config)` loading and verifying checkpoint integrity from disk.
- [x] Implement `list(config)` returning available checkpoint history.
- [x] Add unit and graph test suite in `tests/runtime/uc04/checkpointer.test.ts`.
