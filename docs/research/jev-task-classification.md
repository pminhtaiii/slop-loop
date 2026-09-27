# Jev for task classification

Checked 2026-09-27. This note uses TypeSafe’s own release, documentation, legal pages, and SDK repository as primary sources. Vendor performance claims are labeled as claims; conclusions about Slop Loop are inferences.

## Identification and interface

The model is **Jev**, TypeSafe AI’s first “System One” model, announced on 2026-09-15 and made available through early access. TypeSafe describes its high-level approach as a new model architecture, a parallel sampler, and Reinforcement Learning for Calibrated Decisions (RLCD). It has not published enough detail in these sources to independently assess the model architecture or training recipe. [Release](https://typesafe.ai/blog/introducing-system-one-models-and-jev)

Jev is called through TypeSafe’s hosted API: `POST https://api.typesafe.ai/v1/systemone`, using a bearer API key. A request contains a `state` (text, JSON object, or array), a model ID, and named typed questions. The three question types are:

- **Choice:** choose among up to 255 named options; returns the chosen key, option probabilities, and confidence.
- **Score:** rate against 2–10 ordered levels; returns a score, probabilities, and confidence.
- **Noul:** answer a yes/no question with a probability from 0 to 1.

Multiple questions can be sent together and are evaluated in parallel against the same state. The result is structured values, not generated prose. [API reference](https://docs.typesafe.ai/api), [Quick start](https://docs.typesafe.ai/introduction/quickstart), [Introduction](https://docs.typesafe.ai/introduction)

The current documented stable model is `jev-1.13.0`; `jev-latest` follows future releases and can change behavior. Pin a version if thresholds depend on its output. TypeSafe documents a 64k-token total request limit, including state and questions, plus a 32k limit for state plus the longest question. Input is text only. Published rate limits are 250,000 tokens/second and 1,200 requests/minute, but TypeSafe says these are being adjusted dynamically. Price is $0.042 per million input tokens; output is currently free. [Models](https://docs.typesafe.ai/models)

## Latency evidence

TypeSafe reports 70–500 ms end-to-end response times. It says its published latency evaluations generally ran from laptops on the US West Coast, where its service was then hosted. The official material does not establish a latency SLA or publish a general p50/p95/p99 bound for the user’s region, request sizes, concurrency, or service load. Treat “under 0.5 seconds” as a vendor-reported range, not a guaranteed ceiling. The release also says higher-cardinality choices may use a two-stage scoring/choice process and run slower. [Release and latency caveats](https://typesafe.ai/blog/introducing-system-one-models-and-jev)

## Fit for task classification

**Inference:** Jev’s bounded `Choice` interface fits a preliminary small/medium/large task-size estimate. Task size is harder to know at admission: hidden codebase complexity, failed checks, and repair work become visible only during execution. A prompt-only label remains an estimate that trusted code can compare with observed usage. The vendor’s own guidance favors one specific, well-scoped question at a time, decomposing broader judgments, and combining answers in ordinary code. [Introduction](https://docs.typesafe.ai/introduction), [Confidence](https://docs.typesafe.ai/confidence)

There is no first-party evaluation showing accuracy on Slop Loop developer prompts, its `INFORMATIONAL`/`CHANGE` taxonomy, or task-size labels. Evaluate it on a representative, labeled set from this project, including ambiguous prompts, mode-change language, multilingual inputs if relevant, and adversarial repository text. For size labels, compare predictions with actual model turns, tool calls, and elapsed work time, including tasks that needed repair. Measure confusion by class and confidence threshold before using its output even for workflow routing. Its confidence is derived from its returned probability distribution; TypeSafe advises choosing thresholds for the particular use case and risk. Confidence is not a correctness guarantee. [Confidence](https://docs.typesafe.ai/confidence)

## Why it must not hold security or numeric budget authority

1. **It can be semantically wrong while returning a valid typed answer.** The schema constrains the answer shape; it does not prove the classification is true. TypeSafe documents cases where Jev reads wording literally, struggles with indirection, and violates expected relationships between separate questions. [Jev 1.13 known limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13)
2. **It is susceptible to adversarial state content.** TypeSafe explicitly says Jev does not treat state as hostile by default and that injected or misleading content can move the answer. Repository text is untrusted in Slop Loop, so a classifier cannot grant Edit mode, register a tool, select a permission, set numeric limits, or trigger promotion. [Jev 1.13 known limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13)
3. **The project’s policy already forbids coding-model-owned authority.** Slop Loop’s [`tool-policy.md`](../../coding-agent-context/context/tool-policy.md) makes tool availability deterministic and says the coding model cannot register tools, alter schemas, grant capability, expand paths, enable networking, or increase budgets. Jev selects only an initial size category; trusted composition logic maps it to a fixed profile and owns all later promotions.
4. **It is a hosted dependency, not a local model.** The official path documented is an authenticated API; the official public TypeSafe repositories include a JavaScript SDK but no Jev weights repository or self-hosting instructions. I found no first-party evidence of a local Jev deployment option. That absence is not proof that no private option exists. [Quick start](https://docs.typesafe.ai/introduction/quickstart), [TypeSafe GitHub organization](https://github.com/typesafe-ai)
5. **The service is early access and has operational limits.** The API documents `429` rate limiting and `529` overload errors, recommends retry with backoff, and says limits can change dynamically. The SDK retries by default. A policy decision must therefore remain safe if the service is unavailable, slow, or returns an unusable response. [API reference](https://docs.typesafe.ai/api), [Models](https://docs.typesafe.ai/models)
6. **Sending task/repository content requires a data review.** TypeSafe’s privacy policy says it does not train or fine-tune on inputs, may disclose input to service providers, hosts services in the United States, and retains data as reasonably necessary. The model page points to zero-data-retention terms for enterprise. The site Terms say not to submit confidential or proprietary information through the Site; they also say a separate service agreement may govern product/API use. Review the applicable API agreement and retention controls before sending repository content. [Privacy policy](https://typesafe.ai/legal/privacy-policy), [Terms](https://typesafe.ai/legal/terms), [Models](https://docs.typesafe.ai/models)

## Integration and license constraints

TypeSafe publishes an official TypeScript/JavaScript SDK, `@typesafe-ai/sdk`, for Node.js 20 or newer; its SDK repository is MIT-licensed. This licenses the client library, not the Jev model or hosted service. The model itself is documented as an API service, and access requires an account API key. [SDK repository](https://github.com/typesafe-ai/typesafe-sdk-js), [SDK license](https://github.com/typesafe-ai/typesafe-sdk-js/blob/main/LICENSE), [Quick start](https://docs.typesafe.ai/introduction/quickstart)

## Conclusion

Jev is a plausible low-latency task-size classifier, but there is no evidence yet that it classifies representative Slop Loop tasks accurately. The developer chose to use its three-option `Choice` result for the initial Small, Medium, or Large profile, with Medium fallback on failure and trusted promotion when counted limits are reached. Jev cannot set numeric limits or bypass deterministic tool policy and developer-selected mode. This is an MVP decision to test in practice, not a conclusion established by the three synthetic probes below.

## BeatAPI free-tier trial (2026-09-27)

The developer supplied a [Hugging Face community guide](https://huggingface.co/blog/karmen-beatapi/how-to-use-a-free-jev-api) for BeatAPI's `jev-1.13-free` route. [BeatAPI's own product page](https://beatapi.io/jev-api) confirms that the model is currently $0 for input and output with a zero balance, requires a BeatAPI API key, and allows one successful request per minute before the first top-up. This is a third-party route, separate from TypeSafe's endpoint and credentials.

I first sent a synthetic task-size Choice request to `POST https://api.beatapi.io/v1/systemone` without credentials. The live endpoint returned HTTP `401` with `missing_api_key`; no model inference ran. The observed 563 ms covers the failed authentication request and is **not** Jev inference latency.

The developer then made a BeatAPI key available through `.env`. Node loaded that file directly with `--env-file`; I did not open or print its contents. I ran [the reproducible probe](./jev-live-trial.mjs) once per case, respecting the free tier's one-successful-request-per-minute interval. Each request used a synthetic coding-task description and the same three-option `Choice` rubric. All three calls returned HTTP 200, a valid typed response, and model ID `jev-1.13-free`:

| Synthetic task | Choice | Reported confidence | Probabilities (small / medium / large) | End-to-end time |
| --- | --- | ---: | ---: | ---: |
| Correct a README typo and check the file | small | 1.00 | 1.00 / 0 / 0 | 968 ms |
| Add one CLI config validation, focused tests, lint and typecheck | medium | 0.41 | 0.40 / 0.60 / 0 | 824 ms |
| Refactor authentication across six packages with migration and integration tests | large | 1.00 | 0 / 0 / 1.00 | 1,244 ms |

These are three obvious synthetic examples, not an accuracy benchmark. The measured times include the network path from this machine and response parsing, so they are useful for this integration but do not isolate model inference latency. No real repository content or key appeared in probe output. The medium result's split distribution illustrates why a label should remain provisional. The trial establishes that the free endpoint can be called and returns the expected typed contract; it does not establish reliable size prediction for real tasks.
