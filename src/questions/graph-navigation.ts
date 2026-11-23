/** Run-local metadata continuation. Adapter cursors remain private until every retained entry is exposed. */
import { randomUUID } from 'node:crypto';
import { normalizeLexicalPath } from '../contracts/foundation/uc03.ts';
import type { QuestionModelDecisionV1 } from '../contracts/questions/contracts.ts';
import type { QuestionInvestigationConfiguration } from './graph-types.ts';

type NavigationDecision = Extract<QuestionModelDecisionV1, { kind: 'list' | 'search' }>;
export interface QuestionNavigationPage {
  readonly kind: 'list' | 'search';
  readonly coverage: string;
  readonly omissionReasons: readonly string[];
  readonly nextCursor?: string | undefined;
  readonly entries?: readonly unknown[];
  readonly hits?: readonly unknown[];
  readonly [key: string]: unknown;
}
interface RetainedPage {
  readonly page: QuestionNavigationPage;
  readonly offset: number;
  readonly scope: string;
}
export type QuestionNavigationLookup = { readonly kind: 'miss' } | { readonly kind: 'invalid' } | { readonly kind: 'cached'; readonly retained: RetainedPage; readonly token?: string };
export interface QuestionNavigationProjection {
  readonly observation: string | undefined;
  readonly returnedBytes: number;
  /** Commit only after admitted work settles and the graph's stop checks pass. */
  commit(): void;
}
export interface QuestionNavigation {
  lookup(decision: NavigationDecision): QuestionNavigationLookup;
  project(decision: NavigationDecision, page: QuestionNavigationPage, cached?: Extract<QuestionNavigationLookup, { kind: 'cached' }>): QuestionNavigationProjection;
  close(): void;
}

const localPrefix = 'question-nav-';

/** Metadata memory is bounded by the admitted tool/page/returned-byte limits and discarded at run close. */
export function createQuestionNavigation(config: QuestionInvestigationConfiguration): QuestionNavigation {
  const tokens = new Map<string, RetainedPage>();
  const pending = new Map<string, RetainedPage>();
  const adapterTokens = new Map<string, Set<string>>();
  const binding = JSON.stringify([config.identity, config.snapshot.snapshotId, config.snapshot.manifestDigest, config.generationId]);
  const scope = (decision: NavigationDecision) =>
    JSON.stringify([
      binding,
      decision.kind,
      decision.kind === 'list' ? normalizeLexicalPath(decision.path) : [decision.query, decision.pathPrefix === undefined ? null : normalizeLexicalPath(decision.pathPrefix)],
    ]);
  const requestKey = (decision: NavigationDecision) => JSON.stringify([scope(decision), decision.cursor ?? null]);
  let closed = false;
  return {
    lookup(decision) {
      if (closed) return { kind: 'invalid' };
      if (decision.cursor?.startsWith(localPrefix)) {
        const retained = tokens.get(decision.cursor);
        if (retained?.scope === scope(decision)) return { kind: 'cached', retained, token: decision.cursor };
        if (!adapterTokens.get(decision.cursor)?.has(scope(decision))) return { kind: 'invalid' };
      }
      const retained = pending.get(requestKey(decision));
      return retained ? { kind: 'cached', retained } : { kind: 'miss' };
    },
    project(decision, page, cached) {
      const key = page.kind === 'list' ? 'entries' : 'hits';
      const items = (page[key] ?? []) as readonly unknown[];
      const offset = cached?.retained.offset ?? 0;
      const remaining = items.slice(offset);
      const token = localPrefix + randomUUID();
      const serialized = (count: number, partial: boolean) =>
        JSON.stringify({
          ...page,
          [key]: remaining.slice(0, count),
          ...(partial
            ? { coverage: 'partial', omissionReasons: [...new Set([...page.omissionReasons, 'output-limit'])], truncated: true, omittedEntries: remaining.length - count, nextCursor: token }
            : {}),
        });
      const fits = (observation: string) => Buffer.byteLength(JSON.stringify([observation])) <= config.profile.runtime.maxConversationBytes;
      // The full suffix has the original adapter cursor/coverage, with no local truncation metadata.
      const full = serialized(remaining.length, false);
      let observation: string | undefined = fits(full) ? full : undefined;
      let count = observation === undefined ? 0 : remaining.length;
      if (observation === undefined && remaining.length > 0) {
        let low = 1;
        let high = remaining.length - 1;
        while (low <= high) {
          const middle = low + Math.floor((high - low) / 2);
          const candidate = serialized(middle, true);
          if (fits(candidate)) {
            count = middle;
            observation = candidate;
            low = middle + 1;
          } else high = middle - 1;
        }
      }
      let committed = false;
      return {
        observation,
        returnedBytes: observation === undefined ? 0 : Buffer.byteLength(observation),
        commit() {
          if (closed || committed) return;
          committed = true;
          if (observation === undefined) {
            // No nonempty prefix fits: keep the original request at this exact boundary.
            if (!cached?.token) pending.set(requestKey(decision), { page, offset, scope: scope(decision) });
            return;
          }
          if (cached?.token) tokens.delete(cached.token);
          pending.delete(requestKey(decision));
          if (count < remaining.length) tokens.set(token, { page, offset: offset + count, scope: scope(decision) });
          else if (page.nextCursor !== undefined) {
            const scopes = adapterTokens.get(page.nextCursor) ?? new Set<string>();
            scopes.add(scope(decision));
            adapterTokens.set(page.nextCursor, scopes);
          }
        },
      };
    },
    close() {
      closed = true;
      tokens.clear();
      pending.clear();
      adapterTokens.clear();
    },
  };
}
