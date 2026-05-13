/**
 * @fileoverview Shared evaluation pipeline used by HTTP routes and batch jobs.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { consumeLlmRequestTelemetry, type LlmRequestTelemetry } from "@/lib/siliconflow";
import { buildBadCaseAssets } from "@/pipeline/badCases";
import { buildChartPayloads } from "@/pipeline/chartBuilder";
import { enrichRows, toEnrichedCsv } from "@/pipeline/enrich";
import { buildEvalCaseBundle } from "@/pipeline/evalCaseBuilder";
import { buildExtendedMetrics } from "@/pipeline/extendedMetrics";
import { buildMetricRegistrySnapshot } from "@/pipeline/metricRegistry";
import { buildObjectiveMetrics } from "@/pipeline/objectiveMetrics";
import { evaluateScenarioTemplate } from "@/pipeline/scenarioEvaluator";
import { buildSubjectiveMetrics } from "@/pipeline/subjectiveMetrics";
import { buildSuggestions } from "@/pipeline/suggest";
import { buildSummaryCards } from "@/pipeline/summary";
import { getScenarioTemplateById } from "@/scenarios";
import type {
  EvaluateResponse,
  EvaluateRunState,
  EvaluateStageRunStatus,
  LlmJudgeRunSummary,
  RawChatlogRow,
  ScenarioEvaluateContext,
} from "@/types/pipeline";
import type { StructuredTaskMetrics } from "@/types/rich-conversation";
import type { EvalTrace } from "@/types/eval-trace";
import type { EvaluationProgressEvent, EvaluationStageKey } from "@/types/evaluation-progress";
import type {
  KnowledgeRetentionFact,
  RetrievalContext,
  RoleProfile,
  ToolCallRecord,
} from "@/types/extended-metrics";

export type EvaluateRunOptions = {
  useLlm: boolean;
  judgeRequired?: boolean;
  runId: string;
  scenarioId?: string;
  scenarioContext?: ScenarioEvaluateContext;
  structuredTaskMetrics?: StructuredTaskMetrics;
  trace?: EvalTrace;
  persistArtifact?: boolean;
  artifactBaseName?: string;
  /**
   * Optional inputs for DeepEval-aligned extended metrics.
   * 提供任意子集即触发对应指标，未提供的指标返回 null。
   */
  extendedInputs?: {
    retrievalContexts?: RetrievalContext[];
    toolCalls?: ToolCallRecord[];
    retentionFacts?: KnowledgeRetentionFact[];
    roleProfile?: RoleProfile;
  };
  /**
   * Optional stage event callback used by streamed HTTP evaluation.
   * The pipeline keeps working when the callback throws.
   */
  onProgress?: (event: EvaluationProgressEvent) => void;
};

/**
 * Run full enrich → metrics → charts pipeline on raw rows.
 * @param rawRows Canonical raw chatlog rows.
 * @param options Execution options.
 * @returns Evaluate response plus optional artifact path.
 */
export async function runEvaluatePipeline(
  rawRows: RawChatlogRow[],
  options: EvaluateRunOptions,
): Promise<EvaluateResponse & { artifactPath?: string }> {
  const warnings: string[] = [];
  const stageStatuses: EvaluateStageRunStatus[] = [];
  const judgeRequired = options.judgeRequired ?? options.useLlm;
  if (!rawRows.every((row) => Boolean(row.timestamp))) {
    warnings.push("检测到缺失 timestamp，部分时序指标已降级。");
  }
  if (judgeRequired && !options.useLlm) {
    throw new Error("LLM Judge 是当前评估的强依赖，但本次请求关闭了 useLlm。");
  }

  const { enrichedRows, topicSegments } = await runEvaluateStage(options, stageStatuses, "parse", "解析数据", () =>
    enrichRows(rawRows, options.useLlm, options.runId),
  );
  const enrichedCsv = toEnrichedCsv(enrichedRows);
  const evalCaseBundle = buildEvalCaseBundle(enrichedRows, options.structuredTaskMetrics, options.trace);
  const objectiveMetrics = await runEvaluateStage(options, stageStatuses, "objective", "客观指标", async () =>
    buildObjectiveMetrics(enrichedRows),
  );
  const subjectiveMetrics = await runEvaluateStage(options, stageStatuses, "subjective", "主观指标", () =>
    buildSubjectiveMetrics(enrichedRows, options.useLlm, options.runId, { judgeRequired }),
  );
  if (subjectiveMetrics.status !== "ready") {
    markStageDegraded(stageStatuses, "subjective", "subjective_metrics_degraded");
  }
  const scenarioTemplate = options.scenarioId ? getScenarioTemplateById(options.scenarioId) : null;
  if (options.scenarioId && !scenarioTemplate) {
    warnings.push(`未找到场景模板：${options.scenarioId}，本次按通用评估返回。`);
  }
  const scenarioEvaluation = scenarioTemplate
    ? evaluateScenarioTemplate(scenarioTemplate, {
        rows: enrichedRows,
        objectiveMetrics,
        subjectiveMetrics,
      })
    : null;
  const metricRegistry = buildMetricRegistrySnapshot({
    objectiveMetrics,
    subjectiveMetrics,
    structuredTaskMetrics: options.structuredTaskMetrics,
    trace: options.trace,
    capabilities: evalCaseBundle.capabilityReport,
    scenarioEvaluation,
    scenarioTemplate,
  });
  // DeepEval-aligned extended metrics. 仅当提供了对应 input 时才会有结果。
  const extendedInputs = options.extendedInputs ?? {};
  const hasAnyExtendedInput = Boolean(
    extendedInputs.retrievalContexts?.length ||
      extendedInputs.toolCalls?.length ||
      extendedInputs.retentionFacts?.length ||
      extendedInputs.roleProfile,
  );
  const extendedMetrics = await runEvaluateStage(options, stageStatuses, "extended", "扩展指标", async () =>
    hasAnyExtendedInput
      ? buildExtendedMetrics({
          ...extendedInputs,
          useLlm: options.useLlm,
          runId: options.runId,
        })
      : undefined,
  );

  const badCaseAssets = await runEvaluateStage(options, stageStatuses, "badcase", "bad case 抽取", async () =>
    buildBadCaseAssets(enrichedRows, objectiveMetrics, subjectiveMetrics, {
      runId: options.runId,
      scenarioId: options.scenarioId,
    }),
  );

  const { charts, suggestions, summaryCards } = await runEvaluateStage(options, stageStatuses, "complete", "完成", async () => ({
    charts: buildChartPayloads(enrichedRows),
    suggestions: buildSuggestions(enrichedRows, objectiveMetrics, subjectiveMetrics),
    summaryCards: buildSummaryCards(
      objectiveMetrics,
      subjectiveMetrics,
      new Set(rawRows.map((row) => row.sessionId)).size,
      rawRows.length,
      scenarioEvaluation,
      badCaseAssets.length,
      options.structuredTaskMetrics,
    ),
  }));

  if (subjectiveMetrics.status !== "ready" && !judgeRequired) {
    warnings.push("主观评估当前为降级模式（LLM judge 调用失败或未启用）。");
  }
  const llmTelemetry = consumeLlmRequestTelemetry(options.runId);
  const llmJudge = buildLlmJudgeRunSummary(options.useLlm, llmTelemetry);
  if (llmJudge.failedRequests > 0) {
    markStageDegraded(stageStatuses, "subjective", "llm_judge_failed_requests");
  }

  let artifactPath: string | undefined;
  if (options.persistArtifact ?? Boolean(options.artifactBaseName)) {
    const artifactBaseName = sanitizeArtifactBaseName(options.artifactBaseName ?? options.runId);
    const artifactDirectory = path.join("mock-chatlog", "enriched-data");
    artifactPath = path.join(artifactDirectory, `${artifactBaseName}.enriched.csv`);
    await mkdir(artifactDirectory, { recursive: true });
    await writeFile(artifactPath, enrichedCsv, "utf8");
  }

  const response: EvaluateResponse & { artifactPath?: string } = {
    runId: options.runId,
    meta: {
      sessions: new Set(rawRows.map((row) => row.sessionId)).size,
      messages: rawRows.length,
      hasTimestamp: rawRows.every((row) => Boolean(row.timestamp)),
      generatedAt: new Date().toISOString(),
      warnings,
      runState: buildRunState(stageStatuses, warnings, llmJudge),
      stageStatuses,
      llmJudge,
      scenarioContext: options.scenarioContext,
    },
    summaryCards,
    topicSegments,
    enrichedRows,
    enrichedCsv,
    artifactPath,
    objectiveMetrics,
    subjectiveMetrics,
    structuredTaskMetrics: options.structuredTaskMetrics,
    trace: options.trace,
    evalCaseBundle,
    metricRegistry,
    scenarioEvaluation,
    badCaseAssets,
    extendedMetrics,
    charts,
    suggestions,
  };

  return response;
}

/**
 * Build response-safe LLM runtime metadata.
 * @param enabled Whether this evaluate run requested LLM judges.
 * @param records Request telemetry captured by the LLM client.
 * @returns Aggregated LLM judge metadata.
 */
function buildLlmJudgeRunSummary(
  enabled: boolean,
  records: LlmRequestTelemetry[],
): LlmJudgeRunSummary {
  const stageGroups = new Map<string, LlmRequestTelemetry[]>();
  records.forEach((record) => {
    stageGroups.set(record.stage, [...(stageGroups.get(record.stage) ?? []), record]);
  });

  return {
    enabled,
    totalRequests: records.length,
    succeededRequests: records.filter((record) => record.status === "success").length,
    failedRequests: records.filter((record) => record.status === "failed").length,
    stages: [...stageGroups.entries()].map(([stage, stageRecords]) => ({
      stage,
      totalRequests: stageRecords.length,
      succeededRequests: stageRecords.filter((record) => record.status === "success").length,
      failedRequests: stageRecords.filter((record) => record.status === "failed").length,
      avgQueuedMs: averageRounded(stageRecords.map((record) => record.queuedMs)),
      avgDurationMs: averageRounded(stageRecords.map((record) => record.durationMs)),
      maxAttempts: Math.max(...stageRecords.map((record) => record.attempts)),
    })),
    recentRequests: records.slice(-20).map((record) => ({
      stage: record.stage,
      status: record.status,
      queuedMs: record.queuedMs,
      durationMs: record.durationMs,
      attempts: record.attempts,
      model: record.model,
      promptVersion: record.promptVersion,
      sessionId: record.sessionId,
      segmentId: record.segmentId,
      errorClass: record.errorClass,
      degradedReason: record.degradedReason,
    })),
  };
}

/**
 * Average a list of timing values.
 * @param values Timing values.
 * @returns Rounded average, or 0 when empty.
 */
function averageRounded(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

/**
 * Run one named evaluation stage and emit observable progress events.
 *
 * @param options Evaluation options containing optional progress callback.
 * @param stage Stable stage key.
 * @param label Human-readable stage label.
 * @param operation Stage operation.
 * @returns Operation result.
 */
async function runEvaluateStage<T>(
  options: EvaluateRunOptions,
  stageStatuses: EvaluateStageRunStatus[],
  stage: EvaluationStageKey,
  label: string,
  operation: () => Promise<T> | T,
): Promise<T> {
  emitProgress(options, { type: "stage", stage, status: "running", message: `${label}进行中` });
  const startedAt = Date.now();
  try {
    const result = await operation();
    stageStatuses.push({
      stage,
      status: "ready",
      durationMs: Date.now() - startedAt,
    });
    emitProgress(options, { type: "stage", stage, status: "done", message: `${label}完成` });
    return result;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    stageStatuses.push({
      stage,
      status: "failed",
      durationMs: Date.now() - startedAt,
      degradedReason: detail,
    });
    emitProgress(options, { type: "stage", stage, status: "failed", message: `${label}失败`, detail });
    throw error;
  }
}

/**
 * Mark a completed stage as degraded while preserving its measured duration.
 * @param stageStatuses Mutable stage status list.
 * @param stage Stage to update.
 * @param reason Stable degraded reason.
 */
function markStageDegraded(
  stageStatuses: EvaluateStageRunStatus[],
  stage: EvaluationStageKey,
  reason: string,
): void {
  const status = [...stageStatuses].reverse().find((item) => item.stage === stage);
  if (!status || status.status === "failed") {
    return;
  }
  status.status = "degraded";
  status.degradedReason = status.degradedReason ? `${status.degradedReason};${reason}` : reason;
}

/**
 * Build the response-level run state from warnings and stage metadata.
 * @param stageStatuses Stage status list.
 * @param warnings Run warnings.
 * @param llmJudge LLM judge summary.
 * @returns Run state.
 */
function buildRunState(
  stageStatuses: EvaluateStageRunStatus[],
  warnings: string[],
  llmJudge: LlmJudgeRunSummary,
): EvaluateRunState {
  if (stageStatuses.some((stage) => stage.status === "failed")) {
    return "failed";
  }
  if (
    warnings.length > 0 ||
    llmJudge.failedRequests > 0 ||
    stageStatuses.some((stage) => stage.status === "degraded")
  ) {
    return "degraded";
  }
  return "ready";
}

/**
 * Emit a progress event without letting callback failures break evaluation.
 *
 * @param options Evaluation options.
 * @param event Progress event.
 */
function emitProgress(options: EvaluateRunOptions, event: EvaluationProgressEvent): void {
  try {
    options.onProgress?.(event);
  } catch (error) {
    console.warn(`[EVALUATE] progress callback failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Sanitize a file base name for artifact persistence.
 * @param value Requested artifact base name.
 * @returns Safe file base name.
 */
function sanitizeArtifactBaseName(value: string): string {
  return value.replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "") || "enriched-artifact";
}
