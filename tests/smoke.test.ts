import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { start } from "../src/index.js";

function createMemoryStream(): { stream: Writable; getLines: () => string[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });

  return {
    stream,
    getLines: () =>
      chunks
        .join("")
        .split("\n")
        .filter((line) => line.trim().length > 0),
  };
}

describe("Application startup smoke tests", () => {
  it("starts successfully with default config and emits a structured startup record at info level", () => {
    const memory = createMemoryStream();
    const result = start({
      env: {},
      destination: memory.stream,
    });

    expect(result.status).toBe("started");
    expect(result.config.logLevel).toBe("info");

    const lines = memory.getLines();
    expect(lines.length).toBeGreaterThan(0);

    const firstRecord = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(firstRecord.level).toBe(30); // Pino info level is 30
    expect(firstRecord.status).toBe("started");
  });

  it("respects configured log level such as warn, suppressing info-level startup records", () => {
    const memory = createMemoryStream();
    const result = start({
      env: { SLOP_LOOP_LOG_LEVEL: "warn" },
      destination: memory.stream,
    });

    expect(result.status).toBe("started");
    expect(result.config.logLevel).toBe("warn");

    const lines = memory.getLines();
    expect(lines.length).toBe(0);
  });

  it("fails with a bounded diagnostic when configuration has an invalid log level", () => {
    expect(() =>
      start({
        env: { SLOP_LOOP_LOG_LEVEL: "invalid_level" },
      }),
    ).toThrowError(/Invalid SLOP_LOOP_LOG_LEVEL/);
  });

  it("fails with a bounded diagnostic when an unknown SLOP_LOOP_* variable is provided", () => {
    expect(() =>
      start({
        env: { SLOP_LOOP_UNKNOWN_VAR: "some_value" },
      }),
    ).toThrowError(/Unknown application configuration setting\(s\)/);
  });
});

describe("Packaging and verification boundary contract (User Story 3 / T018)", () => {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const rootDir = path.resolve(currentDir, "..");
  const packageJsonPath = path.join(rootDir, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as {
    private?: boolean;
    type?: string;
    main?: string;
    exports?: unknown;
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
  };

  it("defines explicit verification scripts matching verification.md contract", () => {
    const scripts = packageJson.scripts ?? {};

    // Source testing is independent and uses vitest
    expect(scripts.test).toBe("vitest run");

    // Build targets compiled output via tsc
    expect(scripts.build).toBe("tsc");

    // Smoke executes compiled entrypoint directly with node dist/index.js
    expect(scripts.smoke).toBe("node dist/index.js");

    // Quality gate scripts
    expect(scripts.lint).toBe("eslint .");
    expect(scripts["format:check"]).toBe("prettier --check .");
    expect(scripts.format).toBe("prettier --write .");
    expect(scripts.typecheck).toBe("tsc --noEmit && tsc -p tsconfig.test.json --noEmit");
  });

  it("enforces private application boundaries without package self-reference or publication artifacts", () => {
    expect(packageJson.private).toBe(true);
    expect(packageJson.type).toBe("module");

    // No package exports map or published entrypoints
    expect(packageJson.exports).toBeUndefined();
    expect(packageJson.main).toBeUndefined();

    // No package self-reference
    expect(packageJson.dependencies?.["slop-loop"]).toBeUndefined();
  });

  it("configures tsconfig.json to emit source to dist without including tests", () => {
    const tsconfigPath = path.join(rootDir, "tsconfig.json");
    const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, "utf-8")) as {
      compilerOptions?: {
        rootDir?: string;
        outDir?: string;
      };
      include?: string[];
      exclude?: string[];
    };

    expect(tsconfig.compilerOptions?.rootDir).toBe("src");
    expect(tsconfig.compilerOptions?.outDir).toBe("dist");
    expect(tsconfig.include).toEqual(["src/**/*"]);
    expect(tsconfig.exclude).toContain("tests/**/*");
    expect(tsconfig.exclude).toContain("dist");
  });

  it("configures vitest.config.ts for source tests without requiring or referencing dist", () => {
    const vitestConfigPath = path.join(rootDir, "vitest.config.ts");
    const content = fs.readFileSync(vitestConfigPath, "utf-8");

    expect(content).toContain("tests/**/*.test.ts");
    expect(content).not.toContain("dist");
  });

  it("ensures source and test files do not import from dist or use package self-reference", () => {
    const scanDirs = [path.join(rootDir, "src"), path.join(rootDir, "tests")];
    const scannedFiles: string[] = [];

    for (const dir of scanDirs) {
      const files = fs.readdirSync(dir).filter((file) => file.endsWith(".ts"));
      for (const file of files) {
        scannedFiles.push(path.join(dir, file));
      }
    }

    expect(scannedFiles.length).toBeGreaterThan(0);

    for (const filePath of scannedFiles) {
      const content = fs.readFileSync(filePath, "utf-8");

      // Must not import from dist
      expect(content).not.toMatch(/(from|import)\s+["'].*?\bdist(\/|["'])/);

      // Must not import from package self-reference (e.g. "slop-loop" or "slop-loop/...")
      expect(content).not.toMatch(/(from|import)\s+["']slop-loop(\/|["'])/);
    }
  });

  it("reports failure when the compiled artifact does not exist (SC-004 / US3 Scenario 4)", () => {
    const distIndexPath = path.join(rootDir, "dist", "index.js");
    if (!fs.existsSync(distIndexPath)) {
      const result = spawnSync(process.execPath, [distIndexPath], { encoding: "utf-8" });
      expect(result.status).not.toBe(0);
    }
  });
});
