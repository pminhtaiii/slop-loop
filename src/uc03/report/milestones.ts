import type { ActivityEvent } from '../../contracts/foundation/uc03.ts';
import { boundedText, MAX_REPORT_BYTES, reportMilestones } from './sanitize.ts';
import type { Milestone } from '../report.ts';

export function milestoneToActivityEvent(milestone: Milestone, durationMs = 0): ActivityEvent {
  try {
    const safeMilestone = reportMilestones([milestone])[0];
    if (!safeMilestone) throw new Error('Invalid report milestone');
    return Object.freeze({
      eventId: safeMilestone.milestoneId,
      taskId: safeMilestone.taskId,
      runId: safeMilestone.runId,
      timestamp: safeMilestone.timestamp,
      node: safeMilestone.node,
      actionType: safeMilestone.kind,
      outcome: safeMilestone.outcome,
      durationMs: Number.isFinite(durationMs) ? Math.max(0, Math.floor(durationMs)) : 0,
      evidenceRefs: safeMilestone.evidenceRefs,
    });
  } catch {
    throw new Error('Invalid report milestone');
  }
}

export function formatMilestonesSummary(milestones: readonly Milestone[]): string {
  try {
    const safeMilestones = reportMilestones(milestones);
    if (safeMilestones.length === 0) return 'No milestone events recorded.';
    return boundedText(safeMilestones.map((milestone) => {
      const mark = milestone.outcome === 'success' ? '✓' : milestone.outcome === 'failure' ? '✗' : '•';
      return `[${milestone.timestamp}] ${mark} [${milestone.node}] ${milestone.kind}: ${milestone.summary}`;
    }).join('\n'), MAX_REPORT_BYTES);
  } catch {
    throw new Error('Invalid report milestone');
  }
}
