/**
 * @fileoverview Segment-level structured emotion scoring with LLM baseline and local weighting.
 */

import { parseJsonObjectFromLlmOutput, requestSiliconFlowChatCompletion } from "@/lib/siliconflow";
import { buildVersionedJudgeSystemPrompt } from "@/llm/judgeProfile";
import type {
  EmotionIntensity,
  EmotionPolarity,
  EmotionScoreFactors,
  FieldSource,
  NormalizedChatlogRow,
  TopicSegment,
} from "@/types/pipeline";

type SegmentEmotionJudgement = {
  emotionPolarity: EmotionPolarity;
  emotionIntensity: EmotionIntensity;
  emotionBaseScore: number;
  emotionEvidence: string;
  emotionConfidence: number;
  emotionSource: FieldSource;
};

type LlmEmotionPayload = {
  emotionPolarity?: EmotionPolarity;
  emotionIntensity?: EmotionIntensity;
  emotionBaseScore?: number;
  emotionEvidence?: string;
  emotionConfidence?: number;
};

/**
 * Score topic segments with an LLM baseline plus deterministic adjustment factors.
 * @param segments Topic segments resolved by the segmenter.
 * @param rows Normalized rows.
 * @param useLlm Whether the LLM baseline is enabled.
 * @returns Emotion-enriched segments.
 */
export async function scoreTopicSegmentEmotions(
  segments: TopicSegment[],
  rows: NormalizedChatlogRow[],
  useLlm: boolean,
  runId?: string,
): Promise<TopicSegment[]> {
  const rowsBySegmentId = buildRowsBySegmentId(segments, rows);

  return Promise.all(
    segments.map(async (segment) => {
      const segmentRows = rowsBySegmentId.get(segment.topicSegmentId) ?? [];
      const baseJudgement = useLlm
        ? await judgeSegmentEmotionWithLlm(segment, segmentRows, runId).catch(() => buildRuleEmotionBaseline(segmentRows))
        : buildRuleEmotionBaseline(segmentRows);
      const factors = buildEmotionScoreFactors(segmentRows, baseJudgement);
      const emotionScore = clampScore100(
        baseJudgement.emotionBaseScore +
          factors.valenceWeight +
          factors.lengthWeight +
          factors.styleWeight +
          factors.gapWeight +
          factors.recoveryWeight -
          factors.riskPenalty,
      );

      return {
        ...segment,
        emotionPolarity: baseJudgement.emotionPolarity,
        emotionIntensity: baseJudgement.emotionIntensity,
        emotionLabel: buildEmotionLabel(baseJudgement.emotionPolarity, baseJudgement.emotionIntensity),
        emotionBaseScore: baseJudgement.emotionBaseScore,
        emotionScore,
        emotionEvidence: baseJudgement.emotionEvidence,
        emotionSource: baseJudgement.emotionSource,
        emotionConfidence: baseJudgement.emotionConfidence,
        emotionValenceWeight: factors.valenceWeight,
        emotionLengthWeight: factors.lengthWeight,
        emotionStyleWeight: factors.styleWeight,
        emotionGapWeight: factors.gapWeight,
        emotionRecoveryWeight: factors.recoveryWeight,
        emotionRiskPenalty: factors.riskPenalty,
      };
    }),
  );
}

/**
 * Ask the LLM for a segment-level emotion baseline only.
 * @param segment Topic segment metadata.
 * @param rows Rows contained in the segment.
 * @returns Structured emotion baseline.
 */
async function judgeSegmentEmotionWithLlm(
  segment: TopicSegment,
  rows: NormalizedChatlogRow[],
  runId?: string,
): Promise<SegmentEmotionJudgement> {
  const transcript = rows.map((row) => `[turn ${row.turnIndex}] [${row.role}] ${row.content}`).join("\n");
  const rawResponse = await requestSiliconFlowChatCompletion(
    [
      {
        role: "system",
        content: buildVersionedJudgeSystemPrompt("segment_emotion_baseline", [
          "你是对话评估系统中的 emotion judge。",
          "只负责判断 topic segment 的主观情绪倾向，不负责做复杂的结构化加权。",
          "请输出 JSON，不要输出 markdown。",
          "emotionPolarity 只能是 positive / neutral / negative / mixed。",
          "emotionIntensity 只能是 low / medium / high。",
          "emotionBaseScore 必须是 0 到 100 的数字，并保留 1 位小数。",
          "emotionEvidence 必须引用原始片段。",
          "emotionConfidence 必须是 0 到 1 的小数。",
          '输出格式：{"emotionPolarity":"negative","emotionIntensity":"high","emotionBaseScore":32.5,"emotionEvidence":"...","emotionConfidence":0.86}',
        ]),
      },
      {
        role: "user",
        content: [
          `segmentLabel=${segment.topicLabel}`,
          `segmentSummary=${segment.topicSummary}`,
          `turnRange=${segment.startTurn}-${segment.endTurn}`,
          transcript,
          "请仅判断该 segment 的主观情绪倾向、强度和基准分。",
        ].join("\n\n"),
      },
    ],
    {
      stage: "segment_emotion_baseline",
      runId,
      sessionId: segment.sessionId,
      segmentId: segment.topicSegmentId,
    },
  );

  const parsed = parseJsonObjectFromLlmOutput(rawResponse) as LlmEmotionPayload;
  return {
    emotionPolarity: normalizePolarity(parsed.emotionPolarity),
    emotionIntensity: normalizeIntensity(parsed.emotionIntensity),
    emotionBaseScore: clampScore100(parsed.emotionBaseScore ?? 50),
    emotionEvidence: normalizeText(parsed.emotionEvidence, rows[0]?.content ?? segment.topicSummary),
    emotionConfidence: clampConfidence(parsed.emotionConfidence ?? 0.82),
    emotionSource: "llm",
  };
}

/**
 * Build a rule-only fallback emotion baseline.
 * @param rows Rows inside one segment.
 * @returns Fallback baseline.
 */
function buildRuleEmotionBaseline(rows: NormalizedChatlogRow[]): SegmentEmotionJudgement {
  const negativeCount = rows.filter((row) => NEGATIVE_PATTERN.test(row.content)).length;
  const positiveCount = rows.filter((row) => POSITIVE_PATTERN.test(row.content)).length;
  const total = Math.max(1, rows.length);
  const polarity =
    negativeCount >= positiveCount + 2
      ? "negative"
      : positiveCount >= negativeCount + 2
        ? "positive"
        : negativeCount > 0 && positiveCount > 0
          ? "mixed"
          : "neutral";
  const intensity = getRuleIntensity(negativeCount, positiveCount, total);
  const baseScore =
    polarity === "negative"
      ? 34 + positiveCount * 2 - negativeCount * 1.5
      : polarity === "positive"
        ? 72 + positiveCount * 2 - negativeCount
        : polarity === "mixed"
          ? 55 + positiveCount - negativeCount
          : 52;

  return {
    emotionPolarity: polarity,
    emotionIntensity: intensity,
    emotionBaseScore: clampScore100(baseScore),
    emotionEvidence: rows.find((row) => NEGATIVE_PATTERN.test(row.content) || POSITIVE_PATTERN.test(row.content))
      ?.content ?? rows[0]?.content ?? "未提取到情绪证据",
    emotionConfidence: 0.63,
    emotionSource: "rule",
  };
}

/**
 * Build local weighting factors from objective-like segment signals.
 * @param rows Segment rows.
 * @param baseline Baseline emotion judgement.
 * @returns Score factors.
 */
function buildEmotionScoreFactors(
  rows: NormalizedChatlogRow[],
  baseline: SegmentEmotionJudgement,
): EmotionScoreFactors {
  const userRows = rows.filter((row) => row.role === "user");
  const assistantRows = rows.filter((row) => row.role === "assistant");
  const negativeCount = rows.filter((row) => NEGATIVE_PATTERN.test(row.content)).length;
  const positiveCount = rows.filter((row) => POSITIVE_PATTERN.test(row.content)).length;
  const empathyCount = assistantRows.filter((row) => EMPATHY_PATTERN.test(row.content)).length;
  const preachyCount = assistantRows.filter((row) => PREACHY_PATTERN.test(row.content)).length;
  const avgGapSec = average(
    rows
      .slice(1)
      .map((row, index) => {
        const previousRow = rows[index];
        if (row.timestampMs === null || previousRow?.timestampMs === null) {
          return 0;
        }
        return Math.max(0, Math.round((row.timestampMs - previousRow.timestampMs) / 1000));
      })
      .filter((value) => value > 0),
  );
  const avgUserLength = average(userRows.map((row) => row.content.length));
  const avgAssistantLength = average(assistantRows.map((row) => row.content.length));

  const valenceWeight = clampFactor(((positiveCount - negativeCount) / Math.max(1, rows.length)) * 12);
  const lengthWeight = clampFactor(
    (avgUserLength >= 14 ? 2.5 : avgUserLength <= 7 ? -2.5 : 0) +
      (avgAssistantLength >= 28 ? -1.5 : avgAssistantLength <= 10 ? -1 : 0.8),
  );
  const styleWeight = clampFactor(empathyCount * 1.5 - preachyCount * 3);
  const gapWeight = clampFactor(avgGapSec > 90 ? -5 : avgGapSec > 45 ? -2 : avgGapSec > 0 && avgGapSec < 20 ? 1.5 : 0);
  const recoveryWeight = clampFactor(buildRecoveryWeight(userRows, assistantRows, baseline.emotionPolarity));
  const riskPenalty = clampPenalty(
    (rows[rows.length - 1]?.role === "assistant" ? 1.2 : 0) +
      (baseline.emotionPolarity === "negative" && baseline.emotionIntensity === "high" ? 2.8 : 0) +
      (avgUserLength <= 6 && baseline.emotionPolarity === "negative" ? 1.5 : 0),
  );

  return {
    valenceWeight,
    lengthWeight,
    styleWeight,
    gapWeight,
    recoveryWeight,
    riskPenalty,
  };
}

/**
 * Build row mapping for each topic segment.
 * @param segments Topic segments.
 * @param rows Normalized rows.
 * @returns Segment row map.
 */
function buildRowsBySegmentId(
  segments: TopicSegment[],
  rows: NormalizedChatlogRow[],
): Map<string, NormalizedChatlogRow[]> {
  const map = new Map<string, NormalizedChatlogRow[]>();
  segments.forEach((segment) => {
    map.set(
      segment.topicSegmentId,
      rows.filter(
        (row) =>
          row.sessionId === segment.sessionId &&
          row.turnIndex >= segment.startTurn &&
          row.turnIndex <= segment.endTurn,
      ),
    );
  });
  return map;
}

/**
 * Build a readable emotion label from polarity and intensity.
 * @param polarity Emotion polarity.
 * @param intensity Emotion intensity.
 * @returns Human-readable label.
 */
function buildEmotionLabel(polarity: EmotionPolarity, intensity: EmotionIntensity): string {
  const polarityLabel =
    polarity === "positive"
      ? "正向"
      : polarity === "negative"
        ? "负向"
        : polarity === "mixed"
          ? "复杂"
          : "中性";
  const intensityLabel = intensity === "high" ? "高强度" : intensity === "medium" ? "中强度" : "低强度";
  return `${polarityLabel}-${intensityLabel}`;
}

/**
 * Estimate a recovery weight from within-segment movement.
 * @param userRows User rows.
 * @param assistantRows Assistant rows.
 * @param polarity Segment baseline polarity.
 * @returns Recovery weight.
 */
function buildRecoveryWeight(
  userRows: NormalizedChatlogRow[],
  assistantRows: NormalizedChatlogRow[],
  polarity: EmotionPolarity,
): number {
  const firstUser = userRows[0]?.content ?? "";
  const lastUser = userRows[userRows.length - 1]?.content ?? "";
  const firstNegative = NEGATIVE_PATTERN.test(firstUser);
  const lastPositive = POSITIVE_PATTERN.test(lastUser);
  const supportiveAssistant = assistantRows.some((row) => EMPATHY_PATTERN.test(row.content));

  if (firstNegative && lastPositive) {
    return 6;
  }
  if (firstNegative && supportiveAssistant) {
    return 3.5;
  }
  if (polarity === "negative" && !supportiveAssistant) {
    return -3;
  }
  return 0;
}

/**
 * Get a fallback intensity by rule counts.
 * @param negativeCount Negative cue count.
 * @param positiveCount Positive cue count.
 * @param total Total row count.
 * @returns Rule intensity.
 */
function getRuleIntensity(
  negativeCount: number,
  positiveCount: number,
  total: number,
): EmotionIntensity {
  const dominantCount = Math.max(negativeCount, positiveCount);
  if (dominantCount / total >= 0.5) {
    return "high";
  }
  if (dominantCount / total >= 0.25) {
    return "medium";
  }
  return "low";
}

/**
 * Normalize a possible LLM polarity string.
 * @param value Candidate polarity.
 * @returns Safe polarity.
 */
function normalizePolarity(value: EmotionPolarity | undefined): EmotionPolarity {
  return value === "positive" || value === "neutral" || value === "negative" || value === "mixed"
    ? value
    : "neutral";
}

/**
 * Normalize a possible LLM intensity string.
 * @param value Candidate intensity.
 * @returns Safe intensity.
 */
function normalizeIntensity(value: EmotionIntensity | undefined): EmotionIntensity {
  return value === "low" || value === "medium" || value === "high" ? value : "medium";
}

/**
 * Clamp factor weights into a narrow adjustment range.
 * @param value Raw factor value.
 * @returns Safe factor.
 */
function clampFactor(value: number): number {
  return Math.max(-8, Math.min(8, Number(value.toFixed(1))));
}

/**
 * Clamp a penalty value into a narrow positive range.
 * @param value Raw penalty.
 * @returns Safe penalty.
 */
function clampPenalty(value: number): number {
  return Math.max(0, Math.min(8, Number(value.toFixed(1))));
}

/**
 * Clamp a score to the 0-100 range with one decimal.
 * @param value Raw score.
 * @returns Safe score.
 */
function clampScore100(value: number): number {
  return Math.max(0, Math.min(100, Number(value.toFixed(1))));
}

/**
 * Clamp confidence to the 0-1 range.
 * @param value Raw confidence.
 * @returns Safe confidence.
 */
function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(2))));
}

/**
 * Normalize text output from the LLM.
 * @param value Candidate text.
 * @param fallback Fallback text.
 * @returns Stable text.
 */
function normalizeText(value: string | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : fallback;
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

const NEGATIVE_PATTERN = /(害怕|怕|焦虑|担心|不行|失眠|难受|怀疑|委屈|低落|很差|卡壳|糟糕|被批评|被否定|胸口闷)/;
const POSITIVE_PATTERN = /(谢谢|很好|很棒|清楚|信任|放松|稳定|成长|支持|完美|喜欢|没那么闷|成熟|礼貌又专业)/;
const EMPATHY_PATTERN = /(理解|明白|陪你|正常|辛苦|收到|我们先不急|我在这里|慢下来)/;
const PREACHY_PATTERN = /(应该|必须|你要|一定要|立刻|马上)/;
