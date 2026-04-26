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
import type {
  EvaluateResponse,
  IngestResponse,
  SummaryCard,
  UploadFormat,
} from "@/types/pipeline";
import styles from "./evalConsole.module.css";

type EvalConsoleRunState = "idle" | "ingesting" | "ready" | "running" | "success" | "error";

type ResultTabKey = "summary" | "badcase" | "goal" | "recovery" | "kpi" | "suggestion";

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
const ALLOWED_EXTENSIONS = new Set(["csv", "json", "txt", "md"]);
const MAX_UPLOAD_SIZE_MB = 5;
const EVAL_CONSOLE_SNAPSHOT_KEY = "zerore:evalConsoleSnapshot:v2";

const STEPS: StepperStep[] = [
  { key: "upload", title: "1 · 上传日志", hint: "选择文件 + 业务场景" },
  { key: "evaluate", title: "2 · 运行评估", hint: "查看指标与 bad case" },
  { key: "package", title: "3 · 生成调优包", hint: "交给 Claude Code / Codex" },
  { key: "validate", title: "4 · 保存基线 / 回放", hint: "进入在线评测验证" },
];

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
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [baselineCustomerId, setBaselineCustomerId] = useState("default");
  const [baselineSaving, setBaselineSaving] = useState(false);
  const [badCaseHarvesting, setBadCaseHarvesting] = useState(false);
  const [remediationGenerating, setRemediationGenerating] = useState(false);
  const [selectedScenarioId, setSelectedScenarioId] = useState("");
  const [scenarioOnboardingAnswers, setScenarioOnboardingAnswers] = useState<Record<string, string>>({});
  const [remediationPackage, setRemediationPackage] = useState<RemediationPackageSnapshot | null>(null);
  const [currentStep, setCurrentStep] = useState(0);
  const [resultTab, setResultTab] = useState<ResultTabKey>("summary");

  useEffect(() => {
    const lastCustomerId = window.localStorage.getItem("zerore:lastCustomerId");
    if (lastCustomerId) {
      setBaselineCustomerId(lastCustomerId);
    }

    const snapshotRaw = window.sessionStorage.getItem(EVAL_CONSOLE_SNAPSHOT_KEY);
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
      setError("文件类型不支持，请上传 csv/json/txt/md。");
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
      setFileName(file.name);
      const inferred = inferFormatFromFileName(file.name);
      setFormat(inferred);
      const text = await file.text();

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

    let step = 0;
    setRunState("running");
    setError("");
    setNotice("");
    setProcessStep(0);
    setRemediationPackage(null);

    const timer = window.setInterval(() => {
      step = Math.min(PROCESSING_LOGS.length - 1, step + 1);
      setProcessStep(step);
    }, 1000);

    try {
      const response = await fetch("/api/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rawRows: ingestResult.rawRows,
          useLlm: true,
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
      const result = (await response.json()) as Partial<EvaluateResponse> & { error?: string };
      if (!response.ok) {
        throw new Error(result.error ?? "评估执行失败");
      }
      setEvaluateResult(result as EvaluateResponse);
      setRunState("success");
      setProcessStep(PROCESSING_LOGS.length - 1);
      setNotice("评估完成，已生成图表、业务 KPI、策略与中间产物。");
    } catch (requestError) {
      setRunState("error");
      setError(requestError instanceof Error ? requestError.message : "评估执行失败");
    } finally {
      window.clearInterval(timer);
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
      window.localStorage.setItem("zerore:lastCustomerId", baselineCustomerId.trim());
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
              <p className={styles.badge}>ZERORE EVAL · 工作台</p>
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
              previewHeader={previewHeader}
              previewRows={previewRows}
              selectedScenarioId={selectedScenarioId}
              selectedScenarioLabel={selectedScenarioLabel}
              activeOnboardingQuestions={activeOnboardingQuestions}
              answeredOnboardingCount={answeredOnboardingCount}
              scenarioOnboardingAnswers={scenarioOnboardingAnswers}
              canRunEvaluate={canRunEvaluate}
              onDragOver={handleDragOver}
              onDragLeave={() => setDragActive(false)}
              onDrop={handleDrop}
              onFileInputChange={handleFileInputChange}
              onRunEvaluate={handleRunEvaluate}
              onScenarioChange={handleScenarioChange}
              onOnboardingAnswerChange={handleOnboardingAnswerChange}
              onAdvance={() => goToStep(1)}
              canAdvance={Boolean(evaluateResult)}
            />
          ) : null}

          {currentStep === 1 ? (
            <StepEvaluate
              runState={runState}
              processStep={processStep}
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
  previewHeader: string[];
  previewRows: string[][];
  selectedScenarioId: string;
  selectedScenarioLabel: string;
  activeOnboardingQuestions: { id: string; question: string }[];
  answeredOnboardingCount: number;
  scenarioOnboardingAnswers: Record<string, string>;
  canRunEvaluate: boolean;
  onDragOver: (event: DragEvent<HTMLLabelElement>) => void;
  onDragLeave: () => void;
  onDrop: (event: DragEvent<HTMLLabelElement>) => Promise<void>;
  onFileInputChange: (event: ChangeEvent<HTMLInputElement>) => Promise<void>;
  onRunEvaluate: () => Promise<void>;
  onScenarioChange: (scenarioId: string) => void;
  onOnboardingAnswerChange: (questionId: string, value: string) => void;
  onAdvance: () => void;
  canAdvance: boolean;
};

function StepUpload(props: StepUploadProps) {
  return (
    <>
      <section className={styles.stepIntro}>
        <h2>上传一段对话日志</h2>
        <p>支持 CSV / JSON / TXT / MD，单文件 ≤ 5MB。文件解析后会按 session 自动分组、补全字段。</p>
        <div className={styles.howTo}>
          <span className={styles.howToTitle}>怎么用</span>
          <span>① 把对话日志拖到左侧上传区，或点击选择文件。</span>
          <span>② 选一个业务场景（可选），让评估出 KPI 报告而不只是通用指标。</span>
          <span>③ 解析完成后，点击「下一步：运行评估」。</span>
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
            className={styles.processButton}
            disabled={!props.canRunEvaluate}
            onClick={() => void props.onRunEvaluate()}
            style={{ minWidth: 220 }}
          >
            <span className={styles.processButtonText}>
              <strong>{props.runState === "running" ? "评估进行中…" : "运行评估"}</strong>
              <small>系统会跑完客观+主观+证据+图表全链路</small>
            </span>
          </button>
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

/* ---------------- Step 2: Evaluate ---------------- */

type StepEvaluateProps = {
  runState: EvalConsoleRunState;
  processStep: number;
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
