import { describe, expect, it } from "vitest";

import { requireDockerImage, runDocker } from "./integration-fixtures.js";

describe("Phase 5 Docker security integration (T127)", () => {
  it("enforces non-root, offline, read-only and capability boundaries", ({ skip }) => {
    requireDockerImage({ skip }, "alpine:3.20");
    const output = runDocker([
      "run",
      "--rm",
      "--pull=never",
      "--network",
      "none",
      "--user",
      "1000:1000",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,noexec,size=16m",
      "--pids-limit",
      "32",
      "--memory",
      "64m",
      "--cpus",
      "0.25",
      "alpine:3.20",
      "sh",
      "-c",
      'test "$(id -u)" = 1000 && test "$(awk "NR>1 {print}" /proc/net/route | wc -l)" -eq 0 && test ! -e /var/run/docker.sock && touch /tmp/allowed',
    ]);
    expect(output).toBe("");
  });

  it("enforces the bounded writable tmpfs instead of host fallback", ({ skip }) => {
    requireDockerImage({ skip }, "alpine:3.20");
    expect(() =>
      runDocker([
        "run",
        "--rm",
        "--pull=never",
        "--network",
        "none",
        "--read-only",
        "--tmpfs",
        "/tmp:rw,size=1m",
        "alpine:3.20",
        "sh",
        "-c",
        "dd if=/dev/zero of=/tmp/overflow bs=2M count=1",
      ]),
    ).toThrow();
  });

  it("enforces PID limit and prevents process exhaustion attack", ({ skip }) => {
    requireDockerImage({ skip }, "alpine:3.20");
    expect(() =>
      runDocker([
        "run",
        "--rm",
        "--pull=never",
        "--network",
        "none",
        "--read-only",
        "--pids-limit",
        "16",
        "alpine:3.20",
        "sh",
        "-c",
        ":(){ :|:& };:",
      ]),
    ).toThrow();
  });

  it("proves network denial blocks DNS and external TCP egress", ({ skip }) => {
    requireDockerImage({ skip }, "alpine:3.20");
    expect(() =>
      runDocker([
        "run",
        "--rm",
        "--pull=never",
        "--network",
        "none",
        "alpine:3.20",
        "nc",
        "-w",
        "1",
        "8.8.8.8",
        "53",
      ]),
    ).toThrow();
  });
});
