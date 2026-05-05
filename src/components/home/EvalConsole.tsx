/**
 * @fileoverview Production-oriented evaluation console — 4-step guided flow.
 */

"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { BadCasePanel } from "@/components/home/BadCasePanel";
import { previewCsvLines, splitCsvLine } from "@/lib/csv";
import { inferFormatFromFileName } from "@/parsers";
import { ChartsPanel } from "@/components/home/ChartsPanel";
import {
  EvaluationProgress,
  applyEvaluationProgressEvent,
  createInitialEvaluationStages,
  type EvaluationStageState,
} from "@/components/home/EvaluationProgress";
import { ExtendedMetricsPanel } from "@/components/home/ExtendedMetricsPanel";
import { FeatherIcon } from "@/components/home/FeatherIcon";
import { GoalCompletionPanel } from "@/components/home/GoalCompletionPanel";
import { PreviewTable } from "@/components/home/PreviewTable";
import { RemediationPackagePanel } from "@/components/home/RemediationPackagePanel";
import { RecoveryTracePanel } from "@/components/home/RecoveryTracePanel";
import { ScenarioKpiPanel } from "@/components/home/ScenarioKpiPanel";
import { StatusPanel } from "@/components/home/StatusPanel";
import { SuggestionPanel } from "@/components/home/SuggestionPanel";
import { SummaryGrid } from "@/components/home/SummaryGrid";
import { UploadDropzone } from "@/components/home/UploadDropzone";
import { AppShell, Stepper, type StepperStep } from "@/components/shell";
import type { RemediationPackageSnapshot } from "@/remediation";
import { SCENARIO_OPTIONS } from "@/scenarios";
import type { DataMappingPlan } from "@/types/data-onboarding";
import type { EvalCaseBundle } from "@/types/eval-case";
import type { EvalMetricRegistrySnapshot, EvalMetricResult } from "@/types/eval-metric";
import type { EvaluationProgressEvent, EvaluationStageKey } from "@/types/evaluation-progress";
import type { StructuredTaskMetrics } from "@/types/rich-conversation";
import type { ScenarioEvaluationMetric, ScenarioSyntheticCaseSeed } from "@/types/scenario";
import type {
  EvaluateResponse,
  IngestResponse,
  SummaryCard,
  UploadFormat,
} from "@/types/pipeline";
import styles from "./evalConsole.module.css";

type EvalConsoleRunState = "idle" | "ingesting" | "ready" | "running" | "success" | "error";

type ResultTabKey = "summary" | "metric" | "badcase" | "goal" | "recovery" | "kpi" | "suggestion";

type EvalConsoleSessionSnapshot = {
  fileName: string;
  format: UploadFormat;
  ingestResult: IngestResponse | null;
  evaluateResult: EvaluateResponse | null;
  runState: EvalConsoleRunState;
  processStep: number;
  error: string;
  notice: string;
  baselineCustomerId: string;
  selectedScenarioId: string;
  scenarioOnboardingAnswers: Record<string, string>;
  remediationPackage: RemediationPackageSnapshot | null;
  dataMappingPlan: DataMappingPlan | null;
  currentStep: number;
};

const PROCESSING_LOGS = [
  "接收原始日志并校验字段完整性",
  "按 session 排序并补全中间字段",
  "计算客观指标、目标达成与恢复摘要",
  "执行业务 KPI 映射与证据聚合",
  "生成图表载荷、证据与策略建议",
  "组装本次评估交付结果",
];
const EVALUATION_STAGE_INDEX: Record<EvaluationStageKey, number> = {
  parse: 0,
  objective: 1,
  subjective: 2,
  extended: 3,
  badcase: 4,
  complete: 5,
};
const ALLOWED_EXTENSIONS = new Set(["csv", "json", "jsonl", "txt", "md"]);
const MAX_UPLOAD_SIZE_MB = 5;
const EVAL_CONSOLE_SNAPSHOT_KEY = "zeval:evalConsoleSnapshot:v2";
const LEGACY_EVAL_CONSOLE_SNAPSHOT_KEY = "zerore:evalConsoleSnapshot:v2";
const LAST_CUSTOMER_ID_KEY = "zeval:lastCustomerId";
const LEGACY_LAST_CUSTOMER_ID_KEY = "zerore:lastCustomerId";
const SGD_SAMPLE_DATASET = {
  fileName: "sgd-restaurants-sample.json",
  path: "/datasets/sgd-restaurants-sample.json",
  title: "餐厅预订任务型助手样例",
  description: "DSTC8 Schema-Guided Dialogue · Restaurants_1 · 24 turns",
};

const STEPS: StepperStep[] = [
  { key: "upload", title: "1 · 上传日志", hint: "选择文件 + 业务场景" },
  { key: "evaluate", title: "2 · 运行评估", hint: "查看指标与 bad case" },
  { key: "package", title: "3 · 生成调优包", hint: "交给 Claude Code / Codex" },
  { key: "validate", title: "4 · 保存基线 / 回放", hint: "进入在线评测验证" },
];

/**
 * Request an upload-time mapping plan from the Data Onboarding Agent.
 */
async function requestDataMappingPlan(
  text: string,
  format: UploadFormat,
  fileName: string,
): Promise<DataMappingPlan> {
  const response = await fetch("/api/data-onboarding", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, format, fileName, useLlm: true }),
  });
  const result = (await response.json()) as { plan?: DataMappingPlan; error?: string };
  if (!response.ok || !result.plan) {
    throw new Error(result.error ?? "数据结构识别失败");
  }
  return result.plan;
}

/**
 * Consume evaluate SSE events and return the streamed result payload.
 *
 * @param response Fetch response from /api/evaluate?stream=1.
 * @param onStage Stage event callback.
 * @returns Completed evaluate response.
 */
async function readEvaluateStream(
  response: Response,
  onStage: (event: EvaluationProgressEvent) => void,
): Promise<EvaluateResponse> {
  if (!response.body) {
    throw new Error("评估流不可用，请重试。");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: EvaluateResponse | null = null;

  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";
    for (const chunk of chunks) {
      const data = chunk
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (!data || data === "[DONE]") {
        continue;
      }
      const event = JSON.parse(data) as
        | EvaluationProgressEvent
        | { type: "result"; result: EvaluateResponse }
        | { type: "error"; message: string };
      if (event.type === "stage") {
        onStage(event);
      } else if (event.type === "result") {
        result = event.result;
      } else if (event.type === "error") {
        throw new Error(event.message);
      }
    }
  }

  if (!result) {
    throw new Error("评估流结束但未返回结果。");
  }
  return result;
}

/**
 * Render the main evaluation console.
 */
export function EvalConsole() {
  const snapshotHydratedRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [fileName, setFileName] = useState("");
  const [format, setFormat] = useState<UploadFormat>("csv");
  const [ingestResult, setIngestResult] = useState<IngestResponse | null>(null);
  const [evaluateResult, setEvaluateResult] = useState<EvaluateResponse | null>(null);
  const [runState, setRunState] = useState<EvalConsoleRunState>("idle");
  const [dragActive, setDragActive] = useState(false);
  const [processStep, setProcessStep] = useState(0);
  const [evaluationStages, setEvaluationStages] = useState<Record<EvaluationStageKey, EvaluationStageState>>(
    createInitialEvaluationStages,
  );
  const [showEvaluationProgress, setShowEvaluationProgress] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [baselineCustomerId, setBaselineCustomerId] = useState("default");
  const [baselineSaving, setBaselineSaving] = useState(false);
  const [badCaseHarvesting, setBadCaseHarvesting] = useState(false);
  const [remediationGenerating, setRemediationGenerating] = useState(false);
  const [sampleLoading, setSampleLoading] = useState(false);
  const [selectedScenarioId, setSelectedScenarioId] = useState("");
  const [scenarioOnboardingAnswers, setScenarioOnboardingAnswers] = useState<Record<string, string>>({});
  const [remediationPackage, setRemediationPackage] = useState<RemediationPackageSnapshot | null>(null);
  const [dataMappingPlan, setDataMappingPlan] = useState<DataMappingPlan | null>(null);
  const [currentStep, setCurrentStep] = useState(0);
  const [resultTab, setResultTab] = useState<ResultTabKey>("summary");

  useEffect(() => {
    const lastCustomerId =
      window.localStorage.getItem(LAST_CUSTOMER_ID_KEY) ??
      window.localStorage.getItem(LEGACY_LAST_CUSTOMER_ID_KEY);
    if (lastCustomerId) {
      setBaselineCustomerId(lastCustomerId);
    }

    const snapshotRaw =
      window.sessionStorage.getItem(EVAL_CONSOLE_SNAPSHOT_KEY) ??
      window.sessionStorage.getItem(LEGACY_EVAL_CONSOLE_SNAPSHOT_KEY);
    if (!snapshotRaw) {
      snapshotHydratedRef.current = true;
      return;
    }
    try {
      const snapshot = JSON.parse(snapshotRaw) as EvalConsoleSessionSnapshot;
      setFileName(snapshot.fileName ?? "");
      setFormat(snapshot.format ?? "csv");
      setIngestResult(snapshot.ingestResult ?? null);
      setEvaluateResult(snapshot.evaluateResult ?? null);
      setRunState(snapshot.runState ?? "idle");
      setProcessStep(snapshot.processStep ?? 0);
      setError(snapshot.error ?? "");
      setNotice(snapshot.notice ?? "");
      if (snapshot.baselineCustomerId) {
        setBaselineCustomerId(snapshot.baselineCustomerId);
      }
      setSelectedScenarioId(snapshot.selectedScenarioId ?? "");
      setScenarioOnboardingAnswers(snapshot.scenarioOnboardingAnswers ?? {});
      setRemediationPackage(snapshot.remediationPackage ?? null);
      setDataMappingPlan(snapshot.dataMappingPlan ?? null);
      setCurrentStep(snapshot.currentStep ?? 0);
    } catch {
      window.sessionStorage.removeItem(EVAL_CONSOLE_SNAPSHOT_KEY);
    } finally {
      snapshotHydratedRef.current = true;
    }
  }, []);

  useEffect(() => {
    if (!snapshotHydratedRef.current) {
      return;
    }
    const snapshot: EvalConsoleSessionSnapshot = {
      fileName,
      format,
      ingestResult,
      evaluateResult,
      runState,
      processStep,
      error,
      notice,
      baselineCustomerId,
      selectedScenarioId,
      scenarioOnboardingAnswers,
      remediationPackage,
      dataMappingPlan,
      currentStep,
    };
    window.sessionStorage.setItem(EVAL_CONSOLE_SNAPSHOT_KEY, JSON.stringify(snapshot));
  }, [
    fileName,
    format,
    ingestResult,
    evaluateResult,
    runState,
    processStep,
    error,
    notice,
    baselineCustomerId,
    selectedScenarioId,
    scenarioOnboardingAnswers,
    remediationPackage,
    dataMappingPlan,
    currentStep,
  ]);

  const previewLines = useMemo(
    () => ingestResult?.previewTop20 ?? previewCsvLines(ingestResult?.canonicalCsv ?? "", 21),
    [ingestResult],
  );
  const previewHeader = useMemo(
    () => (previewLines.length ? splitCsvLine(previewLines[0]) : []),
    [previewLines],
  );
  const previewRows = useMemo(
    () => previewLines.slice(1).map((line) => splitCsvLine(line)),
    [previewLines],
  );
  const summaryCards = useMemo<SummaryCard[]>(
    () =>
      evaluateResult?.summaryCards ?? [
        { key: "sessionCount", label: "会话规模", value: "--", hint: "等待日志接入" },
        { key: "responseGap", label: "平均响应间隔", value: "--", hint: "等待评估执行" },
        { key: "topicSwitch", label: "话题切换率", value: "--", hint: "等待评估执行" },
        { key: "empathy", label: "共情得分", value: "--", hint: "等待主观评估" },
        { key: "goalCompletion", label: "目标达成率", value: "--", hint: "等待 goal completion 评估" },
        { key: "businessKpi", label: "业务 KPI", value: "--", hint: "等待场景映射" },
        { key: "badCaseCount", label: "Bad Case", value: "--", hint: "等待失败案例提取" },
        { key: "recoveryTrace", label: "恢复轨迹", value: "--", hint: "等待 recovery trace 识别" },
      ],
    [evaluateResult],
  );
  const warnings = evaluateResult?.meta.warnings ?? ingestResult?.warnings ?? [];
  const canRunEvaluate = Boolean(ingestResult?.rawRows.length) && runState !== "running" && runState !== "ingesting";
  const runStateLabel = getRunStateLabel(runState);
  const selectedScenarioOption = SCENARIO_OPTIONS.find((item) => item.scenarioId === selectedScenarioId);
  const selectedScenarioLabel = selectedScenarioOption?.displayName ?? "通用评估";
  const activeOnboardingQuestions = selectedScenarioOption?.onboardingQuestions ?? [];
  const answeredOnboardingCount = activeOnboardingQuestions.filter(
    (item) => scenarioOnboardingAnswers[item.id]?.trim(),
  ).length;

  const completedStep = useMemo(() => {
    if (remediationPackage) return 3;
    if (evaluateResult) return 2;
    if (ingestResult) return 1;
    return 0;
  }, [ingestResult, evaluateResult, remediationPackage]);

  /**
   * Parse and upload one selected file.
   */
  async function handleFile(file: File) {
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      setError("文件类型不支持，请上传 csv/json/jsonl/txt/md。");
      setRunState("error");
      return;
    }
    if (file.size > MAX_UPLOAD_SIZE_MB * 1024 * 1024) {
      setError(`文件过大，请上传不超过 ${MAX_UPLOAD_SIZE_MB}MB 的日志文件。`);
      setRunState("error");
      return;
    }

    try {
      setRunState("ingesting");
      setError("");
      setNotice("");
      setEvaluateResult(null);
      setIngestResult(null);
      setRemediationPackage(null);
      setDataMappingPlan(null);
      setShowEvaluationProgress(false);
      setEvaluationStages(createInitialEvaluationStages());
      setFileName(file.name);
      const inferred = inferFormatFromFileName(file.name);
      setFormat(inferred);
      const text = await file.text();
      setDataMappingPlan(await requestDataMappingPlan(text, inferred, file.name));

      const response = await fetch("/api/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, format: inferred, fileName: file.name }),
      });
      const result = (await response.json()) as Partial<IngestResponse> & { error?: string };
      if (!response.ok) {
        throw new Error(result.error ?? "日志解析失败");
      }
      setIngestResult(result as IngestResponse);
      setRunState("ready");
      setNotice(`日志已标准化，共识别 ${result.ingestMeta?.rows ?? 0} 条消息，可开始评估。`);
    } catch (requestError) {
      setRunState("error");
      setError(requestError instanceof Error ? requestError.message : "上传失败");
    }
  }

  /**
   * Load the bundled SGD restaurant-booking demo dataset.
   */
  async function handleUseSampleDataset() {
    try {
      setSampleLoading(true);
      setRunState("ingesting");
      setError("");
      setNotice("");
      setEvaluateResult(null);
      setIngestResult(null);
      setRemediationPackage(null);
      setDataMappingPlan(null);
      setShowEvaluationProgress(false);
      setEvaluationStages(createInitialEvaluationStages());
      setFileName(SGD_SAMPLE_DATASET.fileName);
      setFormat("json");
      setSelectedScenarioId("");
      setScenarioOnboardingAnswers({});

      const sampleResponse = await fetch(SGD_SAMPLE_DATASET.path);
      if (!sampleResponse.ok) {
        throw new Error("示例数据加载失败");
      }
      const text = await sampleResponse.text();
      setDataMappingPlan(await requestDataMappingPlan(text, "json", SGD_SAMPLE_DATASET.fileName));
      const response = await fetch("/api/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, format: "json", fileName: SGD_SAMPLE_DATASET.fileName }),
      });
      const result = (await response.json()) as Partial<IngestResponse> & { error?: string };
      if (!response.ok) {
        throw new Error(result.error ?? "示例数据解析失败");
      }
      setIngestResult(result as IngestResponse);
      setRunState("ready");
      setNotice(`已载入示例数据：${SGD_SAMPLE_DATASET.description}，共 ${result.ingestMeta?.rows ?? 0} 条消息。`);
    } catch (requestError) {
      setRunState("error");
      setError(requestError instanceof Error ? requestError.message : "示例数据加载失败");
    } finally {
      setSampleLoading(false);
    }
  }

  async function handleFileInputChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    await handleFile(file);
  }

  function handleDragOver(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragActive(true);
  }

  async function handleDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragActive(false);
    const file = event.dataTransfer.files?.[0];
    if (!file) return;
    await handleFile(file);
  }

  /**
   * Execute the full evaluation flow through the backend API.
   */
  async function handleRunEvaluate() {
    if (!ingestResult?.rawRows.length) {
      setError("请先上传并完成日志解析。");
      setRunState("error");
      return;
    }

    setRunState("running");
    setError("");
    setNotice("");
    setProcessStep(0);
    setCurrentStep(1);
    setShowEvaluationProgress(true);
    setEvaluationStages(createInitialEvaluationStages());
    setRemediationPackage(null);

    try {
      const response = await fetch("/api/evaluate?stream=1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rawRows: ingestResult.rawRows,
          useLlm: true,
          structuredTaskMetrics: ingestResult.structuredTaskMetrics,
          scenarioId: selectedScenarioId || undefined,
          scenarioContext: selectedScenarioId
            ? {
                onboardingAnswers: pickActiveOnboardingAnswers(
                  scenarioOnboardingAnswers,
                  activeOnboardingQuestions.map((item) => item.id),
                ),
              }
            : undefined,
        }),
      });
      if (!response.ok) {
        const result = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(result.error ?? "评估执行失败");
      }
      const result = await readEvaluateStream(response, (event) => {
        setEvaluationStages((current) => applyEvaluationProgressEvent(current, event));
        setProcessStep(EVALUATION_STAGE_INDEX[event.stage]);
      });
      setEvaluateResult(result);
      setRunState("success");
      setProcessStep(PROCESSING_LOGS.length - 1);
      setNotice("评估完成，已生成图表、业务 KPI、策略与中间产物。");
      window.setTimeout(() => setShowEvaluationProgress(false), 900);
    } catch (requestError) {
      setRunState("error");
      const message = requestError instanceof Error ? requestError.message : "评估执行失败";
      setError(message);
      setEvaluationStages((current) =>
        applyEvaluationProgressEvent(current, {
          type: "stage",
          stage: "complete",
          status: "failed",
          message: "评估失败",
          detail: message,
        }),
      );
    }
  }

  function handleScenarioChange(nextScenarioId: string) {
    setSelectedScenarioId(nextScenarioId);
    const nextQuestionIds =
      SCENARIO_OPTIONS.find((item) => item.scenarioId === nextScenarioId)?.onboardingQuestions.map((item) => item.id) ??
      [];
    setScenarioOnboardingAnswers((current) => pickActiveOnboardingAnswers(current, nextQuestionIds));
  }

  function handleOnboardingAnswerChange(questionId: string, value: string) {
    setScenarioOnboardingAnswers((current) => ({ ...current, [questionId]: value }));
  }

  async function handleSaveWorkbenchBaseline() {
    if (!evaluateResult || !ingestResult?.rawRows.length) {
      setError("请先完成一次评估后再保存基线。");
      return;
    }
    setBaselineSaving(true);
    setError("");
    try {
      const response = await fetch("/api/workbench-baselines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerId: baselineCustomerId.trim(),
          label: fileName || undefined,
          sourceFileName: fileName || undefined,
          evaluate: evaluateResult,
          rawRows: ingestResult.rawRows,
        }),
      });
      const data = (await response.json()) as { error?: string; detail?: string; runId?: string };
      if (!response.ok) {
        throw new Error(data.detail ?? data.error ?? "保存基线失败");
      }
      window.localStorage.setItem(LAST_CUSTOMER_ID_KEY, baselineCustomerId.trim());
      setNotice(
        `已保存工作台基线：customerId=${baselineCustomerId.trim()}，runId=${data.runId ?? evaluateResult.runId}。可前往「在线评测」选择该基线回放。`,
      );
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "保存基线失败");
    } finally {
      setBaselineSaving(false);
    }
  }

  async function handleHarvestBadCases() {
    if (!evaluateResult?.badCaseAssets.length) {
      setError("当前没有可沉淀的 bad case。");
      return;
    }
    setBadCaseHarvesting(true);
    setError("");
    try {
      const response = await fetch("/api/eval-datasets/harvest-badcases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baselineVersion: evaluateResult.runId,
          allowNearDuplicate: true,
          evaluate: evaluateResult,
        }),
      });
      const data = (await response.json()) as {
        error?: string;
        detail?: string;
        savedCount?: number;
        skippedCount?: number;
      };
      if (!response.ok) {
        throw new Error(data.detail ?? data.error ?? "沉淀 bad case 失败");
      }
      setNotice(`已沉淀 bad case：新增 ${data.savedCount ?? 0} 条，跳过 ${data.skippedCount ?? 0} 条重复案例。`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "沉淀 bad case 失败");
    } finally {
      setBadCaseHarvesting(false);
    }
  }

  async function handleGenerateRemediationPackage() {
    if (!evaluateResult?.badCaseAssets.length) {
      setError("当前没有足够的 bad case 用于生成调优包。");
      return;
    }
    setRemediationGenerating(true);
    setError("");
    try {
      const response = await fetch("/api/remediation-packages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceFileName: fileName || undefined,
          baselineCustomerId: baselineCustomerId.trim() || undefined,
          evaluate: {
            runId: evaluateResult.runId,
            objectiveMetrics: {
              avgResponseGapSec: evaluateResult.objectiveMetrics.avgResponseGapSec,
              topicSwitchRate: evaluateResult.objectiveMetrics.topicSwitchRate,
              userQuestionRepeatRate: evaluateResult.objectiveMetrics.userQuestionRepeatRate,
              agentResolutionSignalRate: evaluateResult.objectiveMetrics.agentResolutionSignalRate,
              escalationKeywordHitRate: evaluateResult.objectiveMetrics.escalationKeywordHitRate,
            },
            subjectiveMetrics: {
              dimensions: evaluateResult.subjectiveMetrics.dimensions,
              signals: evaluateResult.subjectiveMetrics.signals,
              goalCompletions: evaluateResult.subjectiveMetrics.goalCompletions,
              recoveryTraces: evaluateResult.subjectiveMetrics.recoveryTraces,
            },
            scenarioEvaluation: evaluateResult.scenarioEvaluation,
            badCaseAssets: evaluateResult.badCaseAssets,
            suggestions: evaluateResult.suggestions,
          },
        }),
      });
      const data = (await response.json()) as {
        error?: string;
        detail?: string;
        package?: RemediationPackageSnapshot;
      };
      if (!response.ok || !data.package) {
        throw new Error(data.detail ?? data.error ?? "生成调优包失败");
      }
      setRemediationPackage(data.package);
      setNotice(`已生成调优包 ${data.package.packageId}，可直接复制文件内容交给 Claude Code / Codex。`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "生成调优包失败");
    } finally {
      setRemediationGenerating(false);
    }
  }

  function goToStep(index: number) {
    if (index < 0 || index >= STEPS.length) return;
    if (index > completedStep + 1) return;
    setCurrentStep(index);
    if (typeof window !== "undefined") {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  const heroStats = [
    {
      key: "messages",
      label: "消息量",
      value: ingestResult ? `${ingestResult.ingestMeta.rows}` : "--",
      hint: fileName ? "已完成标准化" : "等待原始日志上传",
    },
    {
      key: "sessions",
      label: "会话数",
      value: evaluateResult
        ? `${evaluateResult.meta.sessions}`
        : ingestResult
          ? `${ingestResult.ingestMeta.sessions}`
          : "--",
      hint: "按 session 聚合的评估对象",
    },
    {
      key: "badcases",
      label: "Bad Case",
      value: `${evaluateResult?.badCaseAssets.length ?? 0}`,
      hint: "已抽出的失败案例",
    },
    {
      key: "warnings",
      label: "降级提示",
      value: `${warnings.length}`,
      hint: warnings.length ? "包含降级说明" : "无降级告警",
    },
  ];

  return (
    <AppShell
      subheader={
        <Stepper
          steps={STEPS}
          current={currentStep}
          completed={completedStep}
          onSelect={goToStep}
        />
      }
    >
      <div className={styles.page}>
        <main className={styles.main}>
          <section className={styles.hero}>
            <div className={styles.heroContent}>
              <p className={styles.badge}>Zeval · 工作台</p>
              <h1 className={styles.heroTitle}>{getStepHeroTitle(currentStep)}</h1>
              <p className={styles.heroCopy}>{getStepHeroCopy(currentStep)}</p>
              <div className={styles.heroTagRow}>
                <div className={styles.heroTagsLeft}>
                  <span className={styles.heroTag}>状态 · {runStateLabel}</span>
                  <span className={styles.heroTag}>场景 · {selectedScenarioLabel}</span>
                  <span className={styles.heroTag}>文件 · {fileName ? fileName : "等待上传"}</span>
                </div>
              </div>
            </div>
            <div className={styles.heroAside}>
              <div className={styles.heroMetaGrid}>
                {heroStats.map((item) => (
                  <div className={styles.heroMetaCard} key={item.key}>
                    <span>{item.label}</span>
                    <strong>{item.value}</strong>
                    <small>{item.hint}</small>
                  </div>
                ))}
              </div>
            </div>
          </section>

          {error ? <p className={styles.error}>{error}</p> : null}
          {notice ? <p className={styles.notice}>{notice}</p> : null}

          {currentStep === 0 ? (
            <StepUpload
              dragActive={dragActive}
              runState={runState}
              fileName={fileName}
              format={format}
              fileInputRef={fileInputRef}
              ingestResult={ingestResult}
              dataMappingPlan={dataMappingPlan}
              previewHeader={previewHeader}
              previewRows={previewRows}
              selectedScenarioId={selectedScenarioId}
              selectedScenarioLabel={selectedScenarioLabel}
              activeOnboardingQuestions={activeOnboardingQuestions}
              scenarioEvaluationMetrics={selectedScenarioOption?.evaluationMetrics ?? []}
              scenarioSyntheticCaseSeeds={selectedScenarioOption?.syntheticCaseSeeds ?? []}
              answeredOnboardingCount={answeredOnboardingCount}
              scenarioOnboardingAnswers={scenarioOnboardingAnswers}
              canRunEvaluate={canRunEvaluate}
              onDragOver={handleDragOver}
              onDragLeave={() => setDragActive(false)}
              onDrop={handleDrop}
              onFileInputChange={handleFileInputChange}
              onRunEvaluate={handleRunEvaluate}
              onUseSampleDataset={handleUseSampleDataset}
              onScenarioChange={handleScenarioChange}
              onOnboardingAnswerChange={handleOnboardingAnswerChange}
              onAdvance={() => goToStep(1)}
              canAdvance={Boolean(evaluateResult)}
              sampleLoading={sampleLoading}
            />
          ) : null}

          {currentStep === 1 ? (
            <StepEvaluate
              runState={runState}
              processStep={processStep}
              evaluationStages={evaluationStages}
              showEvaluationProgress={showEvaluationProgress || runState === "error"}
              warnings={warnings}
              summaryCards={summaryCards}
              evaluateResult={evaluateResult}
              activeTab={resultTab}
              onTabChange={setResultTab}
              onRunEvaluate={handleRunEvaluate}
              canRunEvaluate={canRunEvaluate}
              onBack={() => goToStep(0)}
              onAdvance={() => goToStep(2)}
              canAdvance={Boolean(evaluateResult)}
              selectedScenarioLabel={selectedScenarioLabel}
            />
          ) : null}

          {currentStep === 2 ? (
            <StepPackage
              remediationPackage={remediationPackage}
              remediationGenerating={remediationGenerating}
              evaluateResult={evaluateResult}
              badCaseHarvesting={badCaseHarvesting}
              onGenerate={() => void handleGenerateRemediationPackage()}
              onHarvest={() => void handleHarvestBadCases()}
              onBack={() => goToStep(1)}
              onAdvance={() => goToStep(3)}
              canAdvance={Boolean(remediationPackage)}
            />
          ) : null}

          {currentStep === 3 ? (
            <StepValidate
              evaluateResult={evaluateResult}
              baselineCustomerId={baselineCustomerId}
              onBaselineCustomerIdChange={setBaselineCustomerId}
              baselineSaving={baselineSaving}
              onSaveBaseline={() => void handleSaveWorkbenchBaseline()}
              onBack={() => goToStep(2)}
            />
          ) : null}
        </main>
      </div>
    </AppShell>
  );
}

/* ---------------- Step 1: Upload ---------------- */

type StepUploadProps = {
  dragActive: boolean;
  runState: EvalConsoleRunState;
  fileName: string;
  format: UploadFormat;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  ingestResult: IngestResponse | null;
  dataMappingPlan: DataMappingPlan | null;
  previewHeader: string[];
  previewRows: string[][];
  selectedScenarioId: string;
  selectedScenarioLabel: string;
  activeOnboardingQuestions: { id: string; question: string }[];
  scenarioEvaluationMetrics: ScenarioEvaluationMetric[];
  scenarioSyntheticCaseSeeds: ScenarioSyntheticCaseSeed[];
  answeredOnboardingCount: number;
  scenarioOnboardingAnswers: Record<string, string>;
  canRunEvaluate: boolean;
  onDragOver: (event: DragEvent<HTMLLabelElement>) => void;
  onDragLeave: () => void;
  onDrop: (event: DragEvent<HTMLLabelElement>) => Promise<void>;
  onFileInputChange: (event: ChangeEvent<HTMLInputElement>) => Promise<void>;
  onRunEvaluate: () => Promise<void>;
  onUseSampleDataset: () => Promise<void>;
  onScenarioChange: (scenarioId: string) => void;
  onOnboardingAnswerChange: (questionId: string, value: string) => void;
  onAdvance: () => void;
  canAdvance: boolean;
  sampleLoading: boolean;
};

function StepUpload(props: StepUploadProps) {
  return (
    <>
      <section className={styles.stepIntro}>
        <h2>上传一段对话日志</h2>
        <p>支持 CSV / JSON / JSONL / TXT / MD，单文件 ≤ 5MB。文件会先经过 Data Onboarding Agent 做结构识别与能力检查。</p>
        <div className={styles.howTo}>
          <span className={styles.howToTitle}>怎么用</span>
          <span>① 把对话日志拖到左侧上传区，或点击选择文件。</span>
          <span>② 选一个业务场景（可选），让评估出 KPI 报告而不只是通用指标。</span>
          <span>③ 解析完成后，点击上传区右侧「开始评估」，完成后进入结果页。</span>
        </div>
      </section>

      <section className={`${styles.panel} ${styles.panelFull}`}>
        <div className={styles.panelHeader}>
          <div>
            <h2>日志接入</h2>
            <p>拖拽或选择文件，自动识别格式并解析为统一 raw 结构。</p>
          </div>
          <span className={styles.panelMeta}>RAW INGEST</span>
        </div>
        <div className={styles.intakeStack}>
          <div className={styles.sampleDatasetCard}>
            <div>
              <span className={styles.sampleDatasetEyebrow}>内置示例</span>
              <strong>{SGD_SAMPLE_DATASET.title}</strong>
              <p>{SGD_SAMPLE_DATASET.description}</p>
            </div>
            <div className={styles.sampleDatasetActions}>
              <button
                type="button"
                className={styles.secondaryButton}
                disabled={props.sampleLoading || props.runState === "running" || props.runState === "ingesting"}
                onClick={() => void props.onUseSampleDataset()}
              >
                {props.sampleLoading ? "载入中…" : "使用示例数据"}
              </button>
              <a
                className={styles.downloadLinkButton}
                href={SGD_SAMPLE_DATASET.path}
                download={SGD_SAMPLE_DATASET.fileName}
              >
                下载 JSON
              </a>
            </div>
          </div>
          <UploadDropzone
            dragActive={props.dragActive}
            uploading={props.runState === "ingesting"}
            fileName={props.fileName}
            maxUploadSizeMb={MAX_UPLOAD_SIZE_MB}
            canRunEvaluate={props.canRunEvaluate}
            fileInputRef={props.fileInputRef}
            onDragOver={props.onDragOver}
            onDragLeave={props.onDragLeave}
            onDrop={props.onDrop}
            onFileInputChange={props.onFileInputChange}
            onRunEvaluate={props.onRunEvaluate}
            processing={props.runState === "running"}
          />
          <div className={styles.metaRow}>
            <span>{props.fileName ? `已上传：${props.fileName}` : "尚未上传文件"}</span>
            <span>
              {props.ingestResult ? `${props.ingestResult.ingestMeta.rows} 条消息` : "等待日志接入"}
            </span>
          </div>
          {props.dataMappingPlan ? <DataMappingPlanPanel plan={props.dataMappingPlan} /> : null}
          <div className={styles.controlRow}>
            <label className={styles.controlLabel}>
              业务场景
              <select
                className={styles.controlSelect}
                value={props.selectedScenarioId}
                onChange={(event) => props.onScenarioChange(event.target.value)}
              >
                <option value="">通用评估（不映射 KPI）</option>
                {SCENARIO_OPTIONS.map((item) => (
                  <option key={item.scenarioId} value={item.scenarioId}>
                    {item.displayName}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {props.selectedScenarioId ? (
            <ScenarioSkillPlanPanel
              metrics={props.scenarioEvaluationMetrics}
              syntheticCaseSeeds={props.scenarioSyntheticCaseSeeds}
            />
          ) : null}
          {props.activeOnboardingQuestions.length > 0 ? (
            <div className={styles.onboardingBox}>
              <div className={styles.onboardingHeader}>
                <div>
                  <strong>场景 Onboarding</strong>
                  <span>
                    {props.answeredOnboardingCount}/{props.activeOnboardingQuestions.length} 已填写
                  </span>
                </div>
                <span>{props.selectedScenarioLabel}</span>
              </div>
              <div className={styles.onboardingGrid}>
                {props.activeOnboardingQuestions.map((item) => (
                  <label className={styles.onboardingField} key={item.id}>
                    <span>{item.question}</span>
                    <input
                      value={props.scenarioOnboardingAnswers[item.id] ?? ""}
                      onChange={(event) => props.onOnboardingAnswerChange(item.id, event.target.value)}
                      placeholder="填写该客户或数据集的实际情况"
                    />
                  </label>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </section>

      {props.previewRows.length > 0 ? (
        <section className={`${styles.panel} ${styles.panelFull}`}>
          <div className={styles.panelHeader}>
            <div>
              <h2>日志预览</h2>
              <p>前 20 行，确认字段映射是否正确。</p>
            </div>
            <span className={styles.panelMeta}>{props.previewRows.length} 行</span>
          </div>
          <PreviewTable header={props.previewHeader} rows={props.previewRows} />
        </section>
      ) : null}

      <div className={styles.stepNav}>
        <span className={styles.stepHint}>
          {props.ingestResult ? "日志已就绪。" : "上传一份日志开始。"}
        </span>
        <div className={styles.stepNavRight}>
          <button
            type="button"
            className={styles.primaryOutlineButton}
            disabled={!props.canAdvance}
            onClick={props.onAdvance}
          >
            下一步：查看结果 →
          </button>
        </div>
      </div>
    </>
  );
}

function DataMappingPlanPanel(props: { plan: DataMappingPlan }) {
  const enabled = props.plan.capabilityReport.enabledMetricGroups;
  const disabled = props.plan.capabilityReport.disabledMetricGroups.slice(0, 4);
  const mappings = props.plan.fieldMappings.slice(0, 8);
  return (
    <div className={styles.mappingBox}>
      <div className={styles.mappingHeader}>
        <div>
          <strong>Data Onboarding Agent</strong>
          <span>
            识别为 {formatSourceFormat(props.plan.sourceFormat)} · 置信度 {Math.round(props.plan.confidence * 100)}%
          </span>
        </div>
        <span className={styles.mappingAgentStatus}>{formatAgentStatus(props.plan.agentReview.status)}</span>
      </div>
      <p className={styles.mappingSummary}>{props.plan.agentReview.summary}</p>
      <div className={styles.capabilityGrid}>
        {enabled.map((item) => (
          <span className={`${styles.capabilityPill} ${styles.capabilityEnabled}`} key={item}>
            可用 · {formatCapability(item)}
          </span>
        ))}
        {disabled.map((item) => (
          <span className={`${styles.capabilityPill} ${styles.capabilityDisabled}`} key={item.group}>
            降级 · {formatCapability(item.group)}
          </span>
        ))}
      </div>
      <div className={styles.mappingList}>
        {mappings.map((item) => (
          <div className={styles.mappingRow} key={`${item.target}_${item.path}`}>
            <span>{item.target}</span>
            <code>{item.path}</code>
          </div>
        ))}
      </div>
      {props.plan.warnings.length > 0 ? (
        <div className={styles.mappingWarnings}>
          {props.plan.warnings.slice(0, 3).map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
      ) : null}
      {props.plan.questionsForUser.length > 0 ? (
        <div className={styles.mappingQuestions}>
          {props.plan.questionsForUser.slice(0, 2).map((item) => (
            <span key={item}>待确认：{item}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Render scenario skill metric templates before evaluation.
 * @param props Scenario metric and synthetic seed props.
 * @returns Scenario skill plan panel.
 */
function ScenarioSkillPlanPanel(props: {
  metrics: ScenarioEvaluationMetric[];
  syntheticCaseSeeds: ScenarioSyntheticCaseSeed[];
}) {
  return (
    <div className={styles.mappingBox}>
      <div className={styles.mappingHeader}>
        <div>
          <strong>Scenario Skill Plan</strong>
          <span>
            {props.metrics.length} 个指标模板 · {props.syntheticCaseSeeds.length} 个 synthetic case seed
          </span>
        </div>
        <span className={styles.mappingAgentStatus}>SKILL</span>
      </div>
      <div className={styles.capabilityGrid}>
        {props.metrics.map((metric) => (
          <span className={`${styles.capabilityPill} ${styles.capabilityEnabled}`} key={metric.id}>
            {metric.kind} · {metric.displayName}
          </span>
        ))}
      </div>
      <div className={styles.mappingList}>
        {props.metrics.slice(0, 4).map((metric) => (
          <div className={styles.mappingRow} key={metric.id}>
            <span>{metric.displayName}</span>
            <code>{metric.requiredFields.length ? metric.requiredFields.join(" + ") : "no required fields"} · {formatRate(metric.threshold)}</code>
          </div>
        ))}
      </div>
      {props.syntheticCaseSeeds.length > 0 ? (
        <div className={styles.mappingWarnings}>
          {props.syntheticCaseSeeds.slice(0, 3).map((seed) => (
            <span key={seed.id}>Synthetic：{seed.situation}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function formatSourceFormat(value: DataMappingPlan["sourceFormat"]): string {
  const labels: Record<DataMappingPlan["sourceFormat"], string> = {
    sgd: "SGD 标注对话",
    assetops: "AssetOpsBench 任务集",
    "plain-chatlog": "普通 Chatlog",
    "custom-json": "自定义 JSON",
    "custom-jsonl": "自定义 JSONL",
    "custom-csv": "自定义 CSV",
    "plain-text": "纯文本日志",
    unknown: "未知格式",
  };
  return labels[value];
}

function formatAgentStatus(value: DataMappingPlan["agentReview"]["status"]): string {
  if (value === "completed") return "LLM 已复核";
  if (value === "degraded") return "规则识别";
  return "规则识别";
}

function formatCapability(value: string): string {
  const labels: Record<string, string> = {
    basic_chat_eval: "基础对话",
    schema_aware_eval: "Schema",
    slot_eval: "Slot",
    state_tracking_eval: "State",
    service_call_eval: "Service Call",
    service_result_grounding: "Result Grounding",
    actual_tool_trace_eval: "Tool Trace",
    retrieval_eval: "Retrieval / Expected Output",
  };
  return labels[value] ?? value;
}

/**
 * Format structured benchmark source labels for the result panel.
 * @param value Structured metric source format.
 * @returns Human-readable source label.
 */
function formatStructuredSource(value: StructuredTaskMetrics["sourceFormat"]): string {
  const labels: Record<StructuredTaskMetrics["sourceFormat"], string> = {
    sgd: "SGD",
    assetops: "AssetOps",
    custom: "Custom",
  };
  return labels[value];
}

/**
 * Format structured metric availability status.
 * @param value Structured metric status.
 * @returns Human-readable status label.
 */
function formatStructuredStatus(value: StructuredTaskMetrics["status"]): string {
  if (value === "ready") return "已启用";
  if (value === "degraded") return "部分降级";
  return "不可用";
}

/**
 * Format a 0-1 metric as a whole-percent string.
 * @param value Rate in the 0-1 range.
 * @returns Percent string.
 */
function formatRate(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/**
 * Format metric gate status.
 * @param value Gate status.
 * @returns Human-readable label.
 */
function formatGateStatus(value: EvalMetricRegistrySnapshot["gateStatus"]): string {
  if (value === "passed") return "通过";
  if (value === "failed") return "失败";
  return "预警";
}

/**
 * Format metric result status.
 * @param value Metric status.
 * @returns Human-readable label.
 */
function formatMetricStatus(value: EvalMetricResult["status"]): string {
  const labels: Record<EvalMetricResult["status"], string> = {
    ready: "可评分",
    degraded: "降级",
    skipped: "跳过",
    error: "错误",
  };
  return labels[value];
}

/**
 * Format metric category names.
 * @param value Metric category.
 * @returns Display label.
 */
function formatMetricCategory(value: string): string {
  const labels: Record<string, string> = {
    objective: "客观规则指标",
    subjective: "LLM Judge 指标",
    structured: "结构化链路指标",
    trace: "Agent Trace 指标",
    business: "业务 KPI Gate",
    synthetic: "合成用例覆盖",
  };
  return labels[value] ?? value;
}

/**
 * Pick a CSS class for a metric status.
 * @param value Metric status.
 * @returns CSS module class name.
 */
function getMetricStatusClass(value: EvalMetricResult["status"]): string {
  if (value === "ready") return styles.metricStatusReady;
  if (value === "degraded") return styles.metricStatusDegraded;
  if (value === "error") return styles.metricStatusError;
  return styles.metricStatusSkipped;
}

/**
 * Format canonical required field labels.
 * @param value Required field identifier.
 * @returns Human-readable field label.
 */
function formatRequiredField(value: string): string {
  const labels: Record<string, string> = {
    turns: "Turns",
    expected_output: "Expected Output",
    retrieval_context: "Retrieval Context",
    tools_called: "Tools Called",
    expected_tools: "Expected Tools",
    trace: "Trace",
    frames: "Frames",
    slots: "Slots",
    state: "State",
    service_call: "Service Call",
    service_results: "Service Results",
    schema: "Schema",
  };
  return labels[value] ?? value;
}

/* ---------------- Step 2: Evaluate ---------------- */

type StepEvaluateProps = {
  runState: EvalConsoleRunState;
  processStep: number;
  evaluationStages: Record<EvaluationStageKey, EvaluationStageState>;
  showEvaluationProgress: boolean;
  warnings: string[];
  summaryCards: SummaryCard[];
  evaluateResult: EvaluateResponse | null;
  activeTab: ResultTabKey;
  onTabChange: (tab: ResultTabKey) => void;
  onRunEvaluate: () => Promise<void>;
  canRunEvaluate: boolean;
  onBack: () => void;
  onAdvance: () => void;
  canAdvance: boolean;
  selectedScenarioLabel: string;
};

function StepEvaluate(props: StepEvaluateProps) {
  const tabs: { key: ResultTabKey; label: string; count?: number }[] = [
    { key: "summary", label: "核心指标" },
    { key: "metric", label: "指标矩阵", count: props.evaluateResult?.metricRegistry?.results.length ?? 0 },
    { key: "badcase", label: "Bad Case", count: props.evaluateResult?.badCaseAssets.length ?? 0 },
    { key: "goal", label: "目标达成", count: props.evaluateResult?.subjectiveMetrics.goalCompletions.length ?? 0 },
    {
      key: "recovery",
      label: "恢复轨迹",
      count:
        props.evaluateResult?.subjectiveMetrics.recoveryTraces.filter((item) => item.status !== "none").length ?? 0,
    },
    { key: "kpi", label: "业务 KPI" },
    { key: "suggestion", label: "策略建议", count: props.evaluateResult?.suggestions.length ?? 0 },
  ];

  return (
    <>
      <section className={styles.stepIntro}>
        <h2>评估结果</h2>
        <p>系统已跑完客观指标、主观判定、bad case 抽取、KPI 映射与策略建议。先看核心指标，再切换 tab 看证据。</p>
        <div className={styles.howTo}>
          <span className={styles.howToTitle}>怎么用</span>
          <span>① 默认 tab 是「核心指标」+ 图表，把握整体水位。</span>
          <span>② 切到「Bad Case」逐条看证据；切到「目标达成 / 恢复轨迹」看 session 级表现。</span>
          <span>③ 看完确认有问题需要修复，进入下一步生成调优包。</span>
        </div>
      </section>

      <section className={`${styles.panel} ${styles.panelFull}`}>
        <div className={styles.panelHeader}>
          <div>
            <h2>执行状态</h2>
            <p>当前链路进度、warning 与降级说明。</p>
          </div>
          <span className={styles.panelMeta}>{getRunStateLabel(props.runState)}</span>
        </div>
        <StatusPanel
          processing={props.runState === "running"}
          processStep={props.processStep}
          logs={PROCESSING_LOGS}
          warnings={props.warnings}
        />
        <EvaluationProgress visible={props.showEvaluationProgress} stages={props.evaluationStages} />
      </section>

      {props.evaluateResult ? (
        <>
          <div className={styles.tabs}>
            {tabs.map((tab) => (
              <button
                key={tab.key}
                type="button"
                className={`${styles.tab} ${props.activeTab === tab.key ? styles.tabActive : ""}`}
                onClick={() => props.onTabChange(tab.key)}
              >
                {tab.label}
                {tab.count !== undefined ? <span className={styles.tabBadge}>{tab.count}</span> : null}
              </button>
            ))}
          </div>

          {props.activeTab === "summary" ? (
            <>
              <section className={`${styles.panel} ${styles.panelFull}`}>
                <div className={styles.panelHeader}>
                  <div>
                    <h2>核心指标</h2>
                    <p>会话规模、响应间隔、共情、目标达成、bad case 数 一屏看完。</p>
                  </div>
                  <span className={styles.panelMeta}>SUMMARY</span>
                </div>
                <SummaryGrid cards={props.summaryCards} />
              </section>
              <StructuredTaskMetricsPanel metrics={props.evaluateResult.structuredTaskMetrics} />
              <section className={`${styles.panel} ${styles.panelFull}`}>
                <div className={styles.panelHeader}>
                  <div>
                    <h2>扩展指标（DeepEval 对齐）</h2>
                    <p>10 项 RAG / Agentic / MultiTurn / Safety / RolePlay 指标。提供 extendedInputs 即可解锁。</p>
                  </div>
                  <span className={styles.panelMeta}>EXTENDED</span>
                </div>
                <ExtendedMetricsPanel metrics={props.evaluateResult.extendedMetrics} />
              </section>
              <section className={`${styles.panel} ${styles.panelFull}`}>
                <div className={styles.panelHeader}>
                  <div>
                    <h2>分析图谱</h2>
                    <p>核心情绪、断点、活跃时段与 topic 连贯度。</p>
                  </div>
                  <span className={styles.panelMeta}>{props.evaluateResult.charts.length} 张</span>
                </div>
                <ChartsPanel charts={props.evaluateResult.charts} />
              </section>
            </>
          ) : null}

          {props.activeTab === "metric" ? (
            <section className={`${styles.panel} ${styles.panelFull}`}>
              <div className={styles.panelHeader}>
                <div>
                  <h2>指标矩阵</h2>
                  <p>统一展示 rule / G-Eval / DAG / structured / trace 指标的状态、阈值、证据与降级原因。</p>
                </div>
                <span className={styles.panelMeta}>{props.evaluateResult.metricRegistry?.gateStatus ?? "METRICS"}</span>
              </div>
              <EvalCaseBundlePanel bundle={props.evaluateResult.evalCaseBundle} />
              <MetricRegistryPanel registry={props.evaluateResult.metricRegistry} />
            </section>
          ) : null}

          {props.activeTab === "badcase" ? (
            <section className={`${styles.panel} ${styles.panelFull}`}>
              <div className={styles.panelHeader}>
                <div>
                  <h2>Bad Case</h2>
                  <p>每条失败 session 都附带 evidence、tag 与建议动作。</p>
                </div>
                <span className={styles.panelMeta}>{props.evaluateResult.badCaseAssets.length} 条</span>
              </div>
              <BadCasePanel items={props.evaluateResult.badCaseAssets} />
            </section>
          ) : null}

          {props.activeTab === "goal" ? (
            <section className={`${styles.panel} ${styles.panelFull}`}>
              <div className={styles.panelHeader}>
                <div>
                  <h2>目标达成</h2>
                  <p>按 session 判断用户初始意图是否达成，附达成证据与未达成原因。</p>
                </div>
                <span className={styles.panelMeta}>
                  {props.evaluateResult.subjectiveMetrics.goalCompletions.length} 条
                </span>
              </div>
              <GoalCompletionPanel items={props.evaluateResult.subjectiveMetrics.goalCompletions} />
            </section>
          ) : null}

          {props.activeTab === "recovery" ? (
            <section className={`${styles.panel} ${styles.panelFull}`}>
              <div className={styles.panelHeader}>
                <div>
                  <h2>恢复轨迹</h2>
                  <p>识别失败后是否被及时修复，并沉淀可复用的恢复策略。</p>
                </div>
                <span className={styles.panelMeta}>
                  {
                    props.evaluateResult.subjectiveMetrics.recoveryTraces.filter((item) => item.status !== "none")
                      .length
                  } 条
                </span>
              </div>
              <RecoveryTracePanel items={props.evaluateResult.subjectiveMetrics.recoveryTraces} />
            </section>
          ) : null}

          {props.activeTab === "kpi" ? (
            <section className={`${styles.panel} ${styles.panelFull}`}>
              <div className={styles.panelHeader}>
                <div>
                  <h2>业务 KPI 映射</h2>
                  <p>把通用评估指标翻译成业务可读的 KPI 分与证据。</p>
                </div>
                <span className={styles.panelMeta}>
                  {props.evaluateResult.scenarioEvaluation?.displayName ?? props.selectedScenarioLabel}
                </span>
              </div>
              <ScenarioKpiPanel evaluation={props.evaluateResult.scenarioEvaluation ?? null} />
            </section>
          ) : null}

          {props.activeTab === "suggestion" ? (
            <section className={`${styles.panel} ${styles.panelFull}`}>
              <div className={styles.panelHeader}>
                <div>
                  <h2>策略建议</h2>
                  <p>按优先级输出下一轮 prompt、交互流程与模型策略调整建议。</p>
                </div>
                <span className={styles.panelMeta}>ACTIONABLE</span>
              </div>
              <SuggestionPanel suggestions={props.evaluateResult.suggestions} />
            </section>
          ) : null}
        </>
      ) : (
        <section className={`${styles.panel} ${styles.panelFull}`}>
          <p className={styles.emptyState}>还没有评估结果。点击下面的按钮运行评估。</p>
          <div className={styles.stepNav} style={{ marginTop: 16 }}>
            <button
              type="button"
              className={styles.processButton}
              disabled={!props.canRunEvaluate}
              onClick={() => void props.onRunEvaluate()}
              style={{ width: "auto", minWidth: 200 }}
            >
              <span className={styles.processButtonText}>
                <strong>{props.runState === "running" ? "评估进行中…" : "运行评估"}</strong>
                <small>跑完后这里会出现完整结果</small>
              </span>
            </button>
          </div>
        </section>
      )}

      <div className={styles.stepNav}>
        <button type="button" className={styles.primaryOutlineButton} onClick={props.onBack}>
          ← 上一步
        </button>
        <div className={styles.stepNavRight}>
          <span className={styles.stepHint}>
            {props.canAdvance ? "确认结果，下一步生成调优包。" : "请先完成一次评估。"}
          </span>
          <button
            type="button"
            className={styles.primaryOutlineButton}
            disabled={!props.canAdvance}
            onClick={props.onAdvance}
            style={{ background: props.canAdvance ? "#0b0b0b" : undefined, color: props.canAdvance ? "#fff" : undefined }}
          >
            下一步：生成调优包 →
          </button>
        </div>
      </div>
    </>
  );
}

/**
 * Render schema-aware annotation coverage and grounding metrics when available.
 * @param props Panel props with optional structured metrics.
 * @returns A result panel or null when no structured metrics exist.
 */
function StructuredTaskMetricsPanel(props: { metrics?: StructuredTaskMetrics }) {
  if (!props.metrics) {
    return null;
  }
  const metrics = props.metrics;
  const countItems: Array<[string, number]> = [
    ["Cases", metrics.caseCount],
    ["Services", metrics.serviceCount],
    ["Frames", metrics.frameCount],
    ["Actions", metrics.actionCount],
    ["Slots", metrics.slotMentionCount],
    ["States", metrics.dialogueStateCount],
    ["Service calls", metrics.serviceCallCount],
    ["Service results", metrics.serviceResultCount],
  ];
  if (metrics.schemaServiceCount) {
    countItems.push(
      ["Schema services", metrics.schemaServiceCount],
      ["Schema intents", metrics.schemaIntentCount ?? 0],
      ["Schema slots", metrics.schemaSlotCount ?? 0],
    );
  }
  const rateItems: Array<[string, number, string]> = [
    ["Intent 覆盖率", metrics.intentCoverageRate, "state.active_intent 是否被稳定标注"],
    ["State Slot 覆盖率", metrics.stateSlotCoverageRate, "state.slot_values 是否承载已知约束"],
    ["调用参数追溯率", metrics.serviceCallGroundingRate, "service_call.parameters 是否能追溯到此前 state"],
    ["结果返回覆盖率", metrics.serviceResultAvailabilityRate, "service_call 是否有同 turn/service 的 service_results"],
    ["交易确认率", metrics.transactionalConfirmationRate, "预订/购买/转账类调用前是否出现确认行为"],
  ];
  if (metrics.schemaServiceCount) {
    rateItems.push(
      ["Schema Service 覆盖率", metrics.schemaServiceCoverageRate ?? 0, "dialogue.services 是否能在 schema 中找到定义"],
      ["Schema Intent 合法率", metrics.schemaIntentCoverageRate ?? 0, "active_intent 是否属于对应 service schema"],
      ["Schema Slot 合法率", metrics.schemaSlotCoverageRate ?? 0, "slot/state/call 参数是否属于对应 service schema"],
    );
  }

  return (
    <section className={`${styles.panel} ${styles.panelFull}`}>
      <div className={styles.panelHeader}>
        <div>
          <h2>结构化链路评估</h2>
          <p>当数据包含 frames / slots / state / service_call / service_results 时，系统会启用这些可验证指标。</p>
        </div>
        <span className={styles.panelMeta}>{formatStructuredSource(metrics.sourceFormat)}</span>
      </div>
      <div className={styles.mappingBox}>
        <div className={styles.mappingHeader}>
          <div>
            <strong>Annotation Coverage</strong>
            <span>用于判断这份数据能不能跑 schema-aware、slot、state tracking 与 tool grounding 评估。</span>
          </div>
          <span className={styles.mappingAgentStatus}>{formatStructuredStatus(metrics.status)}</span>
        </div>
        <div className={styles.capabilityGrid}>
          {countItems.map(([label, value]) => (
            <span className={`${styles.capabilityPill} ${styles.capabilityEnabled}`} key={label}>
              {label} · {value}
            </span>
          ))}
        </div>
        <div className={styles.mappingList}>
          {rateItems.map(([label, value, note]) => (
            <div className={styles.mappingRow} key={label}>
              <span>{label}</span>
              <code>{formatRate(Number(value))} · {note}</code>
            </div>
          ))}
        </div>
        {metrics.warnings.length > 0 ? (
          <div className={styles.mappingWarnings}>
            {metrics.warnings.map((item) => (
              <span key={item}>{item}</span>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}

/**
 * Render internal evaluation cases and capability alignment.
 * @param props Panel props with optional case bundle.
 * @returns Case bundle diagnostic panel.
 */
function EvalCaseBundlePanel(props: { bundle?: EvalCaseBundle }) {
  if (!props.bundle) {
    return <p className={styles.emptyState}>本次结果还没有生成 EvalCase Bundle。</p>;
  }
  const capabilityReport = props.bundle.capabilityReport;
  const availableFields = Object.entries(capabilityReport.availableFields).filter(([, available]) => available);
  const missingFields = capabilityReport.missingFields.slice(0, 8);
  const sampleCase = props.bundle.cases[0];
  return (
    <div className={styles.mappingBox}>
      <div className={styles.mappingHeader}>
        <div>
          <strong>EvalCase Bundle</strong>
          <span>
            {props.bundle.caseCount} 个 session case · {capabilityReport.enabledMetricGroups.length} 个可启用指标组
          </span>
        </div>
        <span className={styles.mappingAgentStatus}>TESTCASE</span>
      </div>
      {sampleCase ? (
        <p className={styles.mappingSummary}>
          示例 case：{sampleCase.sessionId} · {sampleCase.metadata.messageCount} turns · input &quot;{truncateText(sampleCase.input, 48)}&quot;
        </p>
      ) : null}
      <div className={styles.capabilityGrid}>
        {availableFields.map(([field]) => (
          <span className={`${styles.capabilityPill} ${styles.capabilityEnabled}`} key={field}>
            可用 · {formatRequiredField(field)}
          </span>
        ))}
        {missingFields.map((field) => (
          <span className={`${styles.capabilityPill} ${styles.capabilityDisabled}`} key={field}>
            缺失 · {formatRequiredField(field)}
          </span>
        ))}
      </div>
      {capabilityReport.disabledMetricGroups.length > 0 ? (
        <div className={styles.mappingList}>
          {capabilityReport.disabledMetricGroups.slice(0, 4).map((item) => (
            <div className={styles.mappingRow} key={item.group}>
              <span>{formatCapability(item.group)}</span>
              <code>{item.missingFields.map(formatRequiredField).join(" + ")}</code>
            </div>
          ))}
        </div>
      ) : null}
      {capabilityReport.warnings.length > 0 ? (
        <div className={styles.mappingWarnings}>
          {capabilityReport.warnings.slice(0, 3).map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Render unified metric registry results and gate reasons.
 * @param props Panel props with optional metric registry.
 * @returns Metric registry content.
 */
function MetricRegistryPanel(props: { registry?: EvalMetricRegistrySnapshot }) {
  if (!props.registry) {
    return <p className={styles.emptyState}>本次结果还没有生成统一指标矩阵。</p>;
  }
  const registry = props.registry;
  const grouped = groupMetricResults(registry.results);
  return (
    <div className={styles.metricRegistryStack}>
      <div className={styles.metricRegistrySummary}>
        <div>
          <span>Gate</span>
          <strong>{formatGateStatus(registry.gateStatus)}</strong>
          <small>通过率 {formatRate(registry.passRate)}</small>
        </div>
        <div>
          <span>Ready</span>
          <strong>{registry.readyCount}</strong>
          <small>可直接评分</small>
        </div>
        <div>
          <span>Degraded</span>
          <strong>{registry.degradedCount}</strong>
          <small>降级评分</small>
        </div>
        <div>
          <span>Skipped</span>
          <strong>{registry.skippedCount}</strong>
          <small>字段不足</small>
        </div>
      </div>
      {registry.gateReasons.length > 0 ? (
        <div className={styles.mappingWarnings}>
          {registry.gateReasons.map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
      ) : null}
      {Object.entries(grouped).map(([category, items]) => (
        <div className={styles.metricGroup} key={category}>
          <div className={styles.metricGroupHeader}>
            <strong>{formatMetricCategory(category)}</strong>
            <span>{items.length} 个指标</span>
          </div>
          <div className={styles.metricResultGrid}>
            {items.map((item) => (
              <MetricResultCard item={item} key={item.id} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Render one normalized metric result card.
 * @param props Card props.
 * @returns Metric card.
 */
function MetricResultCard(props: { item: EvalMetricResult }) {
  const item = props.item;
  return (
    <article className={styles.metricResultCard}>
      <div className={styles.metricResultTopline}>
        <div>
          <strong>{item.displayName}</strong>
          <span>{item.kind} · {item.scope} · threshold {formatRate(item.threshold)}</span>
        </div>
        <span className={`${styles.metricStatusPill} ${getMetricStatusClass(item.status)}`}>
          {formatMetricStatus(item.status)}
        </span>
      </div>
      <div className={styles.metricResultScore}>
        <strong>{item.score === null ? "--" : formatRate(item.score)}</strong>
        <span>{item.success === null ? "未进入 gate" : item.success ? "通过" : "未达标"}</span>
      </div>
      <p>{item.reason}</p>
      {item.missingFields.length > 0 ? (
        <div className={styles.capabilityGrid}>
          {item.missingFields.map((field) => (
            <span className={`${styles.capabilityPill} ${styles.capabilityDisabled}`} key={field}>
              缺失 · {field}
            </span>
          ))}
        </div>
      ) : null}
      {item.evidence.length > 0 ? (
        <div className={styles.mappingWarnings}>
          {item.evidence.slice(0, 2).map((evidence) => (
            <span key={evidence}>{evidence}</span>
          ))}
        </div>
      ) : null}
    </article>
  );
}

/**
 * Group metric results by category while preserving insertion order.
 * @param items Metric results.
 * @returns Grouped metric result map.
 */
function groupMetricResults(items: EvalMetricResult[]): Record<string, EvalMetricResult[]> {
  return items.reduce<Record<string, EvalMetricResult[]>>((groups, item) => {
    groups[item.category] = groups[item.category] ?? [];
    groups[item.category].push(item);
    return groups;
  }, {});
}

/**
 * Truncate long inline strings for compact diagnostics.
 * @param value Raw text.
 * @param maxLength Maximum displayed characters.
 * @returns Truncated text with suffix when needed.
 */
function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

/* ---------------- Step 3: Package ---------------- */

type StepPackageProps = {
  remediationPackage: RemediationPackageSnapshot | null;
  remediationGenerating: boolean;
  evaluateResult: EvaluateResponse | null;
  badCaseHarvesting: boolean;
  onGenerate: () => void;
  onHarvest: () => void;
  onBack: () => void;
  onAdvance: () => void;
  canAdvance: boolean;
};

function StepPackage(props: StepPackageProps) {
  return (
    <>
      <section className={styles.stepIntro}>
        <h2>编译为 Agent 可读调优包</h2>
        <p>把这次的 bad case + 评估结果打包为 4 个标准文件，可以直接交给 Claude Code / Codex。</p>
        <div className={styles.howTo}>
          <span className={styles.howToTitle}>怎么用</span>
          <span>① 点「生成调优包」一键编译；下方会出现 issue-brief / remediation-spec / badcases / acceptance-gate 四个文件。</span>
          <span>② 复制 4 个文件内容粘贴到 Claude Code / Codex 的对话里，让它去改 prompt / policy / orchestration / code。</span>
          <span>③ 同时可以「沉淀到案例池」，把这批 bad case 留作之后回放的回归素材。</span>
        </div>
      </section>

      <section className={`${styles.panel} ${styles.panelFull}`}>
        <div className={styles.panelHeader}>
          <div>
            <h2>调优包</h2>
            <p>每个调优包都是问题、证据、修复目标与验收门槛的标准化封装。</p>
          </div>
          <span className={styles.panelMeta}>{props.remediationPackage?.packageId ?? "REMEDIATION"}</span>
        </div>
        <RemediationPackagePanel
          packageSnapshot={props.remediationPackage}
          loading={props.remediationGenerating}
          canGenerate={Boolean(props.evaluateResult?.badCaseAssets.length)}
          onGenerate={props.onGenerate}
        />
        <div className={styles.baselineRow}>
          <button
            className={styles.primaryOutlineButton}
            type="button"
            disabled={!props.evaluateResult?.badCaseAssets.length || props.badCaseHarvesting}
            onClick={props.onHarvest}
          >
            {props.badCaseHarvesting ? "沉淀中…" : "沉淀 bad case 到案例池"}
          </button>
          <span className={styles.baselineHint}>
            沉淀后可在「案例池」中浏览与抽样、构造长期回归集。
          </span>
        </div>
      </section>

      <div className={styles.stepNav}>
        <button type="button" className={styles.primaryOutlineButton} onClick={props.onBack}>
          ← 上一步
        </button>
        <div className={styles.stepNavRight}>
          <span className={styles.stepHint}>
            {props.canAdvance ? "调优包就绪，下一步进入回放验证。" : "先生成一份调优包。"}
          </span>
          <button
            type="button"
            className={styles.primaryOutlineButton}
            disabled={!props.canAdvance}
            onClick={props.onAdvance}
            style={{ background: props.canAdvance ? "#0b0b0b" : undefined, color: props.canAdvance ? "#fff" : undefined }}
          >
            下一步：保存基线 / 回放 →
          </button>
        </div>
      </div>
    </>
  );
}

/* ---------------- Step 4: Validate ---------------- */

type StepValidateProps = {
  evaluateResult: EvaluateResponse | null;
  baselineCustomerId: string;
  onBaselineCustomerIdChange: (value: string) => void;
  baselineSaving: boolean;
  onSaveBaseline: () => void;
  onBack: () => void;
};

function StepValidate(props: StepValidateProps) {
  return (
    <>
      <section className={styles.stepIntro}>
        <h2>保存基线 · 进入回放验证</h2>
        <p>把这次评估保存为基线，再到「在线评测」用回放把改完的版本和它对比。任何指标回退都不会通过门禁。</p>
        <div className={styles.howTo}>
          <span className={styles.howToTitle}>怎么用</span>
          <span>① 填一个客户 ID（默认 default），点「保存工作台基线」。</span>
          <span>② 跳到「在线评测」，选刚保存的基线 + 输入新版本回复 API，跑一次回放。</span>
          <span>③ 系统会输出基线 vs 新版本的多指标对比与 winRate。</span>
        </div>
      </section>

      <section className={`${styles.panel} ${styles.panelFull}`}>
        <div className={styles.panelHeader}>
          <div>
            <h2>结果导出 · 基线保存</h2>
            <p>导出本次评估中间产物，或保存为可回放的基线。</p>
          </div>
          <span className={styles.panelMeta}>EXPORT</span>
        </div>
        <div className={styles.exportStack}>
          <div className={styles.exportMeta}>
            <p>当前 Run ID</p>
            <strong>{props.evaluateResult?.runId ?? "--"}</strong>
            <span>{props.evaluateResult?.artifactPath ?? "评估完成后可下载并复核 artifact"}</span>
          </div>
          <div className={styles.exportRow}>
            <button
              className={styles.secondaryButton}
              type="button"
              disabled={!props.evaluateResult}
              onClick={() =>
                props.evaluateResult
                  ? downloadFile(
                      `${props.evaluateResult.runId}.enriched.csv`,
                      props.evaluateResult.enrichedCsv,
                      "text/csv;charset=utf-8",
                    )
                  : undefined
              }
            >
              <FeatherIcon name="download" />
              下载 Enriched CSV
            </button>
            <button
              className={styles.secondaryButton}
              type="button"
              disabled={!props.evaluateResult}
              onClick={() =>
                props.evaluateResult
                  ? downloadFile(
                      `${props.evaluateResult.runId}.json`,
                      JSON.stringify(props.evaluateResult, null, 2),
                      "application/json;charset=utf-8",
                    )
                  : undefined
              }
            >
              <FeatherIcon name="fileText" />
              下载 JSON 结果
            </button>
          </div>
          <div className={styles.baselineRow}>
            <label className={styles.baselineLabel}>
              客户 ID（保存基线）
              <input
                className={styles.baselineInput}
                value={props.baselineCustomerId}
                onChange={(event) => props.onBaselineCustomerIdChange(event.target.value)}
                placeholder="default"
              />
            </label>
            <button
              className={styles.primaryOutlineButton}
              type="button"
              disabled={!props.evaluateResult || props.baselineSaving}
              onClick={props.onSaveBaseline}
            >
              {props.baselineSaving ? "保存中…" : "保存工作台基线"}
            </button>
          </div>
          <p className={styles.baselineHint}>
            基线写入 <code>{"mock-chatlog/baselines/<customerId>/"}</code>，可在「在线评测」选择该基线进行回放。
          </p>
        </div>
      </section>

      <div className={styles.stepNav}>
        <button type="button" className={styles.primaryOutlineButton} onClick={props.onBack}>
          ← 上一步
        </button>
        <Link href="/online-eval" className={styles.onlineEvalLink}>
          前往在线评测 →
        </Link>
      </div>
    </>
  );
}

/* ---------------- helpers ---------------- */

function getRunStateLabel(runState: EvalConsoleRunState): string {
  if (runState === "ingesting") return "日志解析中";
  if (runState === "ready") return "待执行";
  if (runState === "running") return "评估中";
  if (runState === "success") return "已完成";
  if (runState === "error") return "异常";
  return "未开始";
}

function getStepHeroTitle(step: number): string {
  if (step === 0) return "上传一段对话日志";
  if (step === 1) return "查看评估结果";
  if (step === 2) return "生成调优包";
  return "保存基线 / 回放验证";
}

function getStepHeroCopy(step: number): string {
  if (step === 0) {
    return "上传 CSV / JSON / TXT / MD 对话日志，选好业务场景后即可开始评估。系统会自动解析、按 session 分组并预览前 20 行。";
  }
  if (step === 1) {
    return "看核心指标、bad case、目标达成、恢复轨迹与图表。所有结论都带证据，不是单一打分。";
  }
  if (step === 2) {
    return "把这批 bad case 编译为 4 个标准文件，直接交给 Claude Code / Codex 修 prompt / policy / orchestration。";
  }
  return "把当前评估保存为基线，跳到在线评测，用回放把改后的版本和它做多指标对比。";
}

function pickActiveOnboardingAnswers(
  answers: Record<string, string>,
  activeQuestionIds: string[],
): Record<string, string> {
  const activeSet = new Set(activeQuestionIds);
  return Object.fromEntries(
    Object.entries(answers)
      .filter(([questionId]) => activeSet.has(questionId))
      .map(([questionId, value]) => [questionId, value.trim()]),
  );
}

function downloadFile(fileName: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
