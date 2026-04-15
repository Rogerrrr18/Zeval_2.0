/**
 * @fileoverview Subjective metric aggregation with topic-segment aware LLM judging.
 */

import { parseJsonObjectFromLlmOutput, requestSiliconFlowChatCompletion } from "@/lib/siliconflow";
import { buildImplicitSignals } from "@/pipeline/signals";
import type {
  EmotionTurningPoint,
  EnrichedChatlogRow,
  ImplicitSignal,
  SubjectiveDimensionResult,
  SubjectiveMetrics,
} from "@/types/pipeline";

const SUBJECTIVE_DIMENSIONS = ["共情程度", "答非所问/无视风险", "说教感/压迫感", "情绪恢复能力"] as const;

type LlmJudgePayload = {
  dimensions?: Array<{
    dimension?: string;
    score?: number;
    reason?: string;
    evidence?: string;
    confidence?: number;
  }>;
};

/**
 * Build subjective metrics from enriched rows.
 * @param rows Enriched rows.
 * @param useLlm Whether llm mode was requested.
 * @returns Subjective metric summary.
 */
export async function buildSubjectiveMetrics(
  rows: EnrichedChatlogRow[],
  useLlm: boolean,
  runId?: string,
): Promise<SubjectiveMetrics> {
  const signals = buildImplicitSignals(rows);
  const emotionCurve = rows.map((row) => ({
    sessionId: row.sessionId,
    topicSegmentId: row.topicSegmentId,
    topicSegmentIndex: row.topicSegmentIndex,
    turnIndex: row.turnIndex,
    emotionScore: row.emotionScore,
    emotionBaseScore: row.emotionBaseScore,
    emotionLabel: row.emotionLabel,
  }));
  const emotionTurningPoints = buildEmotionTurningPoints(rows);
  const fallbackDimensions = buildRuleBasedDimensions(rows, signals);

  if (!useLlm) {
    return {
      status: "degraded",
      emotionCurve,
      emotionTurningPoints,
      dimensions: fallbackDimensions,
      signals,
    };
  }

  try {
    const grouped = groupRowsBySession(rows);
    const sessionReviews = await Promise.all(
      [...grouped.entries()].map(async ([sessionId, sessionRows]) => {
        try {
          return {
            sessionId,
            dimensions: await judgeSessionDimensionsWithLlm(sessionRows, signals, runId),
            weight: sessionRows.length,
            succeeded: true,
          };
        } catch (error) {
          console.error("Session subjective judge failed:", sessionId, error);
          return {
            sessionId,
            dimensions: buildRuleBasedDimensions(sessionRows, signals),
            weight: sessionRows.length,
            succeeded: false,
          };
        }
      }),
    );

    return {
      status: sessionReviews.every((review) => review.succeeded) ? "ready" : "degraded",
      emotionCurve,
      emotionTurningPoints,
      dimensions: aggregateDimensionReviews(
        sessionReviews.map((review) => review.dimensions),
        sessionReviews.map((review) => review.weight),
      ),
      signals,
    };
  } catch (error) {
    console.error("SiliconFlow subjective judge failed:", error);
    return {
      status: "degraded",
      emotionCurve,
      emotionTurningPoints,
      dimensions: fallbackDimensions,
      signals,
    };
  }
}

/**
 * Judge one session with the LLM after topic segmentation and signal extraction.
 * @param rows Session rows.
 * @param signals Global implicit signals.
 * @returns Session-level subjective dimensions.
 */
async function judgeSessionDimensionsWithLlm(
  rows: EnrichedChatlogRow[],
  signals: ImplicitSignal[],
  runId?: string,
): Promise<SubjectiveDimensionResult[]> {
  const fallbackDimensions = buildRuleBasedDimensions(rows, signals);
  const transcript = buildSessionJudgeTranscript(rows, signals);
  const rawResponse = await requestSiliconFlowChatCompletion(
    [
      {
        role: "system",
        content: [
          "你是对话评估系统中的审稿型 Judge。",
          "输入已经先做了 topic segment 切分和隐式信号提取。",
          "你只输出 JSON，不要输出 markdown，不要补充解释。",
          "请评估四个维度：共情程度、答非所问/无视风险、说教感/压迫感、情绪恢复能力。",
          "score 必须是 1 到 5 的整数，分数越高越好。",
          "confidence 必须是 0 到 1 的小数。",
          "evidence 必须引用原始对话片段，不要编造。",
          '输出格式：{"dimensions":[{"dimension":"共情程度","score":4,"reason":"...","evidence":"...","confidence":0.82}]}',
        ].join("\n"),
      },
      {
        role: "user",
        content: transcript,
      },
    ],
    {
      stage: "subjective_dimension_judge",
      runId,
      sessionId: rows[0]?.sessionId,
    },
  );

  const parsed = parseJsonObjectFromLlmOutput(rawResponse) as LlmJudgePayload;
  const byName = new Map(
    (parsed.dimensions ?? [])
      .filter((item) => typeof item.dimension === "string" && item.dimension.length > 0)
      .map((item) => [item.dimension as string, item]),
  );

  return SUBJECTIVE_DIMENSIONS.map((dimension, index) => {
    const fallback = fallbackDimensions[index];
    const candidate = byName.get(dimension);
    if (!candidate) {
      return fallback;
    }

    return {
      dimension,
      score: clampScore(typeof candidate.score === "number" ? candidate.score : fallback.score),
      reason: normalizeText(candidate.reason, fallback.reason),
      evidence: normalizeText(candidate.evidence, fallback.evidence),
      confidence: clampConfidence(
        typeof candidate.confidence === "number" ? candidate.confidence : fallback.confidence,
      ),
    };
  });
}

/**
 * Build the transcript sent to the LLM judge.
 * @param rows Session rows.
 * @param signals Global signals.
 * @returns Compact session transcript with segment metadata.
 */
function buildSessionJudgeTranscript(rows: EnrichedChatlogRow[], signals: ImplicitSignal[]): string {
  const sessionId = rows[0]?.sessionId ?? "unknown";
  const relevantSignals = signals.filter((signal) => signal.evidenceTurnRange.startsWith(`${sessionId}:`));
  const segments = [...new Set(rows.map((row) => row.topicSegmentId))]
    .map((segmentId) => {
      const segmentRows = rows.filter((row) => row.topicSegmentId === segmentId);
      const segment = segmentRows[0];
      return [
        `segment=${segment.topicSegmentIndex}`,
        `label=${segment.topic}`,
        `summary=${segment.topicSummary}`,
        `turnRange=${segment.topicStartTurn}-${segment.topicEndTurn}`,
        `emotionBaseScore=${segment.emotionBaseScore}`,
        `emotionFinalScore=${segment.emotionScore}`,
        `emotionLabel=${segment.emotionLabel}`,
        ...segmentRows.map((row) => `[turn ${row.turnIndex}] [${row.role}] ${row.content}`),
      ].join("\n");
    })
    .join("\n\n");

  return [
    `sessionId=${sessionId}`,
    "隐式推断信号：",
    relevantSignals.length
      ? relevantSignals
          .map(
            (signal) =>
              `${signal.signalKey} score=${signal.score} severity=${signal.severity} evidence=${signal.evidenceTurnRange}`,
          )
          .join("\n")
      : "none",
    "topic segments：",
    segments,
    "请基于以上内容输出四个维度的结构化评估 JSON。",
  ].join("\n\n");
}

/**
 * Build rule-based dimensions as the degradation fallback.
 * @param rows Enriched rows.
 * @param signals Implicit signals.
 * @returns Structured dimension list.
 */
function buildRuleBasedDimensions(
  rows: EnrichedChatlogRow[],
  signals: ImplicitSignal[],
): SubjectiveDimensionResult[] {
  return [
    buildDimension("共情程度", scoreEmpathy(rows), "共情语句密度与安抚表达"),
    buildDimension(
      "答非所问/无视风险",
      scoreOffTopic(rows, signals),
      "topic 切换、提问后偏移与理解障碍信号",
    ),
    buildDimension("说教感/压迫感", scorePreachiness(rows), "强指导词与命令式语气"),
    buildDimension("情绪恢复能力", scoreRecovery(rows, signals), "情绪低谷后的恢复速度与恢复失败风险"),
  ];
}

/**
 * Build one subjective result card.
 * @param dimension Dimension name.
 * @param score Score value.
 * @param reason Reason summary.
 * @returns Structured dimension result.
 */
function buildDimension(
  dimension: string,
  score: number,
  reason: string,
): SubjectiveDimensionResult {
  return {
    dimension,
    score,
    reason,
    evidence: "当前结果为规则降级模式，证据来自关键词与对话结构近似推断。",
    confidence: 0.58,
  };
}

/**
 * Build emotion turning points from row-level emotion changes.
 * @param rows Enriched rows.
 * @returns Turning point list.
 */
function buildEmotionTurningPoints(rows: EnrichedChatlogRow[]): EmotionTurningPoint[] {
  const points: EmotionTurningPoint[] = [];
  const grouped = groupRowsBySession(rows);

  for (const [sessionId, sessionRows] of grouped.entries()) {
    for (let index = 1; index < sessionRows.length; index += 1) {
      const previousRow = sessionRows[index - 1];
      const currentRow = sessionRows[index];
      const scoreDelta = currentRow.emotionScore - previousRow.emotionScore;
      if (Math.abs(scoreDelta) < 12) {
        continue;
      }
      points.push({
        sessionId,
        turnIndex: currentRow.turnIndex,
        direction: scoreDelta > 0 ? "up" : "down",
        scoreDelta: Number(scoreDelta.toFixed(1)),
        evidence: currentRow.content,
      });
    }
  }

  return points;
}

/**
 * Score empathy density in assistant replies.
 * @param rows Enriched rows.
 * @returns A 1-5 score.
 */
function scoreEmpathy(rows: EnrichedChatlogRow[]): number {
  const assistantRows = rows.filter((row) => row.role === "assistant");
  if (assistantRows.length === 0) {
    return 1;
  }
  const hits = assistantRows.filter((row) => /(理解|明白|支持|陪你|辛苦|正常)/.test(row.content)).length;
  return clampScore((hits / assistantRows.length) * 5);
}

/**
 * Score off-topic risk in the conversation.
 * @param rows Enriched rows.
 * @param signals Implicit signals.
 * @returns A 1-5 score where higher is better.
 */
function scoreOffTopic(rows: EnrichedChatlogRow[], signals: ImplicitSignal[]): number {
  if (rows.length === 0) {
    return 1;
  }
  const rate = rows.filter((row) => row.isTopicSwitch).length / rows.length;
  const understandingRisk =
    signals.find((signal) => signal.signalKey === "understandingBarrierRisk")?.score ?? 0;
  return clampScore(5 - rate * 8 - understandingRisk * 2);
}

/**
 * Score preachiness using rule-based keyword checks.
 * @param rows Enriched rows.
 * @returns A 1-5 score where higher is better.
 */
function scorePreachiness(rows: EnrichedChatlogRow[]): number {
  const assistantRows = rows.filter((row) => row.role === "assistant");
  if (assistantRows.length === 0) {
    return 1;
  }
  const preachyCount = assistantRows.filter((row) => /(应该|必须|你要|一定要)/.test(row.content)).length;
  return clampScore(5 - (preachyCount / assistantRows.length) * 10);
}

/**
 * Score emotion recovery from low points.
 * @param rows Enriched rows.
 * @param signals Implicit signals.
 * @returns A 1-5 score.
 */
function scoreRecovery(rows: EnrichedChatlogRow[], signals: ImplicitSignal[]): number {
  const lowEmotionCount = rows.filter((row) => row.emotionScore <= 40).length;
  const positiveCount = rows.filter((row) => row.emotionScore >= 65).length;
  const recoveryFailureRisk =
    signals.find((signal) => signal.signalKey === "emotionRecoveryFailureRisk")?.score ?? 0;
  if (lowEmotionCount === 0) {
    return clampScore(4 - recoveryFailureRisk);
  }
  return clampScore((positiveCount / Math.max(1, lowEmotionCount)) * 2.5 + (1 - recoveryFailureRisk));
}

/**
 * Clamp a float score into the 1-5 range.
 * @param score Raw score.
 * @returns Integer score.
 */
function clampScore(score: number): number {
  return Math.max(1, Math.min(5, Math.round(score)));
}

/**
 * Clamp confidence to 0-1.
 * @param confidence Raw confidence.
 * @returns Safe confidence.
 */
function clampConfidence(confidence: number): number {
  return Math.max(0, Math.min(1, Number(confidence.toFixed(2))));
}

/**
 * Normalize llm text fields.
 * @param value Candidate text.
 * @param fallback Fallback text.
 * @returns Normalized text.
 */
function normalizeText(value: string | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : fallback;
}

/**
 * Aggregate multiple session-level dimension sets into one global result.
 * @param dimensionSets Session dimension sets.
 * @param weights Session weights.
 * @returns Aggregated dimensions.
 */
function aggregateDimensionReviews(
  dimensionSets: SubjectiveDimensionResult[][],
  weights: number[],
): SubjectiveDimensionResult[] {
  return SUBJECTIVE_DIMENSIONS.map((dimension) => {
    const dimensionItems = dimensionSets.map((set, index) => ({
      item: set.find((candidate) => candidate.dimension === dimension),
      weight: weights[index] ?? 1,
    }));
    const totalWeight = dimensionItems.reduce((sum, entry) => sum + entry.weight, 0);
    const weightedScore =
      totalWeight === 0
        ? 1
        : dimensionItems.reduce((sum, entry) => sum + (entry.item?.score ?? 1) * entry.weight, 0) / totalWeight;
    const firstReason = dimensionItems.find((entry) => entry.item)?.item;
    const mergedEvidence = dimensionItems
      .map((entry) => entry.item?.evidence)
      .filter((value): value is string => Boolean(value))
      .slice(0, 2)
      .join("；");
    const confidence =
      totalWeight === 0
        ? 0.58
        : dimensionItems.reduce((sum, entry) => sum + (entry.item?.confidence ?? 0.58) * entry.weight, 0) /
          totalWeight;

    return {
      dimension,
      score: clampScore(weightedScore),
      reason: firstReason?.reason ?? "当前结果为多 session 聚合后的近似评估。",
      evidence: mergedEvidence || "未提取到稳定证据。",
      confidence: clampConfidence(confidence),
    };
  });
}

/**
 * Group enriched rows by session.
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
