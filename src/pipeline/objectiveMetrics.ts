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
  const sessionDepthDistribution = [...groupRowsBySession(rows).values()].reduce<Record<string, number>>(
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

  const sessionTopicSwitchCounts = [...groupRowsBySession(rows).values()].map(
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
