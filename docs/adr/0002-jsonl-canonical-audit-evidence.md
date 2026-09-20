# Keep JSONL as canonical audit evidence

The MVP stores one append-only JSON Lines event stream per session in application-local storage because the evidence must remain portable, inspectable, and independent of a database schema. SQLite or another database may later provide fast queries, but it is rebuilt from JSONL and never becomes a second writable authority; each event carries a stable `event_id`, `session_id`, timestamp, type, policy decision, and bounded result metadata.

---

## Canonical format and integrity

Canonical event bytes use UTF-8, sorted keys, compact separators, preserved Unicode, rejected non-finite numbers, UTC RFC 3339 timestamps with exactly three fractional digits and Z, and LF endings. Events contain previous_event_hash and SHA-256 event_hash calculated without event_hash. A manifest records session_id, event count, and final hash. Databases remain rebuildable indexes.
