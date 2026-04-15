/**
 * @fileoverview Shared contracts for raw, enriched and presentation layers.
 */

/**
 * Supported upload formats for raw chatlog ingestion.
 */
export type UploadFormat = "csv" | "json" | "txt" | "md";

/**
 * Supported message roles.
 */
export type ChatRole = "user" | "assistant" | "system";

/**
 * Raw chat row ingested from user-provided logs.
 */
export type RawChatlogRow = {
  sessionId: string;
  timestamp: string;
  role: ChatRole;
  content: string;
};

/**
 * Normalized row after sorting and time parsing.
 */
export type NormalizedChatlogRow = RawChatlogRow & {
  turnIndex: number;
  timestampMs: number | null;
  activeHour: number | null;
};

/**
 * Tracks how a field is produced to keep enrichment transparent.
 */
export type FieldSource = "raw" | "rule" | "llm" | "inferred" | "fallback";

/**
 * Segment-level emotion polarity categories.
 */
export type EmotionPolarity = "positive" | "neutral" | "negative" | "mixed";

/**
 * Segment-level emotion intensity categories.
 */
export type EmotionIntensity = "low" | "medium" | "high";

/**
 * Structured emotion factor weights used by the local scoring function.
 */
export type EmotionScoreFactors = {
  valenceWeight: number;
  lengthWeight: number;
  styleWeight: number;
  gapWeight: number;
  recoveryWeight: number;
  riskPenalty: number;
};

/**
 * Structured topic segment built during preprocessing.
 */
export type TopicSegment = {
  sessionId: string;
  topicSegmentId: string;
  topicSegmentIndex: number;
  topicLabel: string;
  topicSummary: string;
  topicSource: FieldSource;
  topicConfidence: number;
  startTurn: number;
  endTurn: number;
  messageCount: number;
  emotionPolarity: EmotionPolarity;
  emotionIntensity: EmotionIntensity;
  emotionLabel: string;
  emotionBaseScore: number;
  emotionScore: number;
  emotionEvidence: string;
  emotionSource: FieldSource;
  emotionConfidence: number;
  emotionValenceWeight: number;
  emotionLengthWeight: number;
  emotionStyleWeight: number;
  emotionGapWeight: number;
  emotionRecoveryWeight: number;
  emotionRiskPenalty: number;
};

/**
 * Supported implicit signal identifiers.
 */
export type ImplicitSignalKey =
  | "interestDeclineRisk"
  | "understandingBarrierRisk"
  | "emotionRecoveryFailureRisk";

/**
 * Structured implicit signal extracted from enriched behavior patterns.
 */
export type ImplicitSignal = {
  signalKey: ImplicitSignalKey;
  score: number;
  severity: "low" | "medium" | "high";
  triggeredRules: string[];
  reason: string;
  evidence: string;
  evidenceTurnRange: string;
  confidence: number;
};

/**
 * Enriched row used as the canonical intermediate artifact.
 */
export type EnrichedChatlogRow = NormalizedChatlogRow & {
  topic: string;
  topicSegmentId: string;
  topicSegmentIndex: number;
  topicSummary: string;
  topicStartTurn: number;
  topicEndTurn: number;
  topicSource: FieldSource;
  topicConfidence: number;
  emotionPolarity: EmotionPolarity;
  emotionIntensity: EmotionIntensity;
  emotionLabel: string;
  emotionBaseScore: number;
  emotionScore: number;
  emotionEvidence: string;
  emotionSource: FieldSource;
  emotionConfidence: number;
  emotionValenceWeight: number;
  emotionLengthWeight: number;
  emotionStyleWeight: number;
  emotionGapWeight: number;
  emotionRecoveryWeight: number;
  emotionRiskPenalty: number;
  responseGapSec: number | null;
  isDropoffTurn: boolean;
  isQuestion: boolean;
  isTopicSwitch: boolean;
  tokenCountEstimate: number;
};

/**
 * Supported chart keys for the first MVP release.
 */
export type ChartKey =
  | "emotionCurve"
  | "dropoffDistribution"
  | "activeHourDistribution"
  | "topicSwitchFrequency";

/**
 * Supported frontend chart render types.
 */
export type ChartType = "line" | "bar" | "area";

/**
 * Generic chart payload consumed by frontend chart components.
 */
export type ChartPayload = {
  chartKey: ChartKey;
  title: string;
  description: string;
  chartType: ChartType;
  xField: string;
  yField: string;
  seriesField?: string;
  data: Array<Record<string, string | number | boolean | null>>;
};

/**
 * Summary card item shown in the frontend metric overview.
 */
export type SummaryCard = {
  key: string;
  label: string;
  value: string;
  hint: string;
};

/**
 * Structured subjective scoring result.
 */
export type SubjectiveDimensionResult = {
  dimension: string;
  score: number;
  reason: string;
  evidence: string;
  confidence: number;
};

/**
 * Aggregated objective metrics.
 */
export type ObjectiveMetrics = {
  sessionDepthDistribution: Record<string, number>;
  dropoffTurnDistribution: Record<string, number>;
  avgResponseGapSec: number;
  topicSwitchRate: number;
  activeHourDistribution: Record<string, number>;
  userQuestionRate: number;
  avgUserMessageLength: number;
  userMessageLengthTrend: number;
  avgAssistantMessageLength: number;
};

/**
 * One detected turning point on the emotion curve.
 */
export type EmotionTurningPoint = {
  sessionId: string;
  turnIndex: number;
  direction: "up" | "down";
  scoreDelta: number;
  evidence: string;
};

/**
 * Aggregated subjective metrics.
 */
export type SubjectiveMetrics = {
  status: "ready" | "degraded" | "pending_llm_integration";
  emotionCurve: Array<{
    sessionId: string;
    topicSegmentId: string;
    topicSegmentIndex: number;
    turnIndex: number;
    emotionScore: number;
    emotionBaseScore: number;
    emotionLabel: string;
  }>;
  emotionTurningPoints: EmotionTurningPoint[];
  dimensions: SubjectiveDimensionResult[];
  signals: ImplicitSignal[];
};

/**
 * Metadata returned for a completed evaluation run.
 */
export type EvaluateMeta = {
  sessions: number;
  messages: number;
  hasTimestamp: boolean;
  generatedAt: string;
  warnings: string[];
};

/**
 * Ingest response contract returned to frontend.
 */
export type IngestResponse = {
  format: UploadFormat;
  fileName: string;
  rawRows: RawChatlogRow[];
  canonicalCsv: string;
  previewTop20: string[];
  ingestMeta: {
    sessions: number;
    rows: number;
    hasTimestamp: boolean;
  };
  warnings: string[];
};

/**
 * Evaluate response contract returned to frontend.
 */
export type EvaluateResponse = {
  runId: string;
  meta: EvaluateMeta;
  summaryCards: SummaryCard[];
  topicSegments: TopicSegment[];
  enrichedRows: EnrichedChatlogRow[];
  enrichedCsv: string;
  artifactPath?: string;
  objectiveMetrics: ObjectiveMetrics;
  subjectiveMetrics: SubjectiveMetrics;
  charts: ChartPayload[];
  suggestions: string[];
};
