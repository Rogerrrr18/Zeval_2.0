/**
 * @fileoverview Rule-only topic-level bad case harvesting.
 */

import { findNegativeKeyword } from "@/pipeline/keywords/negative-zh";
import type { EnrichedChatlogRow, ObjectiveMetrics, SubjectiveMetrics } from "@/types/pipeline";

export type BadCaseSignal =
  | { kind: "negative_keyword"; keyword: string; turnIndex: number }
  | { kind: "metric"; metric: "responseGap" | "shortTurns" | "topicSwitch"; value: number }
  | { kind: "implicit_signal"; signalId: string };

export type HarvestedBadCase = {
  topicId: string;
  sessionId: string;
  topicIndex: number;
  topicRange: { startTurn: number; endTurn: number };
  severity: number;
  signals: BadCaseSignal[];
};

/**
 * Harvest topic-level bad cases using local rules only.
 *
 * @param rows Enriched rows.
 * @param metrics Objective metric snapshot.
 * @param signals Implicit subjective signals, used only as already-computed inputs.
 * @returns Topic-level bad case findings.
 */
export function harvestBadCases(
  rows: EnrichedChatlogRow[],
  metrics: ObjectiveMetrics,
  signals: SubjectiveMetrics["signals"],
): HarvestedBadCase[] {
  const grouped = groupRowsByTopic(rows);
  return [...grouped.entries()]
    .map(([topicId, topicRows]) => harvestTopic(topicId, topicRows, metrics, signals))
    .filter((item): item is HarvestedBadCase => item !== null)
    .sort((left, right) => right.severity - left.severity);
}

function harvestTopic(
  topicId: string,
  rows: EnrichedChatlogRow[],
  metrics: ObjectiveMetrics,
  signals: SubjectiveMetrics["signals"],
): HarvestedBadCase | null {
  const badCaseSignals: BadCaseSignal[] = [];
  let severity = 0;
  for (const row of rows) {
    if (row.role !== "user") {
      continue;
    }
    const match = findNegativeKeyword(row.content);
    if (match) {
      badCaseSignals.push({ kind: "negative_keyword", keyword: match.keyword, turnIndex: row.turnIndex });
      severity += match.weight;
    }
  }

  const maxGap = Math.max(...rows.map((row) => row.responseGapSec ?? 0), 0);
  if (maxGap >= 60) {
    badCaseSignals.push({ kind: "metric", metric: "responseGap", value: maxGap });
    severity += 0.18;
  }
  if (rows.length <= 2 && badCaseSignals.some((signal) => signal.kind === "negative_keyword")) {
    badCaseSignals.push({ kind: "metric", metric: "shortTurns", value: rows.length });
    severity += 0.12;
  }
  const topicSwitchCount = rows.filter((row) => row.isTopicSwitch).length;
  if (topicSwitchCount > 0 || metrics.topicSwitchRate >= 0.8) {
    badCaseSignals.push({ kind: "metric", metric: "topicSwitch", value: topicSwitchCount || metrics.topicSwitchRate });
    severity += 0.1;
  }

  for (const signal of signals) {
    if (signal.severity === "high" && signal.evidenceTurnRange.startsWith(`${rows[0]?.sessionId}:`)) {
      badCaseSignals.push({ kind: "implicit_signal", signalId: signal.signalKey });
      severity += 0.14;
    }
  }

  if (badCaseSignals.length === 0) {
    return null;
  }
  const first = rows[0];
  const last = rows[rows.length - 1] ?? first;
  return {
    topicId,
    sessionId: first.sessionId,
    topicIndex: first.topicSegmentIndex,
    topicRange: { startTurn: first.topicStartTurn, endTurn: last.topicEndTurn },
    severity: Math.min(1, Number(severity.toFixed(4))),
    signals: badCaseSignals,
  };
}

function groupRowsByTopic(rows: EnrichedChatlogRow[]): Map<string, EnrichedChatlogRow[]> {
  const grouped = new Map<string, EnrichedChatlogRow[]>();
  for (const row of rows) {
    const key = row.topicSegmentId;
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  return grouped;
}

