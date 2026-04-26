/**
 * @fileoverview Dataset and bad case cluster browsing workspace.
 */

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { BadCaseCluster } from "@/badcase/types";
import type {
  GoldSetAnnotationTaskRecord,
  GoldSetLabelDraftRecord,
  GoldSetReviewStatus,
} from "@/calibration/types";
import { AppShell, Stepper, type StepperStep } from "@/components/shell";
import type { DatasetCaseRecord } from "@/eval-datasets/storage/types";
import styles from "./datasetConsole.module.css";

type DatasetTab = "browse" | "gold";

const STEPS: StepperStep[] = [
  { key: "browse", title: "1 · 浏览案例池", hint: "已沉淀 bad case + cluster" },
  { key: "gold", title: "2 · 标注 Gold Set", hint: "审核 → 导入 labels.jsonl" },
];

type ClusterResponse = {
  clusters: BadCaseCluster[];
  totalCases: number;
  totalClusters: number;
};

type CaseListResponse = {
  cases: DatasetCaseRecord[];
  count: number;
};

type GoldSetDraftValidation = {
  caseId: string;
  taskId?: string;
  reviewStatus?: GoldSetReviewStatus;
  importable: boolean;
  errors: string[];
  warnings: string[];
};

type GoldSetTasksResponse = {
  tasks: GoldSetAnnotationTaskRecord[];
  drafts: GoldSetLabelDraftRecord[];
  validations: GoldSetDraftValidation[];
  stats: {
    totalTasks: number;
    approvedImportable: number;
    blockedApproved: number;
    statusCounts: Record<string, number>;
  };
  error?: string;
  detail?: string;
};

const GOLD_SET_VERSION = "v2";
const REVIEW_STATUS_OPTIONS: GoldSetReviewStatus[] = [
  "draft",
  "ready_for_review",
  "changes_requested",
  "approved",
  "imported",
];

/**
 * Render the dataset browsing console.
 * @returns Dataset page content.
 */
export function DatasetConsole() {
  const [clusters, setClusters] = useState<BadCaseCluster[]>([]);
  const [cases, setCases] = useState<DatasetCaseRecord[]>([]);
  const [goldTasks, setGoldTasks] = useState<GoldSetAnnotationTaskRecord[]>([]);
  const [goldDrafts, setGoldDrafts] = useState<GoldSetLabelDraftRecord[]>([]);
  const [goldValidations, setGoldValidations] = useState<GoldSetDraftValidation[]>([]);
  const [goldStats, setGoldStats] = useState<GoldSetTasksResponse["stats"] | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [loading, setLoading] = useState(false);
  const [goldLoading, setGoldLoading] = useState(false);
  const [goldSaving, setGoldSaving] = useState(false);
  const [goldImporting, setGoldImporting] = useState(false);
  const [promotingCaseId, setPromotingCaseId] = useState("");
  const [error, setError] = useState("");
  const [goldError, setGoldError] = useState("");
  const [notice, setNotice] = useState("");
  const [goldNotice, setGoldNotice] = useState("");
  const [selectedScenarioId, setSelectedScenarioId] = useState("");
  const [activeTab, setActiveTab] = useState<DatasetTab>("browse");

  const loadData = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [clusterResponse, caseResponse] = await Promise.all([
        fetch("/api/eval-datasets/clusters"),
        fetch("/api/eval-datasets/cases?caseSetType=badcase"),
      ]);

      const clusterData = (await clusterResponse.json()) as Partial<ClusterResponse> & { error?: string; detail?: string };
      const caseData = (await caseResponse.json()) as Partial<CaseListResponse> & { error?: string; detail?: string };

      if (!clusterResponse.ok) {
        throw new Error(clusterData.detail ?? clusterData.error ?? "加载 cluster 失败");
      }
      if (!caseResponse.ok) {
        throw new Error(caseData.detail ?? caseData.error ?? "加载案例池失败");
      }

      setClusters(clusterData.clusters ?? []);
      setCases(caseData.cases ?? []);
      setNotice(`已加载 ${caseData.count ?? 0} 条 bad case，聚合为 ${clusterData.totalClusters ?? 0} 个 cluster。`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "加载案例池失败");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadGoldTasks = useCallback(async () => {
    setGoldLoading(true);
    setGoldError("");
    try {
      const response = await fetch(`/api/calibration/gold-sets/${GOLD_SET_VERSION}/annotation-tasks`);
      const data = (await response.json()) as GoldSetTasksResponse;
      if (!response.ok) {
        throw new Error(data.detail ?? data.error ?? "加载 gold set 标注任务失败");
      }
      setGoldTasks(data.tasks ?? []);
      setGoldDrafts(data.drafts ?? []);
      setGoldValidations(data.validations ?? []);
      setGoldStats(data.stats ?? null);
      setGoldNotice(`已加载 ${data.tasks?.length ?? 0} 个 ${GOLD_SET_VERSION} 标注任务。`);
      setSelectedTaskId((current) => current || data.tasks?.[0]?.taskId || "");
    } catch (requestError) {
      setGoldError(requestError instanceof Error ? requestError.message : "加载 gold set 标注任务失败");
    } finally {
      setGoldLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    void loadGoldTasks();
  }, [loadGoldTasks]);

  const scenarioOptions = useMemo(
    () =>
      [...new Set(cases.map((item) => item.scenarioId).filter((value): value is string => Boolean(value)))]
        .sort()
        .map((scenarioId) => ({ scenarioId })),
    [cases],
  );

  const filteredClusters = useMemo(
    () =>
      selectedScenarioId
        ? clusters.filter((item) => item.scenarioId === selectedScenarioId)
        : clusters,
    [clusters, selectedScenarioId],
  );

  const topTags = useMemo(() => {
    const counts = new Map<string, number>();
    cases.forEach((item) => {
      item.tags.forEach((tag) => {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      });
    });
    return [...counts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 6);
  }, [cases]);

  const averageSeverity = useMemo(() => {
    if (cases.length === 0) {
      return 0;
    }
    return (
      cases.reduce((sum, item) => sum + (item.failureSeverityScore ?? 0), 0) / cases.length
    ).toFixed(2);
  }, [cases]);

  const selectedTask = useMemo(
    () => goldTasks.find((item) => item.taskId === selectedTaskId) ?? goldTasks[0] ?? null,
    [goldTasks, selectedTaskId],
  );

  const selectedDraft = useMemo(
    () => goldDrafts.find((item) => item.taskId === selectedTask?.taskId) ?? null,
    [goldDrafts, selectedTask],
  );

  const selectedValidation = useMemo(
    () => goldValidations.find((item) => item.taskId === selectedTask?.taskId) ?? null,
    [goldValidations, selectedTask],
  );

  const statusCounts = goldStats?.statusCounts ?? {};

  const updateSelectedDraft = useCallback((updater: (draft: GoldSetLabelDraftRecord) => GoldSetLabelDraftRecord) => {
    setGoldDrafts((current) =>
      current.map((item) => {
        if (item.taskId !== selectedTask?.taskId) {
          return item;
        }
        return updater(item);
      }),
    );
  }, [selectedTask]);

  const saveSelectedDraft = useCallback(async () => {
    if (!selectedDraft) {
      return;
    }
    setGoldSaving(true);
    setGoldError("");
    try {
      const response = await fetch(
        `/api/calibration/gold-sets/${selectedDraft.goldSetVersion}/label-drafts/${encodeURIComponent(selectedDraft.taskId)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(selectedDraft),
        },
      );
      const data = (await response.json()) as {
        draft?: GoldSetLabelDraftRecord;
        validation?: GoldSetDraftValidation;
        error?: string;
        detail?: string;
      };
      if (!response.ok || !data.draft || !data.validation) {
        throw new Error(data.detail ?? data.error ?? "保存 label draft 失败");
      }
      const savedDraft = data.draft;
      const savedValidation = data.validation;
      setGoldDrafts((current) => current.map((item) => (item.taskId === savedDraft.taskId ? savedDraft : item)));
      setGoldValidations((current) =>
        current.map((item) => (item.taskId === savedValidation.taskId ? savedValidation : item)),
      );
      setGoldNotice(`已保存 ${savedDraft.caseId} 的 label draft。`);
      await loadGoldTasks();
    } catch (requestError) {
      setGoldError(requestError instanceof Error ? requestError.message : "保存 label draft 失败");
    } finally {
      setGoldSaving(false);
    }
  }, [loadGoldTasks, selectedDraft]);

  const importApprovedLabels = useCallback(async () => {
    setGoldImporting(true);
    setGoldError("");
    try {
      const response = await fetch(`/api/calibration/gold-sets/${GOLD_SET_VERSION}/annotation-tasks`, {
        method: "POST",
      });
      const data = (await response.json()) as {
        result?: { importedCount: number; skippedCount: number; failedCount: number };
        error?: string;
        detail?: string;
      };
      if (!response.ok || !data.result) {
        throw new Error(data.detail ?? data.error ?? "导入 approved labels 失败");
      }
      setGoldNotice(
        `导入完成：imported=${data.result.importedCount}，skipped=${data.result.skippedCount}，failed=${data.result.failedCount}。`,
      );
      await loadGoldTasks();
    } catch (requestError) {
      setGoldError(requestError instanceof Error ? requestError.message : "导入 approved labels 失败");
    } finally {
      setGoldImporting(false);
    }
  }, [loadGoldTasks]);

  const promoteCaseToGoldSet = useCallback(async (caseId: string) => {
    setPromotingCaseId(caseId);
    setGoldError("");
    try {
      const response = await fetch(`/api/calibration/gold-sets/${GOLD_SET_VERSION}/candidates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caseId, reviewer: "reviewer" }),
      });
      const data = (await response.json()) as {
        task?: GoldSetAnnotationTaskRecord;
        alreadyExists?: boolean;
        error?: string;
        detail?: string;
      };
      if (!response.ok || !data.task) {
        throw new Error(data.detail ?? data.error ?? "生成 gold candidate 失败");
      }
      setGoldNotice(
        data.alreadyExists
          ? `${caseId} 已存在于 ${GOLD_SET_VERSION}：${data.task.taskId}`
          : `已生成 gold candidate：${data.task.taskId}`,
      );
      await loadGoldTasks();
      setSelectedTaskId(data.task.taskId);
    } catch (requestError) {
      setGoldError(requestError instanceof Error ? requestError.message : "生成 gold candidate 失败");
    } finally {
      setPromotingCaseId("");
    }
  }, [loadGoldTasks]);

  const stepIndex = activeTab === "browse" ? 0 : 1;

  return (
    <AppShell
      subheader={
        <Stepper
          steps={STEPS}
          current={stepIndex}
          completed={1}
          onSelect={(index) => setActiveTab(index === 0 ? "browse" : "gold")}
        />
      }
    >
      <div className={styles.page}>
        <main className={styles.main}>
          <header className={styles.topBar}>
            <div className={styles.titleBlock}>
              <h1>Bad Case 案例池</h1>
              <p>浏览沉淀的失败案例与 cluster；把高价值 case 推进 Gold Set 标注流，为 judge 校准提供 ground truth。</p>
            </div>
          </header>

          <section className={styles.heroGrid}>
            <article className={styles.heroCard}>
              <span>Total Cases</span>
              <strong>{cases.length}</strong>
              <small>已入池 bad case 总数</small>
            </article>
            <article className={styles.heroCard}>
              <span>Total Clusters</span>
              <strong>{clusters.length}</strong>
              <small>按轻量相似度聚合后的 cluster 数</small>
            </article>
            <article className={styles.heroCard}>
              <span>Avg Severity</span>
              <strong>{averageSeverity}</strong>
              <small>failureSeverityScore 平均值</small>
            </article>
            <article className={styles.heroCard}>
              <span>Gold Tasks</span>
              <strong>{goldStats?.totalTasks ?? goldTasks.length}</strong>
              <small>{goldStats?.approvedImportable ?? 0} 条可导入</small>
            </article>
          </section>

          <div className={styles.tabBar}>
            <button
              type="button"
              className={`${styles.tabButton} ${activeTab === "browse" ? styles.tabActive : ""}`}
              onClick={() => setActiveTab("browse")}
            >
              Bad Case 池
            </button>
            <button
              type="button"
              className={`${styles.tabButton} ${activeTab === "gold" ? styles.tabActive : ""}`}
              onClick={() => setActiveTab("gold")}
            >
              Gold Set 标注
            </button>
          </div>

          {activeTab === "browse" ? (
            <section className={styles.stepIntro}>
              <h2>浏览 Bad Case 与 cluster</h2>
              <p>这里是工作台「沉淀到案例池」按钮的归宿。已抽出的失败案例按轻量聚类分组，主导标签可一眼识别热点。</p>
              <div className={styles.howTo}>
                <span className={styles.howToTitle}>怎么用</span>
                <span>① 用「场景筛选」聚焦特定业务；点 cluster 展开看其内部 case。</span>
                <span>② 觉得某个 case 值得作为 ground truth，点「转为 Gold Candidate」推进到第 2 步。</span>
              </div>
            </section>
          ) : (
            <section className={styles.stepIntro}>
              <h2>Gold Set v2 标注流</h2>
              <p>把 candidate 变成可分配、可审核、可导入的标注任务；只有 approved 且校验通过的 draft 会进入 labels.jsonl。</p>
              <div className={styles.howTo}>
                <span className={styles.howToTitle}>怎么用</span>
                <span>① 左侧选一个任务；右侧编辑 dimension 评分、Goal / Recovery 状态与 evidence。</span>
                <span>② 把 reviewStatus 改成 approved 并保存。</span>
                <span>③ 点右上「导入 approved」把通过校验的 label 写入 gold set。</span>
              </div>
            </section>
          )}

          {activeTab === "browse" ? (
          <section className={styles.panel}>
          <div className={styles.panelHeader}>
            <div>
              <h2>筛选与概览</h2>
              <p>当前先支持按场景过滤，后续可扩到 cluster label、dominant tag 和时间窗口。</p>
            </div>
            <button className={styles.secondaryButton} type="button" disabled={loading} onClick={() => void loadData()}>
              {loading ? "刷新中…" : "刷新案例池"}
            </button>
          </div>
          <div className={styles.formRow}>
            <label className={styles.label}>
              场景筛选
              <select
                className={styles.select}
                value={selectedScenarioId}
                onChange={(event) => setSelectedScenarioId(event.target.value)}
              >
                <option value="">全部场景</option>
                {scenarioOptions.map((item) => (
                  <option key={item.scenarioId} value={item.scenarioId}>
                    {item.scenarioId}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {error ? <p className={styles.error}>{error}</p> : null}
          {notice ? <p className={styles.notice}>{notice}</p> : null}
          <div className={styles.tagStrip}>
            {topTags.map(([tag, count]) => (
              <span className={styles.tagPill} key={tag}>
                {tag} · {count}
              </span>
            ))}
          </div>
        </section>
          ) : null}

          {activeTab === "gold" ? (
          <section className={styles.panel}>
          <div className={styles.panelHeader}>
            <div>
              <h2>Gold Set v2 标注任务</h2>
              <p>把 gold set 扩展变成可分配、可审核、可导入的流程；只有 approved 且校验通过的 draft 会进入 labels.jsonl。</p>
            </div>
            <div className={styles.buttonRow}>
              <button className={styles.secondaryButton} type="button" disabled={goldLoading} onClick={() => void loadGoldTasks()}>
                {goldLoading ? "刷新中…" : "刷新任务"}
              </button>
              <button
                className={styles.primaryButton}
                type="button"
                disabled={goldImporting || !goldStats?.approvedImportable}
                onClick={() => void importApprovedLabels()}
              >
                {goldImporting ? "导入中…" : "导入 approved"}
              </button>
            </div>
          </div>

          <div className={styles.goldStats}>
            {REVIEW_STATUS_OPTIONS.map((status) => (
              <span className={styles.statusPill} key={status}>
                {status}: {statusCounts[status] ?? 0}
              </span>
            ))}
            <span className={styles.statusPill}>importable: {goldStats?.approvedImportable ?? 0}</span>
          </div>
          {goldError ? <p className={styles.error}>{goldError}</p> : null}
          {goldNotice ? <p className={styles.notice}>{goldNotice}</p> : null}

          <div className={styles.annotationGrid}>
            <div className={styles.taskList}>
              {goldTasks.length > 0 ? (
                goldTasks.map((task) => {
                  const validation = goldValidations.find((item) => item.taskId === task.taskId);
                  const isActive = selectedTask?.taskId === task.taskId;
                  return (
                    <button
                      className={`${styles.taskButton} ${isActive ? styles.taskButtonActive : ""}`}
                      key={task.taskId}
                      type="button"
                      onClick={() => setSelectedTaskId(task.taskId)}
                    >
                      <strong>{task.caseId}</strong>
                      <span>
                        {task.assignee ?? "unassigned"} · {task.status}
                      </span>
                      <small>{validation?.importable ? "ready to import" : `${validation?.errors.length ?? 0} errors`}</small>
                    </button>
                  );
                })
              ) : (
                <div className={styles.empty}>当前没有 gold set 标注任务。</div>
              )}
            </div>

            {selectedTask && selectedDraft ? (
              <div className={styles.draftEditor}>
                <div className={styles.caseHeader}>
                  <div>
                    <h3>{selectedTask.caseId}</h3>
                    <p>
                      scene={selectedTask.sceneId} · session={selectedTask.sessionId} · reviewer=
                      {selectedTask.reviewer ?? "--"}
                    </p>
                  </div>
                  <span className={styles.severityBadge}>{selectedValidation?.importable ? "READY" : "DRAFT"}</span>
                </div>

                {selectedDraft.autoPrefill ? (
                  <div className={styles.prefillBox}>
                    <strong>Auto-prefill</strong>
                    <span>
                      source={selectedDraft.autoPrefill.source} · generatedAt={selectedDraft.autoPrefill.generatedAt}
                    </span>
                    <div className={styles.metaRow}>
                      {selectedDraft.autoPrefill.reasons.map((reason) => (
                        <span className={styles.tagPill} key={reason}>
                          {reason}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}

                <div className={styles.editorGrid}>
                  <label className={styles.label}>
                    Review Status
                    <select
                      className={styles.select}
                      value={selectedDraft.reviewStatus}
                      onChange={(event) =>
                        updateSelectedDraft((draft) => ({
                          ...draft,
                          reviewStatus: event.target.value as GoldSetReviewStatus,
                        }))
                      }
                    >
                      {REVIEW_STATUS_OPTIONS.map((status) => (
                        <option key={status} value={status}>
                          {status}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className={styles.label}>
                    Labeler
                    <input
                      className={styles.input}
                      value={selectedDraft.labeler ?? ""}
                      onChange={(event) => updateSelectedDraft((draft) => ({ ...draft, labeler: event.target.value }))}
                    />
                  </label>
                  <label className={styles.label}>
                    Reviewer
                    <input
                      className={styles.input}
                      value={selectedDraft.reviewer ?? ""}
                      onChange={(event) => updateSelectedDraft((draft) => ({ ...draft, reviewer: event.target.value }))}
                    />
                  </label>
                  <label className={styles.label}>
                    Reviewed At
                    <input
                      className={styles.input}
                      placeholder="2026-04-24T18:00:00+08:00"
                      value={selectedDraft.reviewedAt ?? ""}
                      onChange={(event) => updateSelectedDraft((draft) => ({ ...draft, reviewedAt: event.target.value }))}
                    />
                  </label>
                </div>

                <div className={styles.dimensionList}>
                  {selectedDraft.dimensions.map((dimension, dimensionIndex) => (
                    <div className={styles.dimensionRow} key={dimension.dimension}>
                      <label className={styles.label}>
                        {dimension.dimension}
                        <input
                          className={styles.input}
                          max={5}
                          min={1}
                          type="number"
                          value={dimension.score ?? ""}
                          onChange={(event) =>
                            updateSelectedDraft((draft) => ({
                              ...draft,
                              dimensions: draft.dimensions.map((item, index) =>
                                index === dimensionIndex
                                  ? { ...item, score: event.target.value ? Number(event.target.value) : null }
                                  : item,
                              ),
                            }))
                          }
                        />
                      </label>
                      <label className={styles.label}>
                        Evidence
                        <input
                          className={styles.input}
                          value={dimension.evidence ?? ""}
                          onChange={(event) =>
                            updateSelectedDraft((draft) => ({
                              ...draft,
                              dimensions: draft.dimensions.map((item, index) =>
                                index === dimensionIndex ? { ...item, evidence: event.target.value } : item,
                              ),
                            }))
                          }
                        />
                      </label>
                    </div>
                  ))}
                </div>

                <div className={styles.editorGrid}>
                  <label className={styles.label}>
                    Goal Status
                    <select
                      className={styles.select}
                      value={selectedDraft.goalCompletion.status ?? ""}
                      onChange={(event) =>
                        updateSelectedDraft((draft) => ({
                          ...draft,
                          goalCompletion: {
                            ...draft.goalCompletion,
                            status: event.target.value
                              ? (event.target.value as GoldSetLabelDraftRecord["goalCompletion"]["status"])
                              : null,
                          },
                        }))
                      }
                    >
                      <option value="">未标注</option>
                      <option value="achieved">achieved</option>
                      <option value="partial">partial</option>
                      <option value="failed">failed</option>
                      <option value="unclear">unclear</option>
                    </select>
                  </label>
                  <label className={styles.label}>
                    Goal Score
                    <input
                      className={styles.input}
                      max={5}
                      min={0}
                      type="number"
                      value={selectedDraft.goalCompletion.score ?? ""}
                      onChange={(event) =>
                        updateSelectedDraft((draft) => ({
                          ...draft,
                          goalCompletion: {
                            ...draft.goalCompletion,
                            score: event.target.value ? Number(event.target.value) : null,
                          },
                        }))
                      }
                    />
                  </label>
                  <label className={styles.label}>
                    Recovery Status
                    <select
                      className={styles.select}
                      value={selectedDraft.recoveryTrace.status ?? ""}
                      onChange={(event) =>
                        updateSelectedDraft((draft) => ({
                          ...draft,
                          recoveryTrace: {
                            ...draft.recoveryTrace,
                            status: event.target.value
                              ? (event.target.value as GoldSetLabelDraftRecord["recoveryTrace"]["status"])
                              : null,
                          },
                        }))
                      }
                    >
                      <option value="">未标注</option>
                      <option value="none">none</option>
                      <option value="completed">completed</option>
                      <option value="failed">failed</option>
                    </select>
                  </label>
                  <label className={styles.label}>
                    Recovery Score
                    <input
                      className={styles.input}
                      max={5}
                      min={0}
                      type="number"
                      value={selectedDraft.recoveryTrace.qualityScore ?? ""}
                      onChange={(event) =>
                        updateSelectedDraft((draft) => ({
                          ...draft,
                          recoveryTrace: {
                            ...draft.recoveryTrace,
                            qualityScore: event.target.value ? Number(event.target.value) : null,
                          },
                        }))
                      }
                    />
                  </label>
                </div>

                <label className={styles.label}>
                  Goal Evidence
                  <textarea
                    className={styles.textarea}
                    value={selectedDraft.goalCompletion.evidence.join("\n")}
                    onChange={(event) =>
                      updateSelectedDraft((draft) => ({
                        ...draft,
                        goalCompletion: {
                          ...draft.goalCompletion,
                          evidence: event.target.value.split(/\r?\n/).filter((line) => line.trim().length > 0),
                        },
                      }))
                    }
                  />
                </label>
                <label className={styles.label}>
                  Recovery Notes
                  <textarea
                    className={styles.textarea}
                    value={selectedDraft.recoveryTrace.notes ?? ""}
                    onChange={(event) =>
                      updateSelectedDraft((draft) => ({
                        ...draft,
                        recoveryTrace: { ...draft.recoveryTrace, notes: event.target.value },
                      }))
                    }
                  />
                </label>
                <label className={styles.label}>
                  Review Notes
                  <textarea
                    className={styles.textarea}
                    value={selectedDraft.reviewNotes ?? ""}
                    onChange={(event) =>
                      updateSelectedDraft((draft) => ({
                        ...draft,
                        reviewNotes: event.target.value,
                      }))
                    }
                  />
                </label>

                {selectedValidation?.errors.length ? (
                  <div className={styles.validationBox}>
                    {selectedValidation.errors.map((item) => (
                      <span key={item}>{item}</span>
                    ))}
                  </div>
                ) : null}

                <pre className={styles.transcript}>{selectedTask.transcriptPreview.join("\n")}</pre>
                <div className={styles.buttonRow}>
                  <button className={styles.primaryButton} type="button" disabled={goldSaving} onClick={() => void saveSelectedDraft()}>
                    {goldSaving ? "保存中…" : "保存 draft"}
                  </button>
                </div>
              </div>
            ) : (
              <div className={styles.empty}>请选择一个标注任务。</div>
            )}
          </div>
        </section>
          ) : null}

          {activeTab === "browse" ? (
          <section className={styles.panel}>
          <div className={styles.panelHeader}>
            <div>
              <h2>Clusters</h2>
              <p>代表样本优先选 medoid；聚类规则当前是 `duplicateGroupKey + semantic/structural distance` 的轻量版本。</p>
            </div>
            <span className={styles.meta}>{filteredClusters.length} 个</span>
          </div>
          <div className={styles.clusterList}>
            {filteredClusters.length > 0 ? (
              filteredClusters.map((cluster) => (
                <details className={styles.clusterCard} key={cluster.clusterId}>
                  <summary className={styles.clusterSummary}>
                    <div>
                      <strong>{cluster.label}</strong>
                      <p>
                        rep={cluster.representativeCaseId} · size={cluster.size} · avgSeverity=
                        {cluster.averageSeverityScore.toFixed(2)}
                      </p>
                    </div>
                    <div className={styles.metaRow}>
                      {cluster.dominantTags.map((tag) => (
                        <span className={styles.tagPill} key={`${cluster.clusterId}_${tag}`}>
                          {tag}
                        </span>
                      ))}
                    </div>
                  </summary>
                  <div className={styles.clusterItems}>
                    {cluster.items.map((item) => (
                      <article className={styles.caseCard} key={item.caseId}>
                        <div className={styles.caseHeader}>
                          <div>
                            <h3>{item.title}</h3>
                            <p>
                              {item.caseId} · session={item.sessionId} · severity=
                              {item.failureSeverityScore.toFixed(2)}
                            </p>
                          </div>
                          <span className={styles.severityBadge}>{Math.round(item.failureSeverityScore * 100)}%</span>
                        </div>
                        <div className={styles.metaRow}>
                          {item.tags.map((tag) => (
                            <span className={styles.tagPill} key={`${item.caseId}_${tag}`}>
                              {tag}
                            </span>
                          ))}
                        </div>
                        {item.suggestedAction ? <p className={styles.actionText}>{item.suggestedAction}</p> : null}
                        <div className={styles.buttonRow}>
                          <button
                            className={styles.secondaryButton}
                            type="button"
                            disabled={promotingCaseId === item.caseId}
                            onClick={() => void promoteCaseToGoldSet(item.caseId)}
                          >
                            {promotingCaseId === item.caseId ? "生成中…" : "转为 Gold Candidate"}
                          </button>
                        </div>
                        {item.transcript ? <pre className={styles.transcript}>{item.transcript}</pre> : null}
                      </article>
                    ))}
                  </div>
                </details>
              ))
            ) : (
              <div className={styles.empty}>当前没有可展示的 cluster。</div>
            )}
          </div>
        </section>
          ) : null}
        </main>
      </div>
    </AppShell>
  );
}
