/**
 * @fileoverview Enrich normalized rows into the canonical intermediate artifact.
 */

import { scoreTopicSegmentEmotions } from "@/pipeline/emotion";
import { normalizeRawRows } from "@/pipeline/normalize";
import { buildTopicSegments } from "@/pipeline/segmenter";
import type { EnrichedChatlogRow, RawChatlogRow, TopicSegment } from "@/types/pipeline";

/**
 * Enrich raw rows with topic segments, segment-level emotion scores and interaction signals.
 * @param rows Raw chat rows.
 * @param useLlm Whether topic continuity review can call the LLM.
 * @returns Enriched rows together with resolved topic segments.
 */
export async function enrichRows(
  rows: RawChatlogRow[],
  useLlm = false,
  runId?: string,
): Promise<{ enrichedRows: EnrichedChatlogRow[]; topicSegments: TopicSegment[] }> {
  const normalizedRows = normalizeRawRows(rows);
  const rawTopicSegments = await buildTopicSegments(normalizedRows, useLlm, runId);
  const topicSegments = await scoreTopicSegmentEmotions(rawTopicSegments, normalizedRows, useLlm, runId);
  const segmentByTurn = new Map<string, TopicSegment>();
  const previousTimestampBySession = new Map<string, number | null>();
  const previousSegmentBySession = new Map<string, string>();
  const lastTurnBySession = new Map<string, number>();

  normalizedRows.forEach((row) => {
    lastTurnBySession.set(row.sessionId, row.turnIndex);
  });

  topicSegments.forEach((segment) => {
    for (let turn = segment.startTurn; turn <= segment.endTurn; turn += 1) {
      segmentByTurn.set(`${segment.sessionId}:${turn}`, segment);
    }
  });

  const enrichedRows: EnrichedChatlogRow[] = normalizedRows.map((row) => {
    const segment = segmentByTurn.get(`${row.sessionId}:${row.turnIndex}`) ?? createFallbackSegment(row);
    const previousTimestamp = previousTimestampBySession.get(row.sessionId) ?? null;
    const previousSegmentId = previousSegmentBySession.get(row.sessionId) ?? "";
    const responseGapSec =
      row.timestampMs !== null && previousTimestamp !== null
        ? Math.max(0, Math.round((row.timestampMs - previousTimestamp) / 1000))
        : null;

    previousTimestampBySession.set(row.sessionId, row.timestampMs);
    previousSegmentBySession.set(row.sessionId, segment.topicSegmentId);

    return {
      ...row,
      topic: segment.topicLabel,
      topicSegmentId: segment.topicSegmentId,
      topicSegmentIndex: segment.topicSegmentIndex,
      topicSummary: segment.topicSummary,
      topicStartTurn: segment.startTurn,
      topicEndTurn: segment.endTurn,
      topicSource: segment.topicSource,
      topicConfidence: segment.topicConfidence,
      emotionPolarity: segment.emotionPolarity,
      emotionIntensity: segment.emotionIntensity,
      emotionLabel: segment.emotionLabel,
      emotionBaseScore: segment.emotionBaseScore,
      emotionScore: segment.emotionScore,
      emotionEvidence: segment.emotionEvidence,
      emotionSource: segment.emotionSource,
      emotionConfidence: segment.emotionConfidence,
      emotionValenceWeight: segment.emotionValenceWeight,
      emotionLengthWeight: segment.emotionLengthWeight,
      emotionStyleWeight: segment.emotionStyleWeight,
      emotionGapWeight: segment.emotionGapWeight,
      emotionRecoveryWeight: segment.emotionRecoveryWeight,
      emotionRiskPenalty: segment.emotionRiskPenalty,
      responseGapSec,
      isDropoffTurn:
        row.turnIndex === (lastTurnBySession.get(row.sessionId) ?? row.turnIndex) &&
        row.role === "assistant",
      isQuestion: /[?？]/.test(row.content),
      isTopicSwitch: previousSegmentId !== "" && previousSegmentId !== segment.topicSegmentId,
      tokenCountEstimate: Math.max(1, Math.ceil(row.content.length / 1.6)),
    };
  });

  return {
    enrichedRows,
    topicSegments,
  };
}

/**
 * Build canonical CSV string from normalized rows.
 * @param rows Raw chat rows.
 * @returns Canonical CSV text.
 */
export function toCanonicalCsv(rows: RawChatlogRow[]): string {
  const normalizedRows = normalizeRawRows(rows);
  const header = "sessionId,timestamp,role,content";
  const body = normalizedRows.map((row) =>
    [row.sessionId, row.timestamp, row.role, row.content].map(escapeCell).join(","),
  );
  return [header, ...body].join("\n");
}

/**
 * Export enriched rows as CSV text.
 * @param rows Enriched rows.
 * @returns Stable enriched CSV text.
 */
export function toEnrichedCsv(rows: EnrichedChatlogRow[]): string {
  const header = [
    "sessionId",
    "timestamp",
    "role",
    "content",
    "turnIndex",
    "topic",
    "topicSegmentId",
    "topicSegmentIndex",
    "topicSummary",
    "topicStartTurn",
    "topicEndTurn",
    "topicSource",
    "topicConfidence",
    "emotionPolarity",
    "emotionIntensity",
    "emotionLabel",
    "emotionBaseScore",
    "emotionScore",
    "emotionEvidence",
    "emotionSource",
    "emotionConfidence",
    "emotionValenceWeight",
    "emotionLengthWeight",
    "emotionStyleWeight",
    "emotionGapWeight",
    "emotionRecoveryWeight",
    "emotionRiskPenalty",
    "responseGapSec",
    "isDropoffTurn",
    "isQuestion",
    "isTopicSwitch",
    "activeHour",
    "tokenCountEstimate",
  ].join(",");
  const body = rows.map((row) =>
    [
      row.sessionId,
      row.timestamp,
      row.role,
      row.content,
      row.turnIndex,
      row.topic,
      row.topicSegmentId,
      row.topicSegmentIndex,
      row.topicSummary,
      row.topicStartTurn,
      row.topicEndTurn,
      row.topicSource,
      row.topicConfidence,
      row.emotionPolarity,
      row.emotionIntensity,
      row.emotionLabel,
      row.emotionBaseScore,
      row.emotionScore,
      row.emotionEvidence,
      row.emotionSource,
      row.emotionConfidence,
      row.emotionValenceWeight,
      row.emotionLengthWeight,
      row.emotionStyleWeight,
      row.emotionGapWeight,
      row.emotionRecoveryWeight,
      row.emotionRiskPenalty,
      row.responseGapSec,
      row.isDropoffTurn,
      row.isQuestion,
      row.isTopicSwitch,
      row.activeHour,
      row.tokenCountEstimate,
    ]
      .map(escapeCell)
      .join(","),
  );
  return [header, ...body].join("\n");
}

/**
 * Escape CSV cell values.
 * @param value Cell value.
 * @returns Escaped CSV cell.
 */
function escapeCell(value: string | number | boolean | null): string {
  const text = value === null ? "" : String(value);
  if (/[",\n]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

/**
 * Create a fallback segment when row-to-segment mapping is unavailable.
 * @param row Normalized row.
 * @returns One-row fallback segment.
 */
function createFallbackSegment(row: EnrichedChatlogRow | RawChatlogRow & { turnIndex?: number }): TopicSegment {
  const turnIndex = "turnIndex" in row && typeof row.turnIndex === "number" ? row.turnIndex : 1;
  return {
    sessionId: row.sessionId,
    topicSegmentId: `${row.sessionId}_topic_fallback_${turnIndex}`,
    topicSegmentIndex: turnIndex,
    topicLabel: "未识别主题",
    topicSummary: "未识别主题",
    topicSource: "fallback",
    topicConfidence: 0.4,
    startTurn: turnIndex,
    endTurn: turnIndex,
    messageCount: 1,
    emotionPolarity: "neutral",
    emotionIntensity: "low",
    emotionLabel: "中性-低强度",
    emotionBaseScore: 50,
    emotionScore: 50,
    emotionEvidence: "未提取到情绪证据",
    emotionSource: "fallback",
    emotionConfidence: 0.4,
    emotionValenceWeight: 0,
    emotionLengthWeight: 0,
    emotionStyleWeight: 0,
    emotionGapWeight: 0,
    emotionRecoveryWeight: 0,
    emotionRiskPenalty: 0,
  };
}
