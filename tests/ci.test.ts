import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const CI_WORKFLOW_PATH = path.join(ROOT_DIR, ".github", "workflows", "ci.yml");

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string>;
}

interface Job {
  id: string;
  name?: string;
  runsOn?: string;
  steps: Step[];
}

function parseKeyValue(line: string): { key: string; value: string } | null {
  const colonIndex = line.indexOf(":");
  if (colonIndex === -1) {
    return null;
  }
  const key = line.slice(0, colonIndex).trim();
  const value = line
    .slice(colonIndex + 1)
    .replace(/['"]/g, "")
    .trim();
  return { key, value };
}

/**
 * Lightweight deterministic parser for GitHub Actions CI workflow YAML.
 * Extracts triggers, permissions, and jobs without introducing unapproved runtime dependencies.
 */
function parseWorkflow(content: string): {
  permissions: Record<string, string>;
  triggers: { push?: { branches?: string[] }; pullRequest?: boolean };
  jobs: Record<string, Job>;
} {
  const lines = content.split(/\r?\n/);
  const permissions: Record<string, string> = {};
  const triggers: { push?: { branches?: string[] }; pullRequest?: boolean } = {};
  const jobs: Record<string, Job> = {};

  let currentSection = "";
  let currentJobId = "";
  let currentJob: Job | null = null;
  let currentStep: Step | null = null;
  let inPushBranches = false;

  let currentStepBlock = "";

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!;
    const trimmed = rawLine.trim();

    // Skip empty lines and full-line comments
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }

    const indent = rawLine.search(/\S/);

    if (indent === 0) {
      inPushBranches = false;
      currentStepBlock = "";
      if (trimmed.startsWith("on:")) {
        currentSection = "on";
      } else if (trimmed.startsWith("permissions:")) {
        currentSection = "permissions";
      } else if (trimmed.startsWith("jobs:")) {
        currentSection = "jobs";
      } else {
        currentSection = "";
      }
      continue;
    }

    if (currentSection === "permissions") {
      if (indent === 2) {
        const parsed = parseKeyValue(trimmed);
        if (parsed) {
          permissions[parsed.key] = parsed.value;
        }
      }
      continue;
    }

    if (currentSection === "on") {
      if (indent === 2) {
        inPushBranches = false;
        if (trimmed.startsWith("push:")) {
          triggers.push = {};
        } else if (trimmed.startsWith("pull_request:")) {
          triggers.pullRequest = true;
        }
      } else if (indent === 4 && triggers.push && trimmed.startsWith("branches:")) {
        triggers.push.branches = [];
        inPushBranches = true;
      } else if (indent === 6 && inPushBranches && trimmed.startsWith("-")) {
        const branch = trimmed.replace(/^-\s*/, "").replace(/['"]/g, "").trim();
        triggers.push?.branches?.push(branch);
      }
      continue;
    }

    if (currentSection === "jobs") {
      if (indent === 2 && trimmed.endsWith(":")) {
        // New job declaration
        currentJobId = trimmed.slice(0, -1);
        currentJob = {
          id: currentJobId,
          steps: [],
        };
        jobs[currentJobId] = currentJob;
        currentStep = null;
        currentStepBlock = "";
      } else if (currentJob && indent === 4) {
        const parsed = parseKeyValue(trimmed);
        if (parsed) {
          if (parsed.key === "runs-on") {
            currentJob.runsOn = parsed.value;
          } else if (parsed.key === "name") {
            currentJob.name = parsed.value;
          }
        }
      } else if (currentJob && indent >= 6) {
        if (trimmed.startsWith("- ")) {
          currentStep = {};
          currentJob.steps.push(currentStep);
          currentStepBlock = "";
          const stepLine = trimmed.replace(/^-\s*/, "");
          const parsed = parseKeyValue(stepLine);
          if (parsed) {
            applyStepProperty(currentStep, parsed.key, parsed.value);
          }
        } else if (currentStep) {
          if (trimmed === "with:") {
            currentStepBlock = "with";
          } else if (trimmed.endsWith(":") && !trimmed.includes(" ")) {
            currentStepBlock = trimmed.slice(0, -1);
          } else if (currentStepBlock === "with" && indent > 8) {
            const parsed = parseKeyValue(trimmed);
            if (parsed) {
              currentStep.with = currentStep.with ?? {};
              currentStep.with[parsed.key] = parsed.value;
            }
          } else {
            currentStepBlock = "";
            const parsed = parseKeyValue(trimmed);
            if (parsed) {
              applyStepProperty(currentStep, parsed.key, parsed.value);
            }
          }
        }
      }
    }
  }

  return { permissions, triggers, jobs };
}

function applyStepProperty(step: Step, key: string, value: string): void {
  switch (key) {
    case "name":
      step.name = value;
      break;
    case "uses":
      step.uses = value;
      break;
    case "run":
      step.run = value;
      break;
    default:
      break;
  }
}

function assertToolchainSetup(job: Job): void {
  const checkoutStep = job.steps.find((s) => s.uses?.startsWith("actions/checkout"));
  expect(checkoutStep, `Expected actions/checkout step in job ${job.id}`).toBeDefined();
  expect(checkoutStep?.with?.["persist-credentials"]).toBe("false");

  const pnpmSetup = job.steps.find((s) => s.uses?.startsWith("pnpm/action-setup"));
  expect(pnpmSetup, `Expected pnpm/action-setup step in job ${job.id}`).toBeDefined();
  expect(pnpmSetup?.with?.version).toMatch(/^12(\.|$)/);

  const nodeSetup = job.steps.find((s) => s.uses?.startsWith("actions/setup-node"));
  expect(nodeSetup, `Expected actions/setup-node step in job ${job.id}`).toBeDefined();
  expect(nodeSetup?.with?.["node-version"]).toMatch(/^24(\.|$)/);

  const installStep = job.steps.find((s) => s.run?.includes("pnpm install"));
  expect(installStep, `Expected pnpm install step in job ${job.id}`).toBeDefined();
  expect(installStep?.run).toBe("pnpm install --frozen-lockfile");
}

describe("Platform Quality Gates Workflow Contract (User Story 4 / T022)", () => {
  it("ensures .github/workflows/ci.yml exists and is not empty", () => {
    expect(
      fs.existsSync(CI_WORKFLOW_PATH),
      `Expected CI workflow to exist at ${CI_WORKFLOW_PATH}`,
    ).toBe(true);

    const content = fs.readFileSync(CI_WORKFLOW_PATH, "utf-8");
    expect(content.trim().length).toBeGreaterThan(0);
  });

  it("configures workflow permissions to contents: read (least privilege principle)", () => {
    const content = fs.readFileSync(CI_WORKFLOW_PATH, "utf-8");
    const { permissions } = parseWorkflow(content);

    expect(permissions.contents).toBe("read");
  });

  it("configures pull_request and default-branch push triggers (FR-010, FR-011, SC-005)", () => {
    const content = fs.readFileSync(CI_WORKFLOW_PATH, "utf-8");
    const { triggers } = parseWorkflow(content);

    expect(triggers.pullRequest).toBe(true);
    expect(triggers.push).toBeDefined();
    // Default branch must be exactly main (SC-005 / US4 scenarios)
    expect(triggers.push?.branches).toEqual(["main"]);
  });

  it("defines an Ubuntu gate executing the complete quality verification sequence (FR-010, SC-005)", () => {
    const content = fs.readFileSync(CI_WORKFLOW_PATH, "utf-8");
    const { jobs } = parseWorkflow(content);

    const ubuntuJob = Object.values(jobs).find((job) => job.runsOn === "ubuntu-latest");
    expect(ubuntuJob, "Expected a job configured with runs-on: ubuntu-latest").toBeDefined();

    assertToolchainSetup(ubuntuJob!);

    // Verify complete non-mutating quality sequence in exact order and count
    const runCommands = ubuntuJob!.steps.map((s) => s.run).filter((r): r is string => Boolean(r));

    const expectedSequence = [
      "pnpm install --frozen-lockfile",
      "pnpm lint",
      "pnpm format:check",
      "pnpm typecheck",
      "pnpm test",
      "pnpm build",
      "pnpm smoke",
    ];

    expect(runCommands).toEqual(expectedSequence);
  });

  it("defines a Windows gate executing install, test, build, and smoke while omitting redundant checks (FR-011, SC-005)", () => {
    const content = fs.readFileSync(CI_WORKFLOW_PATH, "utf-8");
    const { jobs } = parseWorkflow(content);

    const windowsJob = Object.values(jobs).find((job) => job.runsOn === "windows-latest");
    expect(windowsJob, "Expected a job configured with runs-on: windows-latest").toBeDefined();

    assertToolchainSetup(windowsJob!);

    // Verify runtime/build/smoke sequence in exact order and count
    const runCommands = windowsJob!.steps.map((s) => s.run).filter((r): r is string => Boolean(r));

    const expectedSequence = [
      "pnpm install --frozen-lockfile",
      "pnpm test",
      "pnpm build",
      "pnpm smoke",
    ];

    expect(runCommands).toEqual(expectedSequence);

    // Windows must omit redundant formatting, lint, and typecheck checks
    expect(runCommands).not.toContain("pnpm lint");
    expect(runCommands).not.toContain("pnpm format:check");
    expect(runCommands).not.toContain("pnpm typecheck");
  });

  it("enforces scope guardrails: no release, publish, deploy, or distribution steps (FR-012, SC-006)", () => {
    const content = fs.readFileSync(CI_WORKFLOW_PATH, "utf-8");
    const { jobs } = parseWorkflow(content);

    // Must have exactly the two platform gate jobs
    const jobIds = Object.keys(jobs);
    expect(jobIds.length).toBe(2);

    for (const job of Object.values(jobs)) {
      // Job name/id must not suggest release or deployment
      expect(job.id.toLowerCase()).not.toMatch(/(release|publish|deploy|distribute)/);
      if (job.name) {
        expect(job.name.toLowerCase()).not.toMatch(/(release|publish|deploy|distribute)/);
      }

      // Steps must not invoke release, publish, deploy, or distribution commands/actions
      for (const step of job.steps) {
        if (step.run) {
          expect(step.run.toLowerCase()).not.toMatch(/(publish|release|deploy)/);
        }
        if (step.uses) {
          expect(step.uses.toLowerCase()).not.toMatch(/(upload-artifact|release|publish|deploy)/);
        }
      }
    }
  });
});
