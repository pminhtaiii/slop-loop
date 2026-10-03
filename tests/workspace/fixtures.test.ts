import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { describe, expect, it } from "vitest";

import { createGitCheckout } from "./fixtures.js";

describe("Git checkout fixture", () => {
  it("creates its own repository despite inherited Git location overrides", () => {
    const previous = process.env.GIT_DIR;
    process.env.GIT_DIR = path.join(os.tmpdir(), "nonexistent-git-dir");
    try {
      const fixture = createGitCheckout();
      try {
        expect(fs.existsSync(path.join(fixture.root, ".git"))).toBe(true);
      } finally {
        fixture.cleanup();
      }
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previous;
    }
  });
});
