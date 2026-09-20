# Feature Specification: Phase 0 Project Foundation

**Feature Branch**: `[main]`

**Created**: 2026-09-20

**Status**: Draft

**Input**: User description: "Record the confirmed Phase 0 foundation for a private, single-process application with minimal configuration, structured logging, source tests, a build artifact, compiled-start smoke verification, and platform-specific CI."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Start the private application foundation (Priority: P1)

As a project maintainer, I want the minimal application to start as one private, single-process application so that the repository has a reliable foundation before future agent behavior is added.

**Why this priority**: A successful, observable start is the smallest useful proof that the project foundation is coherent. It enables later work without prematurely committing to agent subsystems, a public package boundary, or distributed deployment.

**Independent Test**: Start the built application in a clean supported environment without application-specific configuration and confirm a successful start plus a structured operational record.

**Acceptance Scenarios**:

1. **Given** a successfully built application and no application-specific configuration, **When** the application starts, **Then** it uses the default `info` log level, emits a structured operational record, and exits the startup path successfully.
2. **Given** an application start attempt, **When** the start path encounters an invalid configuration, **Then** it reports a bounded, actionable diagnostic and does not continue as if startup succeeded.

---

### User Story 2 - Configure and observe the foundation (Priority: P1)

As a project maintainer, I want one small, predictable configuration surface and structured operational logging so that startup behavior is easy to verify without exposing a future audit stream or accepting accidental settings.

**Why this priority**: Configuration and operational visibility are the only runtime behaviors required in Phase 0. Strictness here prevents silent typos while keeping the initial contract intentionally small.

**Independent Test**: Start the application repeatedly with each supported log level, with an invalid level, with an unknown application-prefixed setting, and with unrelated environment values; compare the startup result and emitted records.

**Acceptance Scenarios**:

1. **Given** `SLOP_LOOP_LOG_LEVEL` is absent, **When** the application starts, **Then** the effective level is `info`.
2. **Given** `SLOP_LOOP_LOG_LEVEL` contains one of `trace`, `debug`, `info`, `warn`, `error`, or `fatal`, **When** the application starts, **Then** the value is accepted and the structured operational output observes that level.
3. **Given** `SLOP_LOOP_LOG_LEVEL` contains any other value, **When** the application starts, **Then** startup fails with a clear configuration diagnostic.
4. **Given** an unknown `SLOP_LOOP_*` setting is present, **When** the application starts, **Then** startup fails rather than silently accepting the unknown setting.
5. **Given** an environment value outside the `SLOP_LOOP_*` namespace, **When** the application starts, **Then** that value is ignored by the application configuration contract.
6. **Given** structured operational data that may originate outside the application, **When** it is emitted, **Then** it remains under application-controlled fields and is not treated as canonical audit evidence.

---

### User Story 3 - Verify source behavior and the built application separately (Priority: P1)

As a project maintainer, I want source-level tests, artifact building, and compiled-start smoke verification to be separate checks so that a test run does not depend on a previously generated artifact and the final artifact is still exercised directly.

**Why this priority**: Separating these checks catches both behavioral regressions and packaging/build regressions while preserving a clear boundary between development tests and the private application artifact.

**Independent Test**: Run the source-level behavioral suite before producing an artifact; then build the application and start only the compiled entrypoint through the smoke check.

**Acceptance Scenarios**:

1. **Given** a clean checkout with no generated artifact, **When** the source-level behavioral suite runs, **Then** it tests the foundation behavior without requiring the generated artifact to exist.
2. **Given** source tests have completed, **When** the application is built, **Then** a compiled artifact is produced in the agreed output location.
3. **Given** a successful build, **When** the smoke check starts the compiled application entrypoint, **Then** the application exercises the minimal configuration and structured-logging path and reports success without importing source files or a package self-reference.
4. **Given** the build has failed or the compiled entrypoint cannot start, **When** the smoke check runs, **Then** it reports failure rather than masking the build or startup problem.

---

### User Story 4 - Run the agreed platform quality gates (Priority: P2)

As a project maintainer, I want the quality workflow to exercise the complete gate on Ubuntu and the runtime/build gate on Windows so that changes are checked in the primary quality environment and in the team’s supported development environment.

**Why this priority**: Cross-platform verification is important, but it depends on the foundation behaviors and build artifact already existing.

**Independent Test**: Inspect and run the two platform jobs against a passing change and confirm that each job performs exactly the checks assigned to it and reports a useful failure when one check fails.

**Acceptance Scenarios**:

1. **Given** a pull request or a push to the default branch, **When** the Ubuntu job runs, **Then** it performs formatting verification, static checks, type checks, source tests, build, and compiled-start smoke verification.
2. **Given** a pull request or a push to the default branch, **When** the Windows job runs, **Then** it performs installation, source tests, build, and compiled-start smoke verification.
3. **Given** any assigned quality check fails, **When** the platform job completes, **Then** the job reports failure and identifies the failed check without attempting publication or deployment.

### Edge Cases

- No `SLOP_LOOP_*` settings are provided; the application must use `info` and still start successfully.
- An unrelated environment variable is present; it must not become an application configuration setting.
- An application-prefixed setting is misspelled or an unsupported log level is supplied; startup must fail deterministically and identify the configuration problem.
- Each supported log level is supplied; all supported values must be accepted without changing the rest of the startup contract.
- The generated artifact is absent, incomplete, or cannot start; the smoke check must fail clearly rather than fall back to source imports.
- Ubuntu and Windows execute different assigned gates; a platform-specific failure must remain visible rather than being hidden by the other job.
- Operational logging receives data that could contain secrets or arbitrary repository/model/tool content; output must remain bounded and controlled, and it must not become the future canonical audit stream.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The project MUST begin as one private, single-package, single-process application designed to evolve as a modular monolith when real subsystem boundaries appear.
- **FR-002**: The application MUST have one deliberately small startup entrypoint that exercises the minimal configuration and structured operational logging path.
- **FR-003**: The configuration contract MUST recognize `SLOP_LOOP_LOG_LEVEL` as its only initial application setting and MUST default it to `info` when absent.
- **FR-004**: The configuration contract MUST accept exactly `trace`, `debug`, `info`, `warn`, `error`, and `fatal` as log-level values.
- **FR-005**: The application MUST inspect only the `SLOP_LOOP_*` namespace, MUST reject unknown names in that namespace, and MUST reject invalid values before reporting successful startup.
- **FR-006**: The application MUST emit structured operational records with application-controlled fields, keep potentially untrusted values nested under those fields, and keep operational logging separate from any future canonical audit evidence.
- **FR-007**: Source-level behavioral tests MUST be runnable independently of any generated build artifact and MUST cover the minimal configuration, startup, and structured-logging behavior.
- **FR-008**: The build process MUST produce a compiled application artifact, and the smoke check MUST start that artifact’s entrypoint directly to exercise the minimal configuration and structured-logging path.
- **FR-009**: The smoke check MUST not depend on source imports, package self-reference, a publication boundary, or an SDK contract.
- **FR-010**: The quality workflow MUST run the complete agreed gate on Ubuntu, including formatting verification, static checks, type checks, source tests, build, and compiled-start smoke verification.
- **FR-011**: The quality workflow MUST run installation, source tests, build, and compiled-start smoke verification on Windows.
- **FR-012**: Phase 0 MUST not introduce agent orchestration, policy, tool, sandbox, audit, transport, CLI, publication, SDK, microservice, or speculative module behavior; future directories and test areas MUST be introduced only when their first real behavior exists.

### Key Entities

- **Application configuration**: The small set of startup settings recognized by the private application, initially limited to the log level and its namespace rules.
- **Structured operational record**: A bounded, machine-readable startup or runtime record intended for diagnostics and operations, not canonical audit reconstruction.
- **Compiled application artifact**: The output of the build process that the smoke check starts directly.
- **Platform quality gate**: The assigned set of validation checks run for a change on Ubuntu or Windows.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In a clean supported environment with no application-specific settings, the compiled application starts successfully, emits at least one structured operational record at the default `info` level, and completes its startup path within 5 seconds.
- **SC-002**: All six supported log-level values are accepted, while every invalid value and every unknown `SLOP_LOOP_*` name is rejected deterministically before successful startup.
- **SC-003**: The source-level behavioral suite passes when run before any build artifact exists, demonstrating that it has no hidden dependency on generated output.
- **SC-004**: After a successful build, the smoke check starts the compiled entrypoint directly and passes without importing source files, using package self-reference, or requiring publication metadata.
- **SC-005**: For every pull request and default-branch push, the Ubuntu job reports the complete assigned gate and the Windows job reports the assigned runtime/build/smoke gate; a failed check produces a failed job.
- **SC-006**: A review of the Phase 0 change finds no publication/SDK contract, CLI behavior, microservice boundary, speculative subsystem directory, or dependency-architecture enforcement added solely for future work.
- **SC-007**: A maintainer can determine from the startup result and structured output whether configuration was accepted or rejected without inspecting implementation internals.

## Assumptions

- The primary users of this foundation are project maintainers and the repository’s development/quality automation, not external package consumers.
- The application is private and local to its repository; publication, a reusable SDK, and a public package boundary are future decisions rather than Phase 0 behavior.
- The initial runtime is intentionally single-process. Distributed deployment, service-to-service communication, and microservices are outside this feature.
- Phase 0 has one recognized configuration setting. Additional settings require a later product decision and should not be inferred from arbitrary environment values.
- Operational logs are for diagnostics and runtime visibility. A canonical append-only audit stream is a separate future concern and is not created by this foundation.
- Source tests, build, and compiled-start smoke verification are distinct checks; running source tests does not imply that a build artifact already exists.
- Ubuntu is the full quality-gate environment and Windows is the supported runtime/build/smoke environment for this phase.
- Future architectural modules and test directories will be introduced with their first real behavior; Phase 0 does not need speculative structure or dependency-boundary enforcement.

## Out of Scope

- Implementing agent orchestration, policy evaluation, tool execution, sandboxing, repository mutation, audit evidence, or model integration.
- Defining interactive CLI behavior, web/API transport, publication, package self-reference, an exports map, tarball installation, or an SDK surface.
- Splitting the application into services or packages, or adding speculative subsystem folders and dependency-graph enforcement.
- Release, deployment, coverage, security-scan, publication, or package-distribution workflows.
