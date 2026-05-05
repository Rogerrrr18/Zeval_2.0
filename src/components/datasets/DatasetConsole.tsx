/**
 * @fileoverview Dataset and bad case cluster browsing workspace.
 *
 * 案例池现在是「只读 + 错判覆盖」形态：
 *   - 所有 bad case 来自 pipeline 自动判定，不需要人工标注主流程
 *   - 用户唯一可执行的人工动作是「标记错判（false positive）」，落到独立的 manualOverrides
 *     字段，不影响主自动流，不进入 gold set 流程
 *   - Gold Set v2 标注流程在产品 UI 中已下线，仅保留底层数据 / API 给 calibration 使用
 */

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BadCaseCluster } from "@/badcase/types";
import { AppShell } from "@/components/shell";
import type {
  DatasetCaseRecord,
  DatasetCaseReviewStatus,
} from "@/eval-datasets/storage/types";
import styles from "./datasetConsole.module.css";

const DATASET_SNAPSHOT_KEY = "zeval.datasets.snapshot.v1";

type DatasetConsoleSnapshot = {
  clusters: BadCaseCluster[];
  cases: DatasetCaseRecord[];
  selectedScenarioId: string;
  notice: string;
};

type ClusterResponse = {
  clusters: BadCaseCluster[];
  totalCases: number;
  totalClusters: number;
};

type CaseListResponse = {
  cases: DatasetCaseRecord[];
  count: number;
};

const CASE_REVIEW_STATUS_OPTIONS: DatasetCaseReviewStatus[] = [
  "auto_captured",
  "human_reviewed",
  "gold_candidate",
  "gold",
  "regression_active",
];

/**
 * Render the dataset browsing console.
 * @returns Dataset page content.
 */
export function DatasetConsole() {
  const snapshotHydratedRef = useRef(false);
  const [clusters, setClusters] = useState<BadCaseCluster[]>([]);
  const [cases, setCases] = useState<DatasetCaseRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [overrideCaseId, setOverrideCaseId] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedScenarioId, setSelectedScenarioId] = useState("");

  // Hydrate persisted snapshot.
  useEffect(() => {
    const raw = window.localStorage.getItem(DATASET_SNAPSHOT_KEY);
    if (!raw) {
      snapshotHydratedRef.current = true;
      return;
    }
    try {
      const snapshot = JSON.parse(raw) as DatasetConsoleSnapshot;
      setClusters(snapshot.clusters ?? []);
      setCases(snapshot.cases ?? []);
      setSelectedScenarioId(snapshot.selectedScenarioId ?? "");
      setNotice(snapshot.notice ?? "");
    } catch {
      window.localStorage.removeItem(DATASET_SNAPSHOT_KEY);
    } finally {
      snapshotHydratedRef.current = true;
    }
  }, []);

  // Persist snapshot.
  useEffect(() => {
    if (!snapshotHydratedRef.current) {
      return;
    }
    const snapshot: DatasetConsoleSnapshot = { clusters, cases, selectedScenarioId, notice };
    window.localStorage.setItem(DATASET_SNAPSHOT_KEY, JSON.stringify(snapshot));
  }, [cases, clusters, notice, selectedScenarioId]);

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

  useEffect(() => {
    void loadData();
  }, [loadData]);

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

  const caseById = useMemo(() => {
    return new Map(cases.map((item) => [item.caseId, item]));
  }, [cases]);

  const reviewStats = useMemo(() => {
    const stats = new Map<DatasetCaseReviewStatus, number>();
    cases.forEach((item) => {
      const status = item.reviewStatus ?? "auto_captured";
      stats.set(status, (stats.get(status) ?? 0) + 1);
    });
    return stats;
  }, [cases]);

  const averageSeverity = useMemo(() => {
    if (cases.length === 0) {
      return 0;
    }
    return (
      cases.reduce((sum, item) => sum + (item.failureSeverityScore ?? 0), 0) / cases.length
    ).toFixed(2);
  }, [cases]);

  /**
   * Append a `false_positive` manual override on one bad case. This does NOT
   * change the main pipeline review flow — it only records that a human flagged
   * this auto-captured case as misjudged.
   *
   * @param caseId Dataset case id.
   * @param note Optional human-provided note.
   */
  const markFalsePositive = useCallback(async (caseId: string, note?: string) => {
    setOverrideCaseId(caseId);
    setError("");
    try {
      const target = caseById.get(caseId);
      const existingOverrides = target?.manualOverrides ?? [];
      const nextOverrides = [
        ...existingOverrides,
        {
          type: "false_positive" as const,
          note: note?.trim() || undefined,
          createdAt: new Date().toISOString(),
        },
      ];
      const response = await fetch(`/api/eval-datasets/cases/${encodeURIComponent(caseId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ manualOverrides: nextOverrides }),
      });
      const data = (await response.json()) as { case?: DatasetCaseRecord; error?: string; detail?: string };
      if (!response.ok || !data.case) {
        throw new Error(data.detail ?? data.error ?? "标记错判失败");
      }
      setCases((current) => current.map((item) => (item.caseId === data.case?.caseId ? data.case : item)));
      setNotice(`已为 ${caseId} 添加错判标记。`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "标记错判失败");
    } finally {
      setOverrideCaseId("");
    }
  }, [caseById]);

  return (
    <AppShell>
      <div className={styles.page}>
        <main className={styles.main}>
          <header className={styles.topBar}>
            <div className={styles.titleBlock}>
              <h1>Bad Case 案例池</h1>
              <p>topic 粒度自动沉淀的失败案例。每条 case 展示规则命中信号 + 自动判定原因，无需人工标注。</p>
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
              <small>按轻量相似度聚合</small>
            </article>
            <article className={styles.heroCard}>
              <span>Avg Severity</span>
              <strong>{averageSeverity}</strong>
              <small>failureSeverityScore 平均值</small>
            </article>
            <article className={styles.heroCard}>
              <span>Auto Signals</span>
              <strong>{cases.reduce((sum, item) => sum + (item.autoSignals?.length ?? 0), 0)}</strong>
              <small>规则命中的自动判定信号</small>
            </article>
            <article className={styles.heroCard}>
              <span>Overrides</span>
              <strong>{cases.reduce((sum, item) => sum + (item.manualOverrides?.length ?? 0), 0)}</strong>
              <small>人工标记错判的样本数</small>
            </article>
          </section>

          <section className={styles.stepIntro}>
            <h2>怎么用</h2>
            <div className={styles.howTo}>
              <span>① 在「场景筛选」聚焦特定业务，点 cluster 展开看其内部 case。</span>
              <span>② 每条 case 展示命中信号、tag、原始 transcript；如系统判错，点「标记错判」即可。</span>
              <span>③ 错判记录单独存储，不会影响自动判定主流程，可作为日后规则优化的反馈信号。</span>
            </div>
          </section>

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
              {CASE_REVIEW_STATUS_OPTIONS.map((status) => (
                <span className={styles.statusPill} key={status}>
                  {status}: {reviewStats.get(status) ?? 0}
                </span>
              ))}
              {topTags.map(([tag, count]) => (
                <span className={styles.tagPill} key={tag}>
                  {tag} · {count}
                </span>
              ))}
            </div>
          </section>

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
                        <ReadOnlyCaseCard
                          caseRecord={caseById.get(item.caseId)}
                          item={item}
                          key={item.caseId}
                          markingFalsePositive={overrideCaseId === item.caseId}
                          onMarkFalsePositive={markFalsePositive}
                        />
                      ))}
                    </div>
                  </details>
                ))
              ) : (
                <div className={styles.empty}>当前没有可展示的 cluster。</div>
              )}
            </div>
          </section>
        </main>
      </div>
    </AppShell>
  );
}

/**
 * Render one bad case card in read-only form, with a single "mark as false positive"
 * action. No human review form, no gold candidate path.
 *
 * @param props Case item, full record and the override handler.
 * @returns Case card element.
 */
function ReadOnlyCaseCard(props: {
  item: BadCaseCluster["items"][number];
  caseRecord?: DatasetCaseRecord;
  markingFalsePositive: boolean;
  onMarkFalsePositive: (caseId: string, note?: string) => Promise<void>;
}) {
  const { item, caseRecord, markingFalsePositive, onMarkFalsePositive } = props;
  const [showNoteInput, setShowNoteInput] = useState(false);
  const [note, setNote] = useState("");
  const overrides = caseRecord?.manualOverrides ?? [];
  const alreadyMarked = overrides.some((o) => o.type === "false_positive");
  const signals = caseRecord?.autoSignals ?? [];

  return (
    <article className={styles.caseCard}>
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

      {signals.length > 0 ? (
        <div className={styles.signalBox}>
          <strong>命中信号</strong>
          <ul>
            {signals.map((signal, idx) => (
              <li key={`${item.caseId}_signal_${idx}`}>{describeSignal(signal)}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {item.suggestedAction ? <p className={styles.actionText}>{item.suggestedAction}</p> : null}
      {item.transcript ? <pre className={styles.transcript}>{item.transcript}</pre> : null}

      <div className={styles.overrideRow}>
        {alreadyMarked ? (
          <span className={styles.overrideBadge}>已标记为错判（{overrides.length}）</span>
        ) : showNoteInput ? (
          <div className={styles.overrideForm}>
            <input
              className={styles.input}
              placeholder="可选：为什么这是错判？"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              disabled={markingFalsePositive}
            />
            <button
              className={styles.primaryButton}
              type="button"
              disabled={markingFalsePositive}
              onClick={async () => {
                await onMarkFalsePositive(item.caseId, note);
                setShowNoteInput(false);
                setNote("");
              }}
            >
              {markingFalsePositive ? "提交中…" : "确认错判"}
            </button>
            <button
              className={styles.secondaryButton}
              type="button"
              onClick={() => {
                setShowNoteInput(false);
                setNote("");
              }}
            >
              取消
            </button>
          </div>
        ) : (
          <button
            className={styles.secondaryButton}
            type="button"
            onClick={() => setShowNoteInput(true)}
          >
            标记错判
          </button>
        )}
      </div>
    </article>
  );
}

/**
 * Render one auto-signal entry as a short human-readable string.
 *
 * @param signal Auto signal record (loose shape).
 * @returns Display string.
 */
function describeSignal(signal: Record<string, unknown>): string {
  const kind = String(signal.kind ?? "");
  if (kind === "negative_keyword") {
    return `负面关键词「${String(signal.keyword ?? "")}」(turn ${signal.turnIndex})`;
  }
  if (kind === "metric") {
    const metric = String(signal.metric ?? "");
    return `客观指标 ${metric} = ${signal.value}`;
  }
  if (kind === "implicit_signal") {
    return `隐式信号：${String(signal.signalId ?? "")}`;
  }
  return JSON.stringify(signal);
}
