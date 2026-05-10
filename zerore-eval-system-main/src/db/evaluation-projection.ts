/**
 * @fileoverview Projection from EvaluateResponse into relational quality records.
 */

import type { DbRecord, ZeroreDatabase } from "@/db";
import type {
  DbBusinessKpiSignal,
  DbEvaluationProjectionRecord,
  DbEvaluationRun,
  DbEvidenceSpan,
  DbObjectiveSignal,
  DbRiskTag,
  DbSubjectiveSignal,
  DbTopicSegment,
} from "@/db/schema";
import type { EvaluateResponse, ObjectiveMetrics } from "@/types/pipeline";

export type EvaluationProjectionOptions = {
  organizationId?: string;
  projectId?: string;
  workspaceId: string;
  runId?: string;
  useLlm?: boolean;
};

export type EvaluationProjection = {
  records: DbEvaluationProjectionRecord[];
  dbRecords: DbRecord[];
  summary: {
    evaluationRuns: number;
    topicSegments: number;
    objectiveSignals: number;
    subjectiveSignals: number;
    businessKpiSignals: number;
    evidenceSpans: number;
    riskTags: number;
  };
};

type EvidenceInput = {
  kind: string;
  quote: string;
  sessionId?: string;
  topicSegmentId?: string;
  startTurn?: number;
  endTurn?: number;
  source?: DbEvidenceSpan["source"];
};

/**
 * Project a completed evaluation response into normalized database records.
 *
 * @param response Completed evaluation response.
 * @param options Projection options.
 * @returns Projection records plus local database records.
 */
export function buildEvaluationProjection(
  response: EvaluateResponse,
  options: EvaluationProjectionOptions,
): EvaluationProjection {
  const workspaceId = options.workspaceId;
  const organizationId = options.organizationId;
  const projectId = options.projectId ?? workspaceId;
  const now = response.meta.generatedAt || new Date().toISOString();
  const runId = options.runId ?? response.runId;
  const evaluationRunId = stableId("evaluation-run", workspaceId, runId);
  const evidenceSpans: DbEvidenceSpan[] = [];

  const createEvidence = (input: EvidenceInput): string | undefined => {
    const quote = input.quote.trim();
    if (!quote) {
      return undefined;
    }
    const id = stableId(
      "evidence",
      workspaceId,
      runId,
      input.kind,
      input.sessionId ?? "run",
      input.topicSegmentId ?? "none",
      input.startTurn ?? "na",
      quote,
    );
    if (!evidenceSpans.some((item) => item.id === id)) {
      evidenceSpans.push({
        table: "evidence_spans",
        id,
        workspaceId,
        evaluationRunId,
        sessionId: input.sessionId,
        topicSegmentId: input.topicSegmentId
          ? stableId("topic-segment", workspaceId, runId, input.topicSegmentId)
          : undefined,
        evidenceKind: input.kind,
        quote,
        startTurn: input.startTurn,
        endTurn: input.endTurn,
        source: input.source ?? "rule",
        createdAt: now,
      });
    }
    return id;
  };

  const evaluationRun: DbEvaluationRun = {
    table: "evaluation_runs",
    id: evaluationRunId,
    workspaceId,
    runId,
    scenarioId: response.meta.scenarioContext?.scenarioId,
    status: "succeeded",
    useLlm: Boolean(options.useLlm),
    sessionCount: response.meta.sessions,
    messageCount: response.meta.messages,
    hasTimestamp: response.meta.hasTimestamp,
    warnings: response.meta.warnings,
    artifactUri: response.artifactPath,
    generatedAt: response.meta.generatedAt,
    createdAt: now,
    rawResponse: {
      summaryCards: response.summaryCards,
      piiRedaction: response.meta.piiRedaction,
      scenarioContext: response.meta.scenarioContext,
    },
  };

  const topicSegments: DbTopicSegment[] = response.topicSegments.map((segment) => ({
    table: "topic_segments",
    id: stableId("topic-segment", workspaceId, runId, segment.topicSegmentId),
    workspaceId,
    evaluationRunId,
    sessionId: segment.sessionId,
    topicSegmentId: segment.topicSegmentId,
    topicSegmentIndex: segment.topicSegmentIndex,
    label: segment.topicLabel,
    summary: segment.topicSummary,
    source: segment.topicSource,
    confidence: segment.topicConfidence,
    startTurn: segment.startTurn,
    endTurn: segment.endTurn,
    messageCount: segment.messageCount,
    emotionPolarity: segment.emotionPolarity,
    emotionIntensity: segment.emotionIntensity,
    emotionScore: segment.emotionScore,
    metadata: {
      emotionLabel: segment.emotionLabel,
      emotionBaseScore: segment.emotionBaseScore,
      emotionEvidence: segment.emotionEvidence,
      emotionConfidence: segment.emotionConfidence,
      emotionFactors: {
        valenceWeight: segment.emotionValenceWeight,
        lengthWeight: segment.emotionLengthWeight,
        styleWeight: segment.emotionStyleWeight,
        gapWeight: segment.emotionGapWeight,
        recoveryWeight: segment.emotionRecoveryWeight,
        riskPenalty: segment.emotionRiskPenalty,
      },
    },
    createdAt: now,
  }));

  for (const segment of response.topicSegments) {
    createEvidence({
      kind: "topic_emotion",
      quote: segment.emotionEvidence,
      sessionId: segment.sessionId,
      topicSegmentId: segment.topicSegmentId,
      startTurn: segment.startTurn,
      endTurn: segment.endTurn,
      source: segment.emotionSource,
    });
  }

  const objectiveSignals = buildObjectiveSignals(response.objectiveMetrics, {
    workspaceId,
    evaluationRunId,
    now,
  });

  const subjectiveSignals: DbSubjectiveSignal[] = response.subjectiveMetrics.dimensions.map((dimension) => {
    const evidenceSpanId = createEvidence({
      kind: "subjective_dimension",
      quote: dimension.evidence,
      source: "llm",
    });
    return {
      table: "subjective_signals",
      id: stableId("subjective-signal", workspaceId, runId, dimension.dimension),
      workspaceId,
      evaluationRunId,
      dimensionKey: slugify(dimension.dimension),
      dimensionLabel: dimension.dimension,
      score: dimension.score,
      reason: dimension.reason,
      source: "llm",
      confidence: dimension.confidence,
      evidenceSpanId,
      createdAt: now,
    };
  });

  const riskTags: DbRiskTag[] = [];
  for (const signal of response.subjectiveMetrics.signals) {
    const evidenceSpanId = createEvidence({
      kind: "implicit_signal",
      quote: signal.evidence,
      sessionId: parseEvidenceSessionId(signal.evidenceTurnRange),
      startTurn: parseEvidenceTurnRange(signal.evidenceTurnRange).startTurn,
      endTurn: parseEvidenceTurnRange(signal.evidenceTurnRange).endTurn,
      source: "inferred",
    });
    riskTags.push({
      table: "risk_tags",
      id: stableId("risk-tag", workspaceId, runId, signal.signalKey),
      workspaceId,
      evaluationRunId,
      sessionId: parseEvidenceSessionId(signal.evidenceTurnRange),
      tagKey: signal.signalKey,
      severityScore: signal.score,
      reason: signal.reason,
      evidenceSpanId,
      source: "inferred",
      createdAt: now,
    });
  }

  for (const badCase of response.badCaseAssets) {
    for (const tag of badCase.tags) {
      const evidenceSpanId = badCase.evidence[0]
        ? createEvidence({
            kind: "bad_case",
            quote: badCase.evidence.map((item) => `[turn ${item.turnIndex}] ${item.content}`).join("\n"),
            sessionId: badCase.sessionId,
            topicSegmentId: badCase.topicSegmentId,
            startTurn: badCase.evidence[0].turnIndex,
            endTurn: badCase.evidence[badCase.evidence.length - 1]?.turnIndex,
            source: "rule",
          })
        : undefined;
      riskTags.push({
        table: "risk_tags",
        id: stableId("risk-tag", workspaceId, runId, badCase.caseKey, tag),
        workspaceId,
        evaluationRunId,
        sessionId: badCase.sessionId,
        topicSegmentId: stableId("topic-segment", workspaceId, runId, badCase.topicSegmentId),
        tagKey: tag,
        severityScore: badCase.severityScore,
        reason: badCase.title,
        evidenceSpanId,
        source: "rule",
        createdAt: now,
      });
    }
  }

  const businessKpiSignals = buildBusinessKpiSignals(response, {
    workspaceId,
    evaluationRunId,
    now,
    createEvidence,
  });

  const records: DbEvaluationProjectionRecord[] = [
    evaluationRun,
    ...topicSegments,
    ...objectiveSignals,
    ...subjectiveSignals,
    ...businessKpiSignals,
    ...evidenceSpans,
    ...riskTags,
  ].map((record) => ({
    ...record,
    organizationId,
    projectId,
  }));

  return {
    records,
    dbRecords: records.map(toDbRecord),
    summary: {
      evaluationRuns: 1,
      topicSegments: topicSegments.length,
      objectiveSignals: objectiveSignals.length,
      subjectiveSignals: subjectiveSignals.length,
      businessKpiSignals: businessKpiSignals.length,
      evidenceSpans: evidenceSpans.length,
      riskTags: riskTags.length,
    },
  };
}

/**
 * Persist an evaluation projection through the active database adapter.
 *
 * @param database Database adapter.
 * @param projection Projection payload.
 */
export async function persistEvaluationProjection(
  database: ZeroreDatabase,
  projection: EvaluationProjection,
): Promise<void> {
  for (const record of projection.dbRecords) {
    await database.upsert(record);
  }
}

function buildObjectiveSignals(
  metrics: ObjectiveMetrics,
  context: {
    workspaceId: string;
    evaluationRunId: string;
    now: string;
  },
): DbObjectiveSignal[] {
  return Object.entries(metrics).map(([metricKey, value]) => {
    const id = stableId("objective-signal", context.workspaceId, context.evaluationRunId, metricKey);
    return {
      table: "objective_signals",
      id,
      workspaceId: context.workspaceId,
      evaluationRunId: context.evaluationRunId,
      metricKey,
      metricLabel: metricKey,
      numericValue: typeof value === "number" ? value : undefined,
      jsonValue: typeof value === "number" ? undefined : value,
      reason: "Objective metric generated by the local evaluation pipeline.",
      source: "rule",
      confidence: 1,
      createdAt: context.now,
    };
  });
}

function buildBusinessKpiSignals(
  response: EvaluateResponse,
  context: {
    workspaceId: string;
    evaluationRunId: string;
    now: string;
    createEvidence: (input: EvidenceInput) => string | undefined;
  },
): DbBusinessKpiSignal[] {
  const signals: DbBusinessKpiSignal[] = [];

  for (const goal of response.subjectiveMetrics.goalCompletions) {
    const evidenceSpanId = context.createEvidence({
      kind: "goal_completion",
      quote: [...goal.achievementEvidence, ...goal.failureReasons].join("\n"),
      sessionId: goal.sessionId,
      source: goal.source,
    });
    signals.push({
      table: "business_kpi_signals",
      id: stableId("business-kpi", context.workspaceId, context.evaluationRunId, "goal", goal.sessionId),
      workspaceId: context.workspaceId,
      evaluationRunId: context.evaluationRunId,
      sessionId: goal.sessionId,
      kpiKey: "goalCompletion",
      status: goal.status,
      score: goal.score,
      value: {
        userIntent: goal.userIntent,
        intentSource: goal.intentSource,
        triggeredRules: goal.triggeredRules,
      },
      reason: goal.failureReasons.join("; ") || goal.achievementEvidence.join("; "),
      source: goal.source,
      confidence: goal.confidence,
      evidenceSpanId,
      createdAt: context.now,
    });
  }

  for (const trace of response.subjectiveMetrics.recoveryTraces) {
    const evidenceSpanId = context.createEvidence({
      kind: "recovery_trace",
      quote: trace.evidence.map((item) => `[turn ${item.turnIndex}] ${item.content}`).join("\n"),
      sessionId: trace.sessionId,
      startTurn: trace.failureTurn ?? undefined,
      endTurn: trace.recoveryTurn ?? undefined,
      source: "inferred",
    });
    signals.push({
      table: "business_kpi_signals",
      id: stableId("business-kpi", context.workspaceId, context.evaluationRunId, "recovery", trace.sessionId),
      workspaceId: context.workspaceId,
      evaluationRunId: context.evaluationRunId,
      sessionId: trace.sessionId,
      kpiKey: "recoveryTrace",
      status: trace.status,
      score: trace.qualityScore,
      value: {
        failureTurn: trace.failureTurn,
        recoveryTurn: trace.recoveryTurn,
        spanTurns: trace.spanTurns,
        failureType: trace.failureType,
        repairStrategy: trace.repairStrategy,
        repairStrategySource: trace.repairStrategySource,
        triggeredRules: trace.triggeredRules,
      },
      reason: trace.repairStrategy ?? trace.failureType,
      source: "inferred",
      confidence: trace.confidence,
      evidenceSpanId,
      createdAt: context.now,
    });
  }

  for (const kpi of response.scenarioEvaluation?.kpis ?? []) {
    const evidenceSpanId = context.createEvidence({
      kind: "scenario_kpi",
      quote: kpi.topEvidence.join("\n"),
      source: "rule",
    });
    signals.push({
      table: "business_kpi_signals",
      id: stableId("business-kpi", context.workspaceId, context.evaluationRunId, "scenario", kpi.id),
      workspaceId: context.workspaceId,
      evaluationRunId: context.evaluationRunId,
      kpiKey: kpi.id,
      status: kpi.status,
      score: kpi.score,
      value: {
        displayName: kpi.displayName,
        description: kpi.description,
        successThreshold: kpi.successThreshold,
        degradedThreshold: kpi.degradedThreshold,
        contributions: kpi.contributions,
      },
      reason: kpi.topEvidence.join("; "),
      source: "rule",
      confidence: 1,
      evidenceSpanId,
      createdAt: context.now,
    });
  }

  return signals;
}

function toDbRecord(record: DbEvaluationProjectionRecord): DbRecord {
  return {
    id: record.id,
    organizationId: record.organizationId,
    projectId: record.projectId,
    workspaceId: record.workspaceId,
    type: record.table,
    payload: record,
    createdAt: record.createdAt,
    updatedAt: record.createdAt,
  };
}

function parseEvidenceSessionId(value: string): string | undefined {
  const match = /^([^:]+):/.exec(value);
  return match?.[1];
}

function parseEvidenceTurnRange(value: string): { startTurn?: number; endTurn?: number } {
  const match = /:(\d+)-(\d+)/.exec(value);
  if (!match) {
    return {};
  }
  return {
    startTurn: Number(match[1]),
    endTurn: Number(match[2]),
  };
}

function stableId(...parts: Array<string | number>): string {
  return parts.map((part) => slugify(String(part))).filter(Boolean).join("_");
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120) || "unknown"
  );
}
