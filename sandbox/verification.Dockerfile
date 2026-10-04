FROM node:24.0.0-bookworm-slim@sha256:7b0f9cbb3f88da0e67873be5efcf38ce79ea25cfbb4986fad55a446af484e7c9

RUN corepack enable && corepack prepare pnpm@12.5.1 --activate
RUN apt-get update \
  && apt-get install --no-install-recommends --yes python3 g++ \
  && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 1000 --shell /usr/sbin/nologin verifier
USER verifier
WORKDIR /workspace
