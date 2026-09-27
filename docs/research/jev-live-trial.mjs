// One-off research probe. Run with: node --env-file=.env docs/research/jev-live-trial.mjs small
// The key stays in process memory; output contains only selected response fields.

const cases = {
  small: "Correct the typo 'recieve' in one README sentence and check the edited file.",
  medium:
    "Add validation for one configuration option in a TypeScript CLI, update focused tests, then run lint, typecheck, and tests.",
  large:
    "Refactor authentication across six packages, migrate persisted sessions without breaking old clients, add integration tests, and run the full suite.",
};

const caseName = process.argv[2];
if (!Object.hasOwn(cases, caseName)) {
  console.log(JSON.stringify({ error: "unknown_case" }));
  process.exitCode = 2;
} else if (!process.env.BEATAPI_API_KEY) {
  console.log(JSON.stringify({ error: "missing_key" }));
  process.exitCode = 2;
} else {
  const body = {
    model: "jev-1.13-free",
    state: cases[caseName],
    questions: {
      task_size: {
        type: "choice",
        instructions:
          "Based only on this developer request, estimate the coding task's likely work size. This is a planning estimate, not authorization or a budget decision.",
        criteria: {
          small: "A localized change to one file with a quick focused check.",
          medium: "An ordinary change across a few files with tests or several routine checks.",
          large: "Broad cross-module or multi-package work with migration or extensive verification.",
        },
      },
    },
  };

  const started = performance.now();
  try {
    const response = await fetch("https://api.beatapi.io/v1/systemone", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.BEATAPI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const elapsedMs = Math.round(performance.now() - started);
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      console.log(
        JSON.stringify({ case: caseName, status: response.status, elapsedMs, error: result?.error?.code ?? "http_error" }),
      );
      process.exitCode = 1;
    } else {
      const answer = result?.answers?.task_size;
      const labels = ["small", "medium", "large"];
      const valid =
        answer?.type === "choice" &&
        labels.includes(answer.choice) &&
        Number.isFinite(answer.confidence) &&
        answer.confidence >= 0 &&
        answer.confidence <= 1 &&
        labels.every((label) =>
          Number.isFinite(answer.probabilities?.[label]) &&
          answer.probabilities[label] >= 0 &&
          answer.probabilities[label] <= 1,
        );
      console.log(
        JSON.stringify({
          case: caseName,
          status: response.status,
          elapsedMs,
          model: result?.model ?? null,
          valid,
          ...(valid
            ? { choice: answer.choice, confidence: answer.confidence, probabilities: answer.probabilities }
            : {}),
        }),
      );
      if (!valid) process.exitCode = 1;
    }
  } catch (error) {
    console.log(
      JSON.stringify({
        case: caseName,
        error: error instanceof Error ? error.name : "request_failed",
        elapsedMs: Math.round(performance.now() - started),
      }),
    );
    process.exitCode = 1;
  }
}
