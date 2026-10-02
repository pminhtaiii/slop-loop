# Phase 5 offline verification sandbox research

Research note for feature 006 / Phase 5. The Phase 5 decisions in [ADR 0011](../../docs/adr/0011-disposable-offline-verification-containers.md) remain authoritative. Limits below align with the plan's bounded initial defaults; they are not benchmark-proven and require integration evidence on supported Docker backends.

## Choices, rationale, and alternatives

### Dependency preparation: validate the graph, fetch only locked registry artifacts, then go offline

**Choice.** Use an application-owned preparation recipe and an ephemeral preparation container. It receives only the bounded dependency-input snapshot and trusted configuration; it never receives the target checkout, developer credentials, sensitive host paths, or Docker socket. Pin the Node base image by digest and invoke the repository's pinned `pnpm@12.5.1` binary directly. Do not read target `.npmrc`, global pnpm configuration, package-manager hooks, or build instructions as policy. Reject unsupported lockfile constructs before any network request, including Git/SSH, `file:`, arbitrary tarball URLs, lockfile `configDependencies`, and package-manager hooks. The supported graph here has no local/workspace package dependencies; reject those sources until separately designed.

**Rationale.** The root lockfile currently has `configDependencies: {}`, the repository has no `.pnpmfile` or `.npmrc`, and its lockfile entries use integrity hashes. Its `pnpm-workspace.yaml` currently allows `esbuild` to build, but that repo-owned value is untrusted and cannot be used as policy.

**Alternative rejected.** Copying the repository wholesale into prep would expose preparation to repository-controlled settings and hooks; supporting arbitrary sources would require more credentials and egress policy than this MVP has.

**Choice.** Parse bounded manifests/config (16 MiB total) and lock data (32 MiB) with a maintained YAML parser plus strict Zod schema. Validate the supported pnpm lockfile version and source grammar, every locked package name/version/integrity, and supported Linux platform variants. Require integrity for every artifact and a unique locked source mapping before fetch. Generate sanitized manifests containing package identity and dependency fields only; omit all target scripts, including root install hooks.

**Rationale.** The 16/32 MiB parser bounds, 10,000-artifact maximum, and strict schema prevent hostile repository input from driving unbounded parsing or arbitrary resolution. Removing root scripts prevents target lifecycle hooks such as `preinstall`, `prepare`, or `pnpm:devPreinstall` from running during install. Dependency scripts remain separately controlled by exact identity.

**Alternative rejected.** Hand-parsing YAML or trusting a lockfile's shape without schema validation can misinterpret hostile or future syntax. Letting target package scripts run during preparation grants repo code authority outside the intended verification profile.

**Choice.** Run pinned `pnpm fetch` against only the validated lockfile and freshly generated minimal workspace config, with hooks and scripts disabled and no source tree present. Limit to 10,000 artifacts, 128 MiB per artifact, 2 GiB compressed total, 60 seconds per artifact, 3 attempts per artifact, and 15 minutes overall. Use the Node standard-library CONNECT broker as the only egress path. A trusted setup helper installs network policy into the fetch container's namespace and exits before pnpm starts; it alone temporarily has `NET_ADMIN`. The fetch container is non-root, has `CAP_DROP=ALL`, `no-new-privileges`, and no `NET_ADMIN`. The trusted helper applies deny-by-default egress allowing only broker IP:port; the broker runs on a temporary dual-homed prep-only network. Fetch never has direct Internet routing. Do not mount source code, run package scripts, or expose the Docker socket to either the helper or fetch container.

**Rationale.** pnpm documents that `fetch` reads the lockfile and workspace config, and that `install --offline` fails if packages are absent. pnpm `--ignore-scripts` suppresses project and dependency scripts; integrity mismatches are hard failures unless checksum updating is explicitly enabled, which the recipe must never do. Aggregate quotas are application-enforced. The split network-setup helper avoids granting `NET_ADMIN` to the process running pnpm. Node's HTTP server CONNECT event and `net`/`dns` APIs provide the standard-library building blocks for a tunnel broker; these APIs do not supply the app's allowlist/address policy, which must be implemented and fixture-tested. Sources: [pnpm fetch](https://pnpm.io/cli/fetch), [pnpm install](https://pnpm.io/cli/install), [Node HTTP CONNECT](https://nodejs.org/download/release/latest-v24.x/docs/api/http.html#event-connect), [Node DNS](https://nodejs.org/download/release/latest-v24.x/docs/api/dns.html#dnslookuphostname-options-callback), [Node Net](https://nodejs.org/download/release/latest-v24.x/docs/api/net.html#socketconnectoptions-connectlistener).

**Alternative rejected.** Registry settings alone do not prevent direct egress or DNS rebinding. Giving `NET_ADMIN` to pnpm or any lifecycle script would let untrusted code change the network fence. A long-lived proxy/service is unnecessary; create and destroy the broker for each confirmed prep action.

**Choice.** The broker accepts CONNECT only to approved public registry hostnames on port 443 and validates/resolves public destination addresses at connection time, rejecting private, loopback, link-local, multicast, reserved, and unapproved destinations. Redirects that change the destination host require a new CONNECT and are denied unless that public host is approved. No TLS URL-path inspection is claimed. Exact-artifact enforcement is the schema-validated frozen graph, pinned pnpm with hooks/configDependencies disabled, no code during fetch, and integrity validation of received bytes. The network setup helper plus firewall rules block direct bypass and DNS rebinding/private IPs. Unsupported redirects/sources or any fixture that disproves those controls blocks preparation.

**Rationale.** A standard CONNECT broker sees the target host/port, not encrypted URL paths. Host/IP enforcement plus prevalidated lock graph and content integrity is the feasible trust chain; the broker is not misrepresented as an HTTPS-inspecting proxy. The broker is temporary infrastructure only for explicit developer-triggered preparation.

**Alternative rejected.** Hostname-only allowlists leave DNS rebinding/private-address exposure; claiming path enforcement through a non-terminating CONNECT tunnel is inaccurate. TLS interception would add a custom trust root and complexity without replacing lockfile integrity.

**Choice.** After fetch completes, remove the network-capable stage/policy and build in a separate no-network container. Transfer only the bounded verified package store. Install with `pnpm install --offline --frozen-lockfile` and generated trusted script settings. Set preparation resource limits to 2 CPUs, 4 GiB memory, no swap, 256 PIDs, and 2 GiB `/workspace` plus 256 MiB `/tmp` tmpfs. Publish only after install, script policy, integrity, toolchain prerequisite, and image smoke checks pass; any failure leaves the prior image active.

**Rationale.** pnpm documents `--offline` and frozen lock behavior; offline mode fails when a package is missing rather than reaching a registry. Thus dependency code cannot reuse fetch's network capability.

**Alternative rejected.** Performing install/build in the network-capable stage would let dependency scripts reuse network authority. Automatic recovery by downloading missing artifacts would violate the explicit preparation boundary. Source: [pnpm install](https://pnpm.io/cli/install).

### Exact script allowlist compatible with pnpm 12

**Choice.** Keep the trusted allowlist keyed by exact lock identity including integrity. pnpm's `allowBuilds` is keyed by package name only, so generate an `allowBuilds` name entry only when every locked occurrence/version for that name has explicit exact-identity approval. Otherwise deny/block if a build is required. Strict build-script handling reports and fails unsupported scripts. The generated config and allowlist enter the fingerprint. Use the setting supported by pinned 12.5.1; do not depend on `--allow-build`, which current pnpm docs say arrived in 12.7. Sources: [pnpm settings](https://pnpm.io/settings), [pnpm install options](https://pnpm.io/cli/install), [pnpm 11 build-script policy change](https://pnpm.io/blog/releases/11.0).

**Rationale.** The conservative every-occurrence rule prevents the package-name-only tool control from granting authority to an unapproved second version. Exact identity remains the policy authority; pnpm's generated map is only the execution adapter.

**Alternative rejected.** A plain `allowBuilds: { name: true }` copied from repository config loses version/integrity identity, and the newer CLI flag is not available in the pinned runtime.

**Choice.** Repository-owned native compilation is a separate trusted prelude, invoked with pinned `node-gyp` executable and fixed argv plus local matching Node headers. Do not invoke the mutable target `native:build` package script. Use a digest-pinned application-owned Node 24 Debian base provisioned separately with pnpm, Git, Python, make, C/C++ toolchain, and matching headers. Missing/mismatched prerequisites block; never apt-install or download headers during prep install or verification. Build output remains in the disposable workspace.

**Rationale.** Node-gyp requires Python, make, and a C/C++ compiler on Unix, and otherwise may download target headers. Pre-provisioning and explicit local header arguments keep the prelude offline and deterministic. Sources: [Node.js addons](https://nodejs.org/api/addons.html), [node-gyp installation and local `--nodedir`](https://github.com/nodejs/node-gyp#installation).

**Alternative rejected.** Invoking a repository package script lets target code choose build behavior; allowing node-gyp to download headers creates an unapproved network path and invalidates offline verification.

### Bounded storage and container setup

**Choice.** Use Docker/cgroup enforcement for 2 CPUs, 4 GiB total memory including tmpfs, no additional swap, 256 PIDs, and 300 seconds per check including copy-in/native prelude, bounded by profile and task deadline plus a host watchdog. Require non-root, read-only root/toolchain, dropped capabilities, `no-new-privileges`, default seccomp, no network/socket/ports, and `--privileged` forbidden.

**Choice.** Size `/workspace` tmpfs to 2 GiB (`nosuid,nodev`, executable) and `/tmp` to 256 MiB (`nosuid,nodev,noexec`); both count toward the 4 GiB memory cgroup. Require inspection proving all limits are active on Docker Engine/Desktop, otherwise block. Also require an externally configured bounded Docker builder/storage boundary for prep publication: cap managed exported image artifact at 4 GiB and block if daemon storage cannot be bounded. Account for offline package-store expansion, not only compressed bytes. Docker tmpfs is size-limited; writable overlay caps are storage-driver dependent, and `overlay2` needs XFS project quotas. Sources: [Docker run resource and storage options](https://docs.docker.com/reference/cli/docker/container/run/), [Docker tmpfs](https://docs.docker.com/engine/storage/tmpfs/), [Docker storage driver limits](https://docs.docker.com/reference/cli/docker/container/run/#set-storage-driver-options-per-container---storage-opt).

**Rationale.** Bounded tmpfs avoids relying on host filesystem quota support for untrusted check writes. Prep still writes image layers in daemon-managed storage, so finite transfer accounting alone is not a hard bound: require a bounded builder/storage boundary or fail closed.

**Alternative rejected.** Per-container overlay size cannot be assumed portable, and post-hoc disk accounting does not prevent a process from exhausting the daemon's disk.

**Choice.** Capture into host staging capped at 1 GiB; each container mounts only that snapshot read-only at `/snapshot`, then a trusted bootstrap copies manifest-approved regular files to bounded `/workspace`. Use 50,000 entry, 256 MiB total, and 16 MiB per-file limits; oversized eligible input blocks instead of being skipped. Materialize safe in-repository symlink content as regular files with provenance; reject hard links, special files, unsafe boundaries, and collisions. Exclude `.git`, denied secrets, nested repositories, host `node_modules`, and reference generated output (`dist`, coverage, `native/**/build`); native binaries are therefore excluded, but do not add a broad `**/*.node` rule if it could exclude legitimate source data. Keep native source and its required manifests. The host snapshot, not the checkout, is the only staging mount; do not copy container writes back.

**Rationale.** The per-entry/total bounds and safe handle recopy prevent unbounded or raced host reads. Manifest/hash/rescan binds all checks to one copied snapshot. Materialized symlinks avoid transferring host path semantics into the container. A 1 GiB host staging cap exceeds the 256 MiB snapshot maximum with room for temporary publication.

**Alternative rejected.** Writable checkout bind mounts permit host writeback; copying arbitrary symlink/hardlink/special-file structures imports unsafe filesystem semantics; silently omitting oversized eligible files produces misleading verification.

The offline verification image contains dependencies, so checks do not install. Each check gets a fresh 2 GiB workspace tmpfs and 256 MiB `/tmp`; preparation uses the same tmpfs caps and its own 2 CPU/4 GiB/256 PID ceilings.

### Proposed finite limits and failure gates

These are the plan's concrete initial defaults for Phase 5 integration tests; integration proof is still required:

| Bound | Initial default | Failure behavior |
| --- | ---: | --- |
| Snapshot eligible entries | 50,000 | Abort capture; no partial verdict |
| Snapshot per-file bytes | 16 MiB | Abort capture; report path and limit through trusted diagnostic |
| Snapshot total bytes | 256 MiB | Abort capture; no partial verdict |
| Capture attempts | 3 total | Abort if no stable snapshot after three attempts |
| Per-container stdout + stderr captured | 1 MiB combined | Stop check, retain bounded prefix, report output-limit failure |
| Model-visible verification output | 32 KiB combined | Truncate/redact before model exposure |
| Writable `/workspace` | 2 GiB tmpfs | Container write fails; verification fails safely |
| Writable `/tmp` | 256 MiB tmpfs | Container write fails; verification fails safely |
| Container memory | 4 GiB including tmpfs | OOM is a typed verification failure; no retry with larger resources |
| Prep manifest/config inputs | 16 MiB total | Reject before parser expansion |
| Prep lock data | 32 MiB | Reject before parser expansion |
| Prep artifacts | 10,000 max; 128 MiB each; 2 GiB compressed aggregate | Abort fetch; keep old image |
| Prep artifact time/retries | 60 seconds/artifact; 3 attempts/artifact | Abort on exhaustion |
| Prep action time | 15 minutes overall | Terminate prep, clean up, keep old image |
| Prep temporary storage/cache | 4 GiB per action; package-store expansion bounded before publication | Abort and clean owned temporary resources |
| Host snapshot staging | 1 GiB | Abort staging; no partial verdict |
| Exported image artifact | 4 GiB | Abort publication |
| Prep resource limits | 2 CPUs; 4 GiB including tmpfs; no swap; 256 PIDs; `/workspace` 2 GiB + `/tmp` 256 MiB | Missing enforcement blocks; no automatic expansion |
| Builder/daemon storage | Externally configured bounded storage required | Block preparation when unavailable |
| Cleanup stop/remove attempts | 3 total | Block further verification; report container identity/state; reconcile owned resource on next startup |

Count bytes while streaming/copying, not only after. Capture retries and cleanup retries are 3 total each. Cleanup attempts are at most 10 seconds each and remain a separately bounded safety obligation. Output retains at most 1 MiB combined, explicitly records truncation, stops the check at overflow while continuing bounded drain/discard for cleanup, and limits the total model-result envelope to 32 KiB. Do not create unbounded Docker logs. Capture comparison remains non-atomic and cannot prove absence of rapid change-and-restore. A watcher may trigger early rescan but is never authority.

### Preparation image identity

**Choice.** Bind canonical fingerprint and immutable local image ID/digest in private application-owned metadata. Write metadata atomically by same-volume temp-write, fsync, and rename; publish only after a bounded export/inspection/smoke-check. Limit managed prep cache to 4 GiB/action and image artifact to 4 GiB; require the Docker builder/daemon storage itself to be externally bounded or block. Verification executes by immutable ID, never mutable tag, and rechecks that the fingerprint matches dependency inputs captured in the snapshot for both direct and post-prep new-task paths. Failure never replaces the last known-good image. Source: [Docker image inspect](https://docs.docker.com/reference/cli/docker/image/inspect/).

**Rationale.** Image ID identifies Docker content, while private metadata binds it to the richer lock/config/runtime fingerprint and preparation state. Atomic publication prevents partial records from appearing ready.

**Alternative rejected.** A tag, repository file, or partially written record is mutable and cannot establish readiness. A database is unnecessary for this single-process MVP.

## Required integration fixtures

- A valid public registry lockfile fetches only integrity-matching locked artifacts; corrupt bytes, absent integrity, changed resolution, private/Git/tarball sources, and unexpected redirects are rejected.
- Registry redirect to a private, loopback, link-local, or unapproved host is blocked; direct egress bypass and DNS rebinding are blocked. Test with a local controlled registry/proxy fixture, not the public Internet.
- A dependency lifecycle script cannot run during fetch; it runs only in the no-network stage when every exact locked occurrence is allowlisted. Same package name at an unapproved version or integrity cannot inherit a name-level allow.
- Prep has no target checkout mount, secrets, Docker socket, project `.npmrc`, `.pnpmfile`, or project `allowBuilds` authority. Unsupported hooks/configDependencies fail before network access.
- The offline install fails if a package is missing and cannot contact a registry. The base image and toolchain do not trigger automatic package installation.
- Snapshot entry/file/total bounds, copy races, and generated/native-binary exclusions behave as specified. Each of two checks receives identical snapshot bytes but distinct container identity and writable state.
- `/workspace` and `/tmp` writes cannot exceed configured sizes; root filesystem writes fail; verify tmpfs and cgroup accounting on supported Docker backends.
- Output flooding stops the process at the combined capture cap, limits model-visible output, and leaves no unbounded daemon log. Timeout, OOM, cleanup retry exhaustion, and interrupted startup all fail closed.
- Changing any fingerprint input marks the image stale; ordinary source edits do not. Running by image ID remains stable if a readable tag moves.

## Validation gates (not clarification questions)

The plan selects the Node standard-library CONNECT broker, strict YAML/Zod lockfile parser, private atomic metadata, and bounded staging. These are implementation obligations rather than open design choices. Linux integration fixtures must prove broker allowlist/IP pinning and direct-bypass prevention; pnpm must fetch only the validated graph and verify integrity; byte/time/store/image/staging caps must hold under expansion; Docker runtime limits and tmpfs must be inspected on Docker Engine and Docker Desktop Linux mode; cancellation and ownership cleanup must remain bounded. Preparation is blocked if the external builder/daemon storage boundary is absent or any bound cannot be enforced. Do not fall back to public egress, unrestricted host execution, scripts during fetch, unbounded storage, or mutable image tags.
