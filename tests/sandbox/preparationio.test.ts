import { expect, it } from "vitest";
import * as io from "../../src/sandbox/preparationio.js";

it("rejects non-local or mutable resource selectors before starting a Docker transport", async () => {
  await expect(
    io.localPreparationDockerIO(
      ["exec", "-i", "mutable-tag", "node", "worker"],
      Buffer.alloc(0),
      new AbortController().signal,
    ),
  ).rejects.toThrow("Immutable preparation resource unavailable");
});
it("keeps artifact transfers short while allowing bounded offline worker phases", () => {
  expect(io.preparationTransportTimeout("artifact")).toBe(60_000);
  for (const phase of ["fetch", "materialize", "import", "scripts"] as const)
    expect(io.preparationTransportTimeout(phase)).toBe(15 * 60_000);
});
