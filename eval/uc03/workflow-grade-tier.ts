/**
 * Real-tier snapshot grade labels and limitations (real-tier contract §(f), §(g)).
 *
 * Neither label may claim G-ISOLATION, G-REAL or SC-001.
 */

/**
 * Real-tier label naming admission and executor identity for real-route grades.
 * Neither label may claim G-ISOLATION, G-REAL or SC-001.
 */
export function realTierGradeLabel(admissionId: string, executorId: string): string {
  return `Real-tier grade admitted by ${admissionId} and executed by ${executorId}; real isolation acceptance (G-ISOLATION, G-REAL, SC-001) is not claimed.`;
}

/** Determines whether a private grading result was produced through the real host isolation route. */
export function isRealTierGrade(hiddenResult: { readonly admissionKind?: string | undefined } | undefined): boolean {
  return hiddenResult?.admissionKind === 'host-isolation-admission';
}
