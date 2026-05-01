/**
 * @fileoverview Shared contracts for dataset storage adapters.
 */

import type { BadCaseFeatureSnapshot } from "@/badcase/types";

/**
 * Supported dataset case set types.
 */
export type CaseSetType = "goodcase" | "badcase";

/**
 * Lightweight human review verdict for auto-captured cases.
 */
export type DatasetCaseHumanVerdict = "valid_bad_case" | "false_positive" | "unclear";

/**
 * Review lifecycle for a dataset case.
 */
export type DatasetCaseReviewStatus =
  | "auto_captured"
  | "human_reviewed"
  | "gold_candidate"
  | "gold"
  | "regression_active";

/**
 * Minimal dataset case record stored in the evaluation dataset.
 */
export type DatasetCaseRecord = {
  caseId: string;
  caseSetType: CaseSetType;
  sessionId: string;
  topicSegmentId: string;
  topicLabel: string;
  topicSummary: string;
  normalizedTranscriptHash: string;
  duplicateGroupKey?: string;
  baselineVersion: string;
  baselineCaseScore: number;
  tags: string[];
  title?: string;
  transcript?: string;
  suggestedAction?: string;
  humanVerdict?: DatasetCaseHumanVerdict;
  failureType?: string;
  expectedBehavior?: string;
  reviewNotes?: string;
  reviewer?: string;
  reviewedAt?: string;
  reviewStatus?: DatasetCaseReviewStatus;
  scenarioId?: string;
  sourceRunId?: string;
  harvestedAt?: string;
  failureSeverityScore?: number;
  featureSnapshot?: BadCaseFeatureSnapshot;
  createdAt: string;
  updatedAt: string;
};

/**
 * Baseline snapshot stored with one dataset case.
 */
export type DatasetBaselineRecord = {
  caseId: string;
  baselineCaseScore: number;
  baselineObjectiveScore: number;
  baselineSubjectiveScore: number;
  baselineRiskPenaltyScore: number;
  baselineSignals: Array<{
    signalKey: string;
    score: number;
    severity: string;
  }>;
  baselineGeneratedAt: string;
  baselineProductVersion: string;
};

/**
 * One case-level run result for a sampled evaluation run.
 */
export type DatasetRunResultRecord = {
  runId: string;
  sampleBatchId: string;
  caseId: string;
  baselineCaseScore: number;
  currentCaseScore: number;
  scoreDelta: number;
  isImproved: boolean;
  isRegressed: boolean;
  judgeReason: string;
  createdAt: string;
};

/**
 * One saved sample batch used for stable version comparison.
 */
export type SampleBatchRecord = {
  sampleBatchId: string;
  caseIds: string[];
  requestedGoodcaseCount: number;
  requestedBadcaseCount: number;
  strategy: string;
  targetVersion?: string;
  createdAt: string;
  /** 实际入批的 goodcase 数量（可能小于请求值）。 */
  actualGoodcaseCount?: number;
  /** 实际入批的 badcase 数量（可能小于请求值）。 */
  actualBadcaseCount?: number;
  /** 抽样不足量、去重压缩等可观测提示。 */
  warnings?: string[];
};

/**
 * Duplicate check result returned by the storage adapter.
 */
export type DuplicateCheckResult = {
  isDuplicate: boolean;
  reason: "exact_hash" | "near_duplicate" | "none";
  matchedCaseId?: string;
  similarityScore?: number;
};
