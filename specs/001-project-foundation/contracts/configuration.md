# Configuration Contract

Phase 0 owns one environment variable:

| Name | Accepted values | Default |
| --- | --- | --- |
| `SLOP_LOOP_LOG_LEVEL` | `trace`, `debug`, `info`, `warn`, `error`, `fatal` | `info` |

Rules:

- unrelated environment names are ignored;
- every unknown `SLOP_LOOP_*` name is rejected;
- invalid configuration prevents successful startup;
- `loadConfig()` accepts an injectable environment map and returns a typed frozen value;
- no `.env` loader or additional setting is part of Phase 0.

