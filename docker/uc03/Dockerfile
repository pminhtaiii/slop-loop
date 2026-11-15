# UC-03 prepared runtime. No default base: build with a digest-pinned reference, e.g.
#   docker build --build-arg PYTHON_BASE=python@sha256:<64 hex> -t uc03-pytest:real-tier docker/uc03
# The run-time identity is the built image ID (`docker image inspect --format '{{.Id}}'`), which the
# profile pins and runArguments passes with --pull=never, so a run never contacts a registry.
ARG PYTHON_BASE
FROM ${PYTHON_BASE}

# Test dependencies are pinned at build time; the final image ID pins every installed byte.
RUN pip install --no-cache-dir \
    pytest==8.3.4 \
    iniconfig==2.0.0 \
    packaging==24.2 \
    pluggy==1.5.0

RUN adduser -D -u 1000 runner && mkdir -p /workspace/repo /workspace/scratch && chown -R 1000:1000 /workspace

USER 1000:1000
