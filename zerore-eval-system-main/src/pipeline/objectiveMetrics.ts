/**
 * @fileoverview Deterministic objective metric aggregation.
 */

import type { EnrichedChatlogRow, ObjectiveMetrics } from "@/types/pipeline";

/**
 * Build objective metrics from enriched rows.
 * @param rows Enriched rows.
 * @returns Objective metric summary.
 */
export function buildObjectiveMetrics(rows: EnrichedChatlogRow[]): ObjectiveMetrics {
  const sessionGroups = [...groupRowsBySession(rows).values()];
  const sessionDepthDistribution = sessionGroups.reduce<Record<string, number>>(
    (acc, sessionRows) => {
      const maxTurn = Math.max(...sessionRows.map((row) => row.turnIndex));
      const bucket = maxTurn <= 3 ? "1-3" : maxTurn <= 8 ? "4-8" : "9+";
      acc[bucket] = (acc[bucket] ?? 0) + 1;
      return acc;
    },
    {},
  );

  const dropoffTurnDistribution = rows
    .filter((row) => row.isDropoffTurn)
    .reduce<Record<string, number>>((acc, row) => {
      const key = String(row.turnIndex);
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});

  const gapRows = rows
    .map((row) => row.responseGapSec)
    .filter((gap): gap is number => typeof gap === "number");
  const avgResponseGapSec = gapRows.length
    ? Number((gapRows.reduce((sum, gap) => sum + gap, 0) / gapRows.length).toFixed(2))
    : 0;

  const sessionTopicSwitchCounts = sessionGroups.map(
    (sessionRows) => new Set(sessionRows.map((row) => row.topicSegmentId)).size - 1,
  );
  const topicSwitchRate = sessionTopicSwitchCounts.length
    ? Number(
        (
          sessionTopicSwitchCounts.reduce((sum, count) => sum + Math.max(0, count), 0) /
          sessionTopicSwitchCounts.length
        ).toFixed(4),
      )
    : 0;

  const activeHourDistribution = rows.reduce<Record<string, number>>((acc, row) => {
    const key = row.activeHour === null ? "unknown" : String(row.activeHour);
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  const userRows = rows.filter((row) => row.role === "user");
  const assistantRows = rows.filter((row) => row.role === "assistant");

  return {
    sessionDepthDistribution,
    dropoffTurnDistribution,
    avgResponseGapSec,
    topicSwitchRate,
    userQuestionRepeatRate: buildUserQuestionRepeatRate(sessionGroups),
    agentResolutionSignalRate: buildAgentResolutionSignalRate(sessionGroups),
    escalationKeywordHitRate: buildEscalationKeywordHitRate(sessionGroups),
    activeHourDistribution,
    userQuestionRate: userRows.length
      ? Number((userRows.filter((row) => row.isQuestion).length / userRows.length).toFixed(4))
      : 0,
    avgUserMessageLength: averageLength(userRows),
    userMessageLengthTrend: buildLengthTrend(userRows),
    avgAssistantMessageLength: averageLength(assistantRows),
  };
}

/**
 * Compute average message length for a role slice.
 * @param rows Enriched rows slice.
 * @returns Average message length.
 */
function averageLength(rows: EnrichedChatlogRow[]): number {
  if (rows.length === 0) {
    return 0;
  }
  return Number((rows.reduce((sum, row) => sum + row.content.length, 0) / rows.length).toFixed(2));
}

/**
 * Build a simple user message length trend slope.
 * @param rows User rows.
 * @returns Trend value where negative means shrinking messages.
 */
function buildLengthTrend(rows: EnrichedChatlogRow[]): number {
  if (rows.length <= 1) {
    return 0;
  }

  const n = rows.length;
  const xMean = (n - 1) / 2;
  const yMean = rows.reduce((sum, row) => sum + row.content.length, 0) / n;
  let numerator = 0;
  let denominator = 0;

  rows.forEach((row, index) => {
    numerator += (index - xMean) * (row.content.length - yMean);
    denominator += (index - xMean) ** 2;
  });

  if (denominator === 0) {
    return 0;
  }

  return Number((numerator / denominator).toFixed(4));
}

/**
 * Group rows by session identifier.
 * @param rows Enriched rows.
 * @returns Session map.
 */
function groupRowsBySession(rows: EnrichedChatlogRow[]): Map<string, EnrichedChatlogRow[]> {
  const grouped = new Map<string, EnrichedChatlogRow[]>();
  rows.forEach((row) => {
    if (!grouped.has(row.sessionId)) {
      grouped.set(row.sessionId, []);
    }
    grouped.get(row.sessionId)?.push(row);
  });
  return grouped;
}

/**
 * Build repeat-question rate from normalized user question fingerprints.
 * @param sessionGroups Session-grouped rows.
 * @returns Repeat-question rate in the 0-1 range.
 */
function buildUserQuestionRepeatRate(sessionGroups: EnrichedChatlogRow[][]): number {
  const questionFingerprints = sessionGroups.flatMap((sessionRows) =>
    sessionRows
      .filter((row) => row.role === "user" && row.isQuestion)
      .map((row) => normalizeQuestionFingerprint(row.content))
      .filter((value) => value.length > 0),
  );

  if (questionFingerprints.length === 0) {
    return 0;
  }

  const counts = new Map<string, number>();
  questionFingerprints.forEach((fingerprint) => {
    counts.set(fingerprint, (counts.get(fingerprint) ?? 0) + 1);
  });
  const repeatedCount = [...counts.values()].reduce(
    (sum, count) => sum + (count >= 2 ? count - 1 : 0),
    0,
  );
  return Number((repeatedCount / questionFingerprints.length).toFixed(4));
}

/**
 * Build the rate of sessions whose assistant turns contain a resolution signal.
 * @param sessionGroups Session-grouped rows.
 * @returns Session-level resolution-signal rate.
 */
function buildAgentResolutionSignalRate(sessionGroups: EnrichedChatlogRow[][]): number {
  if (sessionGroups.length === 0) {
    return 0;
  }

  const hitCount = sessionGroups.filter((sessionRows) => hasResolutionSignal(sessionRows)).length;
  return Number((hitCount / sessionGroups.length).toFixed(4));
}

/**
 * Build the rate of sessions that hit escalation keywords.
 * @param sessionGroups Session-grouped rows.
 * @returns Session-level escalation hit rate.
 */
function buildEscalationKeywordHitRate(sessionGroups: EnrichedChatlogRow[][]): number {
  if (sessionGroups.length === 0) {
    return 0;
  }

  const hitCount = sessionGroups.filter((sessionRows) => hasEscalationKeyword(sessionRows)).length;
  return Number((hitCount / sessionGroups.length).toFixed(4));
}

/**
 * Detect whether a session contains a clear resolution-oriented assistant action.
 * @param sessionRows Session rows.
 * @returns Whether the session has a resolution signal.
 */
function hasResolutionSignal(sessionRows: EnrichedChatlogRow[]): boolean {
  return sessionRows.some(
    (row) =>
      row.role === "assistant" &&
      /(已(经)?(为您|帮您)?(处理|提交|安排|登记|解决)|预计.*(回复|发出)|工单号|已提交权限申请|补发|退款)/.test(
        row.content,
      ),
  );
}

/**
 * Detect whether one session contains escalation or complaint keywords.
 * @param sessionRows Session rows.
 * @returns Whether escalation intent appears.
 */
function hasEscalationKeyword(sessionRows: EnrichedChatlogRow[]): boolean {
  return sessionRows.some((row) => /(转人工|投诉|主管|经理|升级专员|人工复核|工单)/.test(row.content));
}

/**
 * Normalize question text for coarse repeat detection.
 * @param value Question text.
 * @returns Short fingerprint.
 */
function normalizeQuestionFingerprint(value: string): string {
  return value.replace(/[？?，,。.!！\s]/g, "").slice(0, 18);
}
