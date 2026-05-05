/**
 * @fileoverview Extract session-level bad case assets from one evaluation run.
 */

import { computeNormalizedTranscriptHash } from "@/eval-datasets/case-transcript-hash";
import { harvestBadCases, type BadCaseSignal, type HarvestedBadCase } from "@/pipeline/badCaseHarvest";
import type {
  BadCaseAsset,
  BadCaseTag,
  EnrichedChatlogRow,
  ObjectiveMetrics,
  RecoveryTraceResult,
  SubjectiveMetrics,
} from "@/types/pipeline";

type BadCaseEvidenceRow = BadCaseAsset["evidence"][number];

/**
 * Build bad case assets from enriched rows and evaluated metrics.
 *
 * @param rows Enriched rows.
 * @param objectiveMetrics Objective metrics.
 * @param subjectiveMetrics Subjective metrics.
 * @param options Build options including run identity.
 * @returns Ranked bad case assets.
 */
export function buildBadCaseAssets(
  rows: EnrichedChatlogRow[],
  _objectiveMetrics: ObjectiveMetrics,
  subjectiveMetrics: SubjectiveMetrics,
  options: {
    runId: string;
    scenarioId?: string;
  },
): BadCaseAsset[] {
  const grouped = groupRowsByTopic(rows);
  const harvested = new Map(
    harvestBadCases(rows, _objectiveMetrics, subjectiveMetrics.signals).map((item) => [item.topicId, item]),
  );
  const goalMap = new Map(subjectiveMetrics.goalCompletions.map((item) => [item.sessionId, item]));
  const recoveryMap = new Map(subjectiveMetrics.recoveryTraces.map((item) => [item.sessionId, item]));

  const assets = [...grouped.entries()]
    .map(([topicId, topicRows]) =>
      buildTopicBadCase(
        topicId,
        topicRows,
        goalMap.get(topicRows[0]?.sessionId ?? ""),
        recoveryMap.get(topicRows[0]?.sessionId ?? ""),
        harvested.get(topicId),
        options,
      ),
    )
    .filter((item): item is BadCaseAsset => item !== null)
    .sort((left, right) => right.severityScore - left.severityScore);

  return assets;
}

/**
 * Build one bad case asset for one session when failure signals are present.
 *
 * @param sessionId Session identifier.
 * @param rows Session rows.
 * @param goalCompletion Optional goal completion result.
 * @param recoveryTrace Optional recovery trace result.
 * @param options Build options.
 * @returns Bad case asset or `null`.
 */
function buildTopicBadCase(
  topicId: string,
  rows: EnrichedChatlogRow[],
  goalCompletion: SubjectiveMetrics["goalCompletions"][number] | undefined,
  recoveryTrace: RecoveryTraceResult | undefined,
  harvested: HarvestedBadCase | undefined,
  options: {
    runId: string;
    scenarioId?: string;
  },
): BadCaseAsset | null {
  const tags = new Set<BadCaseTag>();
  const evidenceRows: BadCaseEvidenceRow[] = [];
  let severityScore = harvested?.severity ?? 0;
  const autoSignals: BadCaseSignal[] = harvested?.signals ?? [];
  if (autoSignals.some((signal) => signal.kind === "negative_keyword")) {
    tags.add("understanding_barrier");
  }
  if (autoSignals.some((signal) => signal.kind === "metric" && signal.metric === "responseGap")) {
    tags.add("long_response_gap");
  }
  if (autoSignals.some((signal) => signal.kind === "metric" && signal.metric === "topicSwitch")) {
    tags.add("off_topic_shift");
  }
  evidenceRows.push(...materializeAutoSignalEvidence(autoSignals, rows));

  if (goalCompletion?.status === "failed") {
    tags.add("goal_failed");
    severityScore += 0.34;
    evidenceRows.push(...materializeGoalEvidence(goalCompletion, rows));
  } else if (goalCompletion?.status === "partial") {
    tags.add("goal_partial");
    severityScore += 0.2;
    evidenceRows.push(...materializeGoalEvidence(goalCompletion, rows));
  } else if (goalCompletion?.status === "unclear") {
    tags.add("goal_unclear");
    severityScore += 0.12;
    evidenceRows.push(...materializeGoalEvidence(goalCompletion, rows));
  }

  if (recoveryTrace?.status === "failed") {
    tags.add("recovery_failed");
    severityScore += 0.24;
    evidenceRows.push(...recoveryTrace.evidence);
  }

  const repeatedQuestionRows = findRepeatedQuestionRows(rows);
  if (repeatedQuestionRows.length > 0) {
    tags.add("question_repeat");
    severityScore += 0.18;
    evidenceRows.push(...repeatedQuestionRows);
  }

  const understandingBarrierRow = rows.find(
    (row) => row.role === "user" && /(什么意思|不懂|你是说|再说一遍|没明白|怎么理解)/.test(row.content),
  );
  if (understandingBarrierRow) {
    tags.add("understanding_barrier");
    severityScore += 0.16;
    evidenceRows.push(understandingBarrierRow);
  }

  const escalationRow = rows.find((row) => /(转人工|投诉|主管|经理|升级专员)/.test(row.content));
  if (escalationRow) {
    tags.add("escalation_keyword");
    severityScore += 0.22;
    evidenceRows.push(escalationRow);
  }

  const lowEmotionRow = rows.find((row) => row.emotionScore <= 40);
  if (lowEmotionRow) {
    tags.add("emotion_drop");
    severityScore += 0.14;
    evidenceRows.push(lowEmotionRow);
  }

  const offTopicShiftRows = findOffTopicShiftRows(rows);
  if (offTopicShiftRows.length > 0) {
    tags.add("off_topic_shift");
    severityScore += 0.16;
    evidenceRows.push(...offTopicShiftRows);
  }

  const longGapRow = rows.find((row) => typeof row.responseGapSec === "number" && row.responseGapSec >= 60);
  if (longGapRow) {
    tags.add("long_response_gap");
    severityScore += 0.1;
    evidenceRows.push(longGapRow);
  }

  if (tags.size === 0) {
    return null;
  }

  const orderedEvidence = uniqEvidenceRows(evidenceRows).slice(0, 4);
  const primaryEvidence = orderedEvidence[0];
  const primaryRow =
    (primaryEvidence
      ? rows.find((row) => row.turnIndex === primaryEvidence.turnIndex)
      : null) ?? rows[0];
  const transcript = rows.map((row) => `[turn ${row.turnIndex}] [${row.role}] ${row.content}`).join("\n");
  const normalizedTranscriptHash = computeNormalizedTranscriptHash(transcript);
  const orderedTags = [...tags].sort();
  const severity = clamp01(severityScore);

  return {
    caseKey: `${topicId}_${normalizedTranscriptHash.slice(0, 10)}`,
    sessionId: primaryRow.sessionId,
    title: buildBadCaseTitle(orderedTags, primaryRow.turnIndex, primaryRow.content),
    severityScore: severity,
    normalizedTranscriptHash,
    duplicateGroupKey: [options.scenarioId ?? "generic", primaryRow.topic, orderedTags.join("+")].join(":"),
    topicSegmentId: topicId,
    topicIndex: primaryRow.topicSegmentIndex,
    topicRange: {
      startTurn: primaryRow.topicStartTurn,
      endTurn: primaryRow.topicEndTurn,
    },
    topicLabel: primaryRow.topic,
    topicSummary: primaryRow.topicSummary,
    tags: orderedTags,
    transcript,
    evidence: orderedEvidence,
    autoSignals,
    suggestedAction: buildSuggestedAction(orderedTags),
    sourceRunId: options.runId,
  };
}

/**
 * Build title text for one bad case card.
 *
 * @param tags Sorted bad case tags.
 * @param turnIndex Primary turn index.
 * @param content Primary evidence content.
 * @returns Title text.
 */
function buildBadCaseTitle(tags: BadCaseTag[], turnIndex: number, content: string): string {
  if (tags.includes("goal_failed")) {
    return `第 ${turnIndex} 轮后目标未达成：${truncate(content, 24)}`;
  }
  if (tags.includes("recovery_failed")) {
    return `第 ${turnIndex} 轮后恢复失败：${truncate(content, 24)}`;
  }
  if (tags.includes("escalation_keyword")) {
    return `第 ${turnIndex} 轮出现升级风险：${truncate(content, 24)}`;
  }
  return `第 ${turnIndex} 轮出现失败信号：${truncate(content, 24)}`;
}

/**
 * Build one action string from failure tags.
 *
 * @param tags Sorted bad case tags.
 * @returns Human-readable next action.
 */
function buildSuggestedAction(tags: BadCaseTag[]): string {
  if (tags.includes("goal_failed")) {
    return "优先把失败 session 编译为 remediation spec，并补一键回放验证。";
  }
  if (tags.includes("recovery_failed")) {
    return "补充 apology + clarify + action 的恢复序列，并把失败片段加入 regression。";
  }
  if (tags.includes("question_repeat") || tags.includes("understanding_barrier")) {
    return "把策略改为先直接回答问题，再扩展背景，避免用户重复追问。";
  }
  if (tags.includes("escalation_keyword")) {
    return "增加投诉/转人工前的兜底动作和 SLA 承诺句，减少升级触发。";
  }
  return "将该片段沉淀到 bad case 池，并纳入下一轮 sample batch 与回放对比。";
}

/**
 * Materialize goal evidence strings into matching session rows where possible.
 *
 * @param goalCompletion Goal completion result.
 * @param rows Session rows.
 * @returns Evidence rows.
 */
function materializeGoalEvidence(
  goalCompletion: SubjectiveMetrics["goalCompletions"][number],
  rows: EnrichedChatlogRow[],
): BadCaseEvidenceRow[] {
  const evidenceTexts = [...goalCompletion.failureReasons, ...goalCompletion.achievementEvidence];
  return evidenceTexts
    .map((evidence) => rows.find((row) => evidence.includes(truncate(row.content, 20)) || row.content.includes(evidence)))
    .filter((item): item is EnrichedChatlogRow => Boolean(item));
}

/**
 * Find rows involved in repeated question patterns.
 *
 * @param rows Session rows.
 * @returns Rows representing repeated questions.
 */
function findRepeatedQuestionRows(rows: EnrichedChatlogRow[]): BadCaseEvidenceRow[] {
  const questionRows = rows.filter((row) => row.role === "user" && row.isQuestion);
  const counts = new Map<string, EnrichedChatlogRow[]>();
  questionRows.forEach((row) => {
    const normalized = normalizeQuestion(row.content);
    if (!normalized) {
      return;
    }
    const current = counts.get(normalized) ?? [];
    current.push(row);
    counts.set(normalized, current);
  });

  return [...counts.values()].filter((items) => items.length >= 2).flatMap((items) => items.slice(0, 2));
}

/**
 * Find rows representing question-followed-by-topic-shift patterns.
 *
 * @param rows Session rows.
 * @returns Relevant evidence rows.
 */
function findOffTopicShiftRows(rows: EnrichedChatlogRow[]): BadCaseEvidenceRow[] {
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1];
    const current = rows[index];
    if (
      previous.role === "user" &&
      previous.isQuestion &&
      current.role === "assistant" &&
      current.isTopicSwitch
    ) {
      return [previous, current];
    }
  }

  return [];
}

/**
 * Group rows by session id.
 *
 * @param rows Enriched rows.
 * @returns Session map.
 */
function groupRowsByTopic(rows: EnrichedChatlogRow[]): Map<string, EnrichedChatlogRow[]> {
  const grouped = new Map<string, EnrichedChatlogRow[]>();
  rows.forEach((row) => {
    grouped.set(row.topicSegmentId, [...(grouped.get(row.topicSegmentId) ?? []), row]);
  });
  return grouped;
}

function materializeAutoSignalEvidence(signals: BadCaseSignal[], rows: EnrichedChatlogRow[]): BadCaseEvidenceRow[] {
  return signals
    .map((signal) => {
      if (signal.kind === "negative_keyword") {
        return rows.find((row) => row.turnIndex === signal.turnIndex);
      }
      if (signal.kind === "metric" && signal.metric === "responseGap") {
        return rows.find((row) => row.responseGapSec === signal.value);
      }
      return rows.find((row) => row.role === "user");
    })
    .filter((row): row is EnrichedChatlogRow => Boolean(row))
    .map((row) => ({
      turnIndex: row.turnIndex,
      role: row.role,
      content: row.content,
    }));
}

/**
 * Deduplicate evidence rows while preserving first-seen order.
 *
 * @param rows Candidate evidence rows.
 * @returns Unique rows.
 */
function uniqEvidenceRows(rows: BadCaseEvidenceRow[]): BadCaseEvidenceRow[] {
  const seen = new Set<string>();
  const output: BadCaseEvidenceRow[] = [];

  rows.forEach((row) => {
    const key = `${row.turnIndex}:${row.role}:${row.content}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    output.push({
      turnIndex: row.turnIndex,
      role: row.role,
      content: row.content,
    });
  });

  return output;
}

/**
 * Normalize question text for coarse duplicate detection.
 *
 * @param value Question text.
 * @returns Normalized value.
 */
function normalizeQuestion(value: string): string {
  return value.replace(/[？?，,。.!！\s]/g, "").slice(0, 18);
}

/**
 * Clamp a 0-1 score.
 *
 * @param value Raw score.
 * @returns Safe score.
 */
function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(4))));
}

/**
 * Truncate text for compact titles.
 *
 * @param value Source text.
 * @param maxLength Max length.
 * @returns Truncated text.
 */
function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1)}…`;
}
