# Data Model: Phase 0 Project Foundation

## ApplicationConfig

An immutable startup configuration produced from application-owned environment values.

| Field | Type | Rules |
| --- | --- | --- |
| `logLevel` | enum | `trace`, `debug`, `info`, `warn`, `error`, or `fatal`; defaults to `info` |

Validation rejects unsupported values and unknown names within the `SLOP_LOOP_*` namespace. Unrelated environment variables are ignored.

## StructuredOperationalRecord

A machine-readable diagnostic record emitted by the application logger.

Required startup meaning:

- severity reflects the effective configuration;
- message identifies successful application startup;
- external or untrusted values remain nested under application-controlled fields;
- configured sensitive paths are redacted.

It is not canonical audit evidence and has no hash-chain, persistence, or authorization role.

## CompiledApplicationArtifact

The generated `dist/` output produced by the build. Its entrypoint is `dist/index.js`. It is private application output, not a published package or SDK.

## State transitions

```text
environment input
  → project SLOP_LOOP_* values
  → validated frozen configuration
  → logger creation
  → startup record
  → successful exit

invalid configuration
  → bounded diagnostic
  → unsuccessful exit
```

