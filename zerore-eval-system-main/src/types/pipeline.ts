/**
 * @fileoverview Shared contracts for raw, enriched and presentation layers.
 */

import type { ScenarioEvaluation } from "@/types/scenario";
import type { StructuredTaskMetrics } from "@/types/rich-conversation";
import type { EvalMetricRegistrySnapshot } from "@/types/eval-metric";
import type { EvalTrace } from "@/types/eval-trace";
import type { EvalCaseBundle } from "@/types/eval-case";
import type { ExtendedMetricsBundle } from "@/types/extended-metrics";

/**
 * Supported upload formats for raw chatlog ingestion.
 */
export type UploadFormat = "csv" | "json" | "jsonl" | "txt" | "md";

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
 * Scenario-specific context collected before evaluation.
 */
export type ScenarioEvaluateContext = {
  scenarioId?: string;
  onboardingAnswers: Record<string, string>;
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
  userQuestionRepeatRate: number;
  agentResolutionSignalRate: number;
  escalationKeywordHitRate: number;
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
  goalCompletions: GoalCompletionResult[];
  recoveryTraces: RecoveryTraceResult[];
};

/**
 * Goal completion evaluation status per session.
 */
export type GoalCompletionStatus = "achieved" | "partial" | "failed" | "unclear";

/**
 * Session-level goal completion result.
 * 目标：判断用户最初表达的意图在本 session 内是否被达成。
 */
export type GoalCompletionResult = {
  sessionId: string;
  status: GoalCompletionStatus;
  score: number;
  userIntent: string;
  intentSource: FieldSource;
  achievementEvidence: string[];
  failureReasons: string[];
  triggeredRules: string[];
  confidence: number;
  source: FieldSource;
};

/**
 * Classified failure pattern that seeds a recovery trace.
 */
export type RecoveryFailureType =
  | "emotion-drop"
  | "ignore"
  | "understanding-barrier"
  | "unknown";

/**
 * Session-level recovery trace result.
 * 目标：识别"失败 → Agent 纠偏 → 成功"模式，这是 Agent 改进最高价值的训练素材。
 */
export type RecoveryTraceResult = {
  sessionId: string;
  status: "none" | "completed" | "failed";
  failureTurn: number | null;
  recoveryTurn: number | null;
  spanTurns: number | null;
  failureType: RecoveryFailureType;
  repairStrategy: string | null;
  repairStrategySource: FieldSource;
  qualityScore: number;
  evidence: Array<{
    turnIndex: number;
    role: ChatRole;
    content: string;
  }>;
  triggeredRules: string[];
  confidence: number;
};

/**
 * Supported failure tags for harvested bad cases.
 */
export type BadCaseTag =
  | "goal_failed"
  | "goal_partial"
  | "goal_unclear"
  | "recovery_failed"
  | "understanding_barrier"
  | "question_repeat"
  | "escalation_keyword"
  | "emotion_drop"
  | "off_topic_shift"
  | "long_response_gap";

/**
 * Session-level bad case asset extracted from one evaluation run.
 */
export type BadCaseAsset = {
  caseKey: string;
  sessionId: string;
  title: string;
  severityScore: number;
  normalizedTranscriptHash: string;
  duplicateGroupKey: string;
  topicSegmentId: string;
  topicIndex?: number;
  topicRange?: { startTurn: number; endTurn: number };
  topicLabel: string;
  topicSummary: string;
  tags: BadCaseTag[];
  transcript: string;
  evidence: Array<{
    turnIndex: number;
    role: ChatRole;
    content: string;
  }>;
  autoSignals?: Array<
    | { kind: "negative_keyword"; keyword: string; turnIndex: number }
    | { kind: "metric"; metric: "responseGap" | "shortTurns" | "topicSwitch"; value: number }
    | { kind: "implicit_signal"; signalId: string }
  >;
  suggestedAction: string;
  sourceRunId: string;
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
  llmJudge?: LlmJudgeRunSummary;
  savedEvaluatePath?: string;
  scenarioContext?: ScenarioEvaluateContext;
  piiRedaction?: {
    enabled: boolean;
    redactedRows: number;
    redactedFields: number;
    categories: string[];
  };
  organizationId?: string;
  projectId?: string;
  workspaceId?: string;
};

/**
 * Runtime observability for LLM judge calls made during one evaluation run.
 * Contains timing and status metadata only, never prompt or transcript content.
 */
export type LlmJudgeRunSummary = {
  enabled: boolean;
  totalRequests: number;
  succeededRequests: number;
  failedRequests: number;
  stages: Array<{
    stage: string;
    totalRequests: number;
    succeededRequests: number;
    failedRequests: number;
    avgQueuedMs: number;
    avgDurationMs: number;
    maxAttempts: number;
  }>;
  recentRequests: Array<{
    stage: string;
    status: "success" | "failed";
    queuedMs: number;
    durationMs: number;
    attempts: number;
    model: string;
    promptVersion: string | null;
    sessionId?: string;
    segmentId?: string;
    errorClass?: string;
    degradedReason?: string;
  }>;
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
  structuredTaskMetrics?: StructuredTaskMetrics;
  ingestMeta: {
    sessions: number;
    rows: number;
    hasTimestamp: boolean;
    organizationId?: string;
    projectId?: string;
    workspaceId?: string;
    piiRedaction?: {
      enabled: boolean;
      redactedRows: number;
      redactedFields: number;
      categories: string[];
    };
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
  structuredTaskMetrics?: StructuredTaskMetrics;
  trace?: EvalTrace;
  evalCaseBundle?: EvalCaseBundle;
  metricRegistry?: EvalMetricRegistrySnapshot;
  scenarioEvaluation: ScenarioEvaluation | null;
  badCaseAssets: BadCaseAsset[];
  /**
   * DeepEval-aligned extended metrics (faithfulness/hallucination/toolCorrectness/...).
   * Null fields mean the corresponding input was not provided.
   */
  extendedMetrics?: ExtendedMetricsBundle;
  charts: ChartPayload[];
  suggestions: string[];
};
