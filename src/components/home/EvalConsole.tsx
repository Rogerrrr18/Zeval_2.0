/**
 * @fileoverview Production-oriented evaluation console entry component.
 */

"use client";

import { useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { previewCsvLines, splitCsvLine } from "@/lib/csv";
import { inferFormatFromFileName } from "@/parsers";
import { ChartsPanel } from "@/components/home/ChartsPanel";
import { FeatherIcon } from "@/components/home/FeatherIcon";
import { PreviewTable } from "@/components/home/PreviewTable";
import { StatusPanel } from "@/components/home/StatusPanel";
import { SuggestionPanel } from "@/components/home/SuggestionPanel";
import { SummaryGrid } from "@/components/home/SummaryGrid";
import { UploadDropzone } from "@/components/home/UploadDropzone";
import type {
  EvaluateResponse,
  IngestResponse,
  SummaryCard,
  UploadFormat,
} from "@/types/pipeline";
import styles from "./evalConsole.module.css";

const PROCESSING_LOGS = [
  "接收原始日志并校验字段完整性",
  "按 session 排序并补全中间字段",
  "计算客观指标与标准化摘要",
  "生成图表载荷与策略建议",
  "组装本次评估交付结果",
];
const ALLOWED_EXTENSIONS = new Set(["csv", "json", "txt", "md"]);
const MAX_UPLOAD_SIZE_MB = 5;

/**
 * Render the main evaluation console.
 * @returns Console page content.
 */
export function EvalConsole() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [fileName, setFileName] = useState("");
  const [format, setFormat] = useState<UploadFormat>("csv");
  const [ingestResult, setIngestResult] = useState<IngestResponse | null>(null);
  const [evaluateResult, setEvaluateResult] = useState<EvaluateResponse | null>(null);
  const [runState, setRunState] = useState<"idle" | "ingesting" | "ready" | "running" | "success" | "error">(
    "idle",
  );
  const [dragActive, setDragActive] = useState(false);
  const [processStep, setProcessStep] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

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
      ],
    [evaluateResult],
  );
  const warnings = evaluateResult?.meta.warnings ?? ingestResult?.warnings ?? [];
  const canRunEvaluate = Boolean(ingestResult?.rawRows.length) && runState !== "running" && runState !== "ingesting";
  const runStateLabel = getRunStateLabel(runState);
  const heroStats = [
    {
      key: "messages",
      label: "消息量",
      value: ingestResult ? `${ingestResult.ingestMeta.rows}` : "--",
      hint: fileName ? "已完成标准化接入" : "等待原始日志上传",
    },
    {
      key: "sessions",
      label: "会话数",
      value: evaluateResult ? `${evaluateResult.meta.sessions}` : ingestResult ? `${ingestResult.ingestMeta.sessions}` : "--",
      hint: "按 session 聚合后的评估对象",
    },
    {
      key: "charts",
      label: "交付图表",
      value: `${evaluateResult?.charts.length ?? 0}`,
      hint: "核心分析图谱与情绪轨迹",
    },
    {
      key: "warnings",
      label: "降级提示",
      value: `${warnings.length}`,
      hint: warnings.length ? "本次结果包含降级说明" : "当前链路无降级告警",
    },
  ];

  /**
   * Parse and upload one selected file.
   * @param file Selected file.
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
      setFileName(file.name);
      const inferred = inferFormatFromFileName(file.name);
      setFormat(inferred);
      const text = await file.text();

      const response = await fetch("/api/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          format: inferred,
          fileName: file.name,
        }),
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
   * Handle file input selection.
   * @param event Input change event.
   */
  async function handleFileInputChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    await handleFile(file);
  }

  /**
   * Handle drag over on the dropzone.
   * @param event Drag event.
   */
  function handleDragOver(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragActive(true);
  }

  /**
   * Handle file drop on the dropzone.
   * @param event Drag event.
   */
  async function handleDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragActive(false);
    const file = event.dataTransfer.files?.[0];
    if (!file) {
      return;
    }
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
        }),
      });
      const result = (await response.json()) as Partial<EvaluateResponse> & { error?: string };
      if (!response.ok) {
        throw new Error(result.error ?? "评估执行失败");
      }
      setEvaluateResult(result as EvaluateResponse);
      setRunState("success");
      setProcessStep(PROCESSING_LOGS.length - 1);
      setNotice("评估完成，已生成图表、策略与中间产物。");
    } catch (requestError) {
      setRunState("error");
      setError(requestError instanceof Error ? requestError.message : "评估执行失败");
    } finally {
      window.clearInterval(timer);
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.pageChrome} aria-hidden="true" />
      <main className={styles.main}>
        <section className={styles.hero}>
          <div className={styles.heroContent}>
            <p className={styles.badge}>ZERORE EVAL</p>
            <h1 className={styles.heroTitle}>对话评估工作台</h1>
            <p className={styles.heroCopy}>
              将原始 chatlog 转换为可解释的中间产物，生成主题切分、结构化情绪分、图表与优化策略，服务于
              MVP 阶段的评估闭环验证。
            </p>
            <div className={styles.heroTagRow}>
              <span className={styles.heroTag}>状态 · {runStateLabel}</span>
              <span className={styles.heroTag}>格式 · {format.toUpperCase()}</span>
              <span className={styles.heroTag}>
                文件 · {fileName ? fileName : "等待上传"}
              </span>
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

        <section className={styles.workspaceGrid}>
          <section className={`${styles.panel} ${styles.panelWide}`}>
            <div className={styles.panelHeader}>
              <div>
                <h2>日志接入</h2>
                <p>以开发工具风格的工作流完成上传、解析与执行，适配多格式原始日志。</p>
              </div>
              <span className={styles.panelMeta}>RAW INGEST</span>
            </div>
            <div className={styles.intakeStack}>
              <UploadDropzone
                dragActive={dragActive}
                uploading={runState === "ingesting"}
                fileName={fileName}
                maxUploadSizeMb={MAX_UPLOAD_SIZE_MB}
                canRunEvaluate={canRunEvaluate}
                fileInputRef={fileInputRef}
                onDragOver={handleDragOver}
                onDragLeave={() => setDragActive(false)}
                onDrop={handleDrop}
                onFileInputChange={handleFileInputChange}
                onRunEvaluate={handleRunEvaluate}
                processing={runState === "running"}
              />
              <div className={styles.metaRow}>
                <span>{fileName ? `已上传：${fileName}` : "尚未上传文件"}</span>
                <span>{ingestResult ? `${ingestResult.ingestMeta.rows} 条消息` : "等待日志接入"}</span>
              </div>
              {error ? <p className={styles.error}>{error}</p> : null}
              {notice ? <p className={styles.notice}>{notice}</p> : null}
            </div>
          </section>

          <section className={`${styles.panel} ${styles.panelCompact}`}>
            <div className={styles.panelHeader}>
              <div>
                <h2>执行摘要</h2>
                <p>面向业务与策略复盘的一屏指标概览。</p>
              </div>
              <span className={styles.panelMeta}>OVERVIEW</span>
            </div>
            <SummaryGrid cards={summaryCards} />
          </section>

          <section className={`${styles.panel} ${styles.panelWide}`}>
            <div className={styles.panelHeader}>
              <div>
                <h2>标准化预览</h2>
                <p>展示统一 raw 结构的前 20 行，预览区固定高度并支持横向滚动。</p>
              </div>
              <span className={styles.panelMeta}>{previewRows.length} 行缓存</span>
            </div>
            <PreviewTable header={previewHeader} rows={previewRows} />
          </section>

          <section className={`${styles.panel} ${styles.panelCompact}`}>
            <div className={styles.panelHeader}>
              <div>
                <h2>执行状态</h2>
                <p>用时间线查看当前链路进度、warning 与降级说明。</p>
              </div>
              <span className={styles.panelMeta}>{runStateLabel}</span>
            </div>
            <StatusPanel
              processing={runState === "running"}
              processStep={processStep}
              logs={PROCESSING_LOGS}
              warnings={warnings}
            />
          </section>

          <section className={`${styles.panel} ${styles.panelFull}`}>
            <div className={styles.panelHeader}>
              <div>
                <h2>分析图谱</h2>
                <p>当前固定输出核心情绪、断点、活跃时段与 topic 连贯度图表。</p>
              </div>
              <span className={styles.panelMeta}>{evaluateResult?.charts.length ?? 0} 张</span>
            </div>
            <ChartsPanel charts={evaluateResult?.charts ?? []} />
          </section>

          <section className={`${styles.panel} ${styles.panelWide}`}>
            <div className={styles.panelHeader}>
              <div>
                <h2>优化策略</h2>
                <p>按优先级输出下一轮 prompt、交互流程与模型策略调整建议。</p>
              </div>
              <span className={styles.panelMeta}>ACTIONABLE</span>
            </div>
            <SuggestionPanel suggestions={evaluateResult?.suggestions ?? []} />
          </section>

          <section className={`${styles.panel} ${styles.panelCompact}`}>
            <div className={styles.panelHeader}>
              <div>
                <h2>结果导出</h2>
                <p>导出本次评估的中间产物与结构化结果，用于回放和复核。</p>
              </div>
              <span className={styles.panelMeta}>EXPORT</span>
            </div>
            <div className={styles.exportStack}>
              <div className={styles.exportMeta}>
                <p>当前 Run ID</p>
                <strong>{evaluateResult?.runId ?? "--"}</strong>
                <span>{evaluateResult?.artifactPath ?? "评估完成后可下载并复核 artifact"}</span>
              </div>
              <div className={styles.exportRow}>
                <button
                  className={styles.secondaryButton}
                  type="button"
                  disabled={!evaluateResult}
                  onClick={() =>
                    evaluateResult
                      ? downloadFile(
                          `${evaluateResult.runId}.enriched.csv`,
                          evaluateResult.enrichedCsv,
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
                  disabled={!evaluateResult}
                  onClick={() =>
                    evaluateResult
                      ? downloadFile(
                          `${evaluateResult.runId}.json`,
                          JSON.stringify(evaluateResult, null, 2),
                          "application/json;charset=utf-8",
                        )
                      : undefined
                  }
                >
                  <FeatherIcon name="fileText" />
                  下载 JSON 结果
                </button>
              </div>
            </div>
          </section>
        </section>

      </main>
    </div>
  );
}

/**
 * Convert run state to display label.
 * @param runState Current run state.
 * @returns Human-readable label.
 */
function getRunStateLabel(
  runState: "idle" | "ingesting" | "ready" | "running" | "success" | "error",
): string {
  if (runState === "ingesting") {
    return "日志解析中";
  }
  if (runState === "ready") {
    return "待执行";
  }
  if (runState === "running") {
    return "评估中";
  }
  if (runState === "success") {
    return "已完成";
  }
  if (runState === "error") {
    return "异常";
  }
  return "未开始";
}

/**
 * Trigger a file download in the browser.
 * @param fileName Downloaded file name.
 * @param content File content.
 * @param mimeType MIME type.
 */
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
