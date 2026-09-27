# Keep tool definitions separate from authorization and execution

Status: accepted.

Phase 2's closed tool registry is the authoritative catalog for recognized tool names, strict tool-call argument validation, and generation of model-visible tool schemas. The registry has no authority to grant capabilities or execute a tool. This separation keeps tool definitions independent of the policy and adapter boundaries needed for different operations. Unknown names and invalid arguments are rejected by the registry.

The trusted session layer or composition root selects candidate tool names from application state, including the developer-selected `Ask` or `Edit` mode. The registry exposes schemas only for names that are both selected and registered. This selection controls model visibility; it does not authorize execution. The Phase 3 capability and policy layer will decide whether each invocation is allowed, and later adapters will perform the operation. The model and repository content cannot add or alter registry entries or the trusted selection.

For the MVP, `Ask` selects `list_files`, `search_code`, `read_file`, and `git_diff`. `Edit` selects those four plus `apply_patch`, `run_tests`, `run_build`, `run_linter`, and `run_typecheck`. Future Git-host actions are outside this set. The trusted layer must refresh model-visible schemas when a mode change becomes effective for a new task.

Each registered tool has one strict Zod argument schema. Runtime call validation uses that schema, and the model-visible schema is derived from it through a provider-neutral representation. Provider-specific conversion belongs to the later model adapter. Tests must detect divergence between advertised inputs and accepted inputs. `coding-agent-context/context/progress-checker.md` records implementation status only after implementation and required verification exist.
