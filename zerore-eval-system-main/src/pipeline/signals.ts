/**
 * @fileoverview Rule-based implicit signal extraction for enriched chatlogs.
 */

import type { EnrichedChatlogRow, ImplicitSignal, ImplicitSignalKey } from "@/types/pipeline";

/**
 * Build implicit signals from enriched rows.
 * @param rows Enriched rows.
 * @returns Stable signal layer outputs.
 */
export function buildImplicitSignals(rows: EnrichedChatlogRow[]): ImplicitSignal[] {
  return [
    buildInterestDeclineRisk(rows),
    buildUnderstandingBarrierRisk(rows),
    buildEmotionRecoveryFailureRisk(rows),
  ];
}

/**
 * Detect whether user engagement is declining.
 * @param rows Enriched rows.
 * @returns Interest decline signal.
 */
function buildInterestDeclineRisk(rows: EnrichedChatlogRow[]): ImplicitSignal {
  const userRows = rows.filter((row) => row.role === "user");
  const userLengths = userRows.map((row) => row.content.length);
  const earlyLengths = userLengths.slice(0, Math.max(1, Math.ceil(userLengths.length / 2)));
  const lateLengths = userLengths.slice(Math.max(1, Math.ceil(userLengths.length / 2)));
  const earlyAvgLength = average(earlyLengths);
  const lateAvgLength = average(lateLengths);
  const gapRows = userRows.map((row) => row.responseGapSec ?? 0);
  const earlyAvgGap = average(gapRows.slice(0, Math.max(1, Math.ceil(gapRows.length / 2))));
  const lateAvgGap = average(gapRows.slice(Math.max(1, Math.ceil(gapRows.length / 2))));
  const earlyQuestionRate = rate(earlyLengths.length, userRows.slice(0, earlyLengths.length).filter((row) => row.isQuestion).length);
  const lateQuestionRate = rate(
    lateLengths.length,
    userRows.slice(earlyLengths.length).filter((row) => row.isQuestion).length,
  );

  const triggeredRules: string[] = [];
  let score = 0.22;
  if (lateAvgLength < earlyAvgLength * 0.78) {
    triggeredRules.push("连续短回复");
    score += 0.26;
  }
  if (lateAvgGap > Math.max(30, earlyAvgGap * 1.4)) {
    triggeredRules.push("回复间隔拉长");
    score += 0.28;
  }
  if (lateQuestionRate < earlyQuestionRate && earlyQuestionRate > 0) {
    triggeredRules.push("提问意愿下降");
    score += 0.18;
  }

  const evidenceRow = userRows[userRows.length - 1] ?? rows[rows.length - 1];
  return createSignal(
    "interestDeclineRisk",
    score,
    triggeredRules,
    triggeredRules.length
      ? "后半段用户回复更短且互动欲望下降，存在兴趣衰减迹象。"
      : "当前未检测到明显的兴趣衰减模式。",
    evidenceRow ? `[turn ${evidenceRow.turnIndex}] ${evidenceRow.content}` : "无可用证据",
    evidenceRow ? `${evidenceRow.sessionId}:${Math.max(1, evidenceRow.turnIndex - 2)}-${evidenceRow.turnIndex}` : "unknown",
    triggeredRules.length ? 0.78 : 0.62,
  );
}

/**
 * Detect understanding barriers from repeated or confused user turns.
 * @param rows Enriched rows.
 * @returns Understanding barrier signal.
 */
function buildUnderstandingBarrierRisk(rows: EnrichedChatlogRow[]): ImplicitSignal {
  const userRows = rows.filter((row) => row.role === "user");
  const triggeredRules: string[] = [];
  let score = 0.2;

  const confusionRows = userRows.filter((row) => /(什么意思|不懂|你是说|再说一遍|没明白|怎么理解)/.test(row.content));
  if (confusionRows.length > 0) {
    triggeredRules.push("困惑表达升高");
    score += 0.3;
  }

  const normalizedQuestions = userRows
    .filter((row) => row.isQuestion)
    .map((row) => normalizeQuestion(row.content))
    .filter((value) => value.length > 0);
  const questionCounts = new Map<string, number>();
  normalizedQuestions.forEach((question) => {
    questionCounts.set(question, (questionCounts.get(question) ?? 0) + 1);
  });
  if ([...questionCounts.values()].some((count) => count >= 2)) {
    triggeredRules.push("重复提问");
    score += 0.28;
  }

  const topicSwitchAfterQuestion = rows.some((row, index) => {
    const previousRow = rows[index - 1];
    return Boolean(
      previousRow &&
        previousRow.role === "user" &&
        previousRow.isQuestion &&
        row.role === "assistant" &&
        row.isTopicSwitch,
    );
  });
  if (topicSwitchAfterQuestion) {
    triggeredRules.push("提问后主题偏移");
    score += 0.18;
  }

  const evidenceRow = confusionRows[0] ?? userRows.find((row) => row.isQuestion) ?? rows[0];
  return createSignal(
    "understandingBarrierRisk",
    score,
    triggeredRules,
    triggeredRules.length
      ? "用户出现困惑表达或重复提问，说明理解障碍风险正在上升。"
      : "当前没有显著的理解障碍信号。",
    evidenceRow ? `[turn ${evidenceRow.turnIndex}] ${evidenceRow.content}` : "无可用证据",
    evidenceRow ? `${evidenceRow.sessionId}:${evidenceRow.turnIndex}-${evidenceRow.turnIndex}` : "unknown",
    triggeredRules.length ? 0.81 : 0.6,
  );
}

/**
 * Detect whether negative emotion fails to recover.
 * @param rows Enriched rows.
 * @returns Emotion recovery failure signal.
 */
function buildEmotionRecoveryFailureRisk(rows: EnrichedChatlogRow[]): ImplicitSignal {
  const lowRows = rows.filter((row) => row.emotionScore <= 40);
  const unresolved = lowRows.filter((row) => {
    const windowRows = rows.filter(
      (candidate) =>
        candidate.sessionId === row.sessionId &&
        candidate.turnIndex > row.turnIndex &&
        candidate.turnIndex <= row.turnIndex + 4,
    );
    return !windowRows.some((candidate) => candidate.emotionScore >= 60);
  });

  const triggeredRules: string[] = [];
  let score = 0.22;
  if (unresolved.length > 0) {
    triggeredRules.push("负向情绪持续");
    score += 0.34;
  }
  if (
    rows.some(
      (row, index) =>
        row.isDropoffTurn &&
        rows[index - 1] &&
        rows[index - 1].sessionId === row.sessionId &&
        rows[index - 1].emotionScore <= 40,
    )
  ) {
    triggeredRules.push("断点前仍处低谷");
    score += 0.22;
  }

  const evidenceRow = unresolved[0] ?? lowRows[0] ?? rows[0];
  return createSignal(
    "emotionRecoveryFailureRisk",
    score,
    triggeredRules,
    triggeredRules.length
      ? "负向情绪在多轮后仍未明显回升，存在恢复失败与流失风险。"
      : "低谷情绪在后续轮次中出现恢复，当前恢复风险较低。",
    evidenceRow ? `[turn ${evidenceRow.turnIndex}] ${evidenceRow.content}` : "无可用证据",
    evidenceRow ? `${evidenceRow.sessionId}:${evidenceRow.turnIndex}-${Math.min(evidenceRow.turnIndex + 4, evidenceRow.topicEndTurn)}` : "unknown",
    triggeredRules.length ? 0.83 : 0.64,
  );
}

/**
 * Create one implicit signal.
 * @param signalKey Signal identifier.
 * @param rawScore Raw 0-1 score.
 * @param triggeredRules Triggered rule names.
 * @param reason Human-readable explanation.
 * @param evidence Evidence excerpt.
 * @param evidenceTurnRange Evidence turn range.
 * @param confidence Confidence score.
 * @returns Structured signal.
 */
function createSignal(
  signalKey: ImplicitSignalKey,
  rawScore: number,
  triggeredRules: string[],
  reason: string,
  evidence: string,
  evidenceTurnRange: string,
  confidence: number,
): ImplicitSignal {
  const score = clampScore(rawScore);
  return {
    signalKey,
    score,
    severity: score >= 0.7 ? "high" : score >= 0.4 ? "medium" : "low",
    triggeredRules,
    reason,
    evidence,
    evidenceTurnRange,
    confidence: clampScore(confidence),
  };
}

/**
 * Compute an arithmetic mean.
 * @param values Numeric values.
 * @returns Average.
 */
function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Compute a rate safely.
 * @param total Total count.
 * @param part Part count.
 * @returns Rate value.
 */
function rate(total: number, part: number): number {
  if (total === 0) {
    return 0;
  }
  return part / total;
}

/**
 * Normalize a user question for rough repeat detection.
 * @param value Question text.
 * @returns Normalized question.
 */
function normalizeQuestion(value: string): string {
  return value.replace(/[？?，,。.!！\s]/g, "").slice(0, 18);
}

/**
 * Clamp a score into the 0-1 range.
 * @param value Raw score.
 * @returns Safe score.
 */
function clampScore(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(2))));
}
