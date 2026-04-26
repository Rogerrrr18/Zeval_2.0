/**
 * @fileoverview Online evaluation page — 3-step guided flow (select baseline → run replay → compare).
 */

"use client";

import { useCallback, useEffect, useState } from "react";
import { ChartsPanel } from "@/components/home/ChartsPanel";
import { OnlineCompareCharts } from "@/components/online-eval/OnlineCompareCharts";
import { AppShell, Stepper, type StepperStep } from "@/components/shell";
import {
  TEMP_EVAL_SAMPLE_BADCASE_TARGET,
  TEMP_EVAL_SAMPLE_GOODCASE_TARGET,
} from "@/eval-datasets/sample-defaults";
import type { EvaluateResponse } from "@/types/pipeline";
import styles from "./onlineEval.module.css";

type BaselineIndexRow = {
  runId: string;
  createdAt: string;
  label?: string;
  sourceFileName?: string;
  fileName: string;
};

type ReplayApiResponse = {
  runId: string;
  replyEndpoint: string;
  replayedRowCount: number;
  baselineRunId?: string;
  baselineEvaluate?: EvaluateResponse;
  evaluate: EvaluateResponse;
};

const STEPS: StepperStep[] = [
  { key: "baseline", title: "1 · 选基线", hint: "客户 ID + 历史 run" },
  { key: "replay", title: "2 · 跑回放", hint: "新版本回复 API" },
  { key: "compare", title: "3 · 看对比", hint: "多指标 / winRate" },
];

/**
 * Render the online evaluation workspace as a 3-step flow.
 */
export function OnlineEvalConsole() {
  const [customerId, setCustomerId] = useState("default");
  const [baselines, setBaselines] = useState<BaselineIndexRow[]>([]);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [replyApiBaseUrl, setReplyApiBaseUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingList, setLoadingList] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [replayResult, setReplayResult] = useState<ReplayApiResponse | null>(null);
  const [sampleBatchJson, setSampleBatchJson] = useState("");
  const [currentStep, setCurrentStep] = useState(0);

  useEffect(() => {
    const stored = window.localStorage.getItem("zerore:lastCustomerId");
    if (stored) {
      setCustomerId(stored);
    }
  }, []);

  const loadBaselines = useCallback(async () => {
    setLoadingList(true);
    setError("");
    try {
      const response = await fetch(`/api/workbench-baselines/${encodeURIComponent(customerId)}`);
      const data = (await response.json()) as { baselines?: BaselineIndexRow[]; error?: string };
      if (!response.ok) {
        throw new Error(data.error ?? "加载基线列表失败");
      }
      setBaselines(data.baselines ?? []);
      window.localStorage.setItem("zerore:lastCustomerId", customerId);
      setNotice(`已加载 ${data.baselines?.length ?? 0} 条基线索引。`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "加载失败");
    } finally {
      setLoadingList(false);
    }
  }, [customerId]);

  async function handleReplay() {
    if (!selectedRunId) {
      setError("请先选择一条基线快照（含 rawRows）。");
      return;
    }
    setLoading(true);
    setError("");
    setNotice("");
    setReplayResult(null);
    try {
      const response = await fetch("/api/online-eval/replay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baselineRef: { customerId, runId: selectedRunId },
          replyApiBaseUrl: replyApiBaseUrl.trim() || undefined,
          useLlm: true,
        }),
      });
      const data = (await response.json()) as Partial<ReplayApiResponse> & { error?: string; detail?: string };
      if (!response.ok) {
        throw new Error(data.detail ?? data.error ?? "回放评估失败");
      }
      setReplayResult(data as ReplayApiResponse);
      setNotice(`回放完成：已用回复端点 ${data.replyEndpoint} 重写 assistant，共 ${data.replayedRowCount} 行参与评估。`);
      setCurrentStep(2);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "回放失败");
    } finally {
      setLoading(false);
    }
  }

  async function handleSampleBatch() {
    setLoading(true);
    setError("");
    setSampleBatchJson("");
    try {
      const response = await fetch("/api/eval-datasets/sample-batches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestedGoodcaseCount: TEMP_EVAL_SAMPLE_GOODCASE_TARGET,
          requestedBadcaseCount: TEMP_EVAL_SAMPLE_BADCASE_TARGET,
          seed: `online_${customerId}`,
          strategy: "stratified_random_v1_temp_eval",
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.detail ?? data.error ?? "创建 sample batch 失败");
      }
      setSampleBatchJson(JSON.stringify(data, null, 2));
      setNotice("已生成临时评测集（不足 20 条亦会落盘并附 warnings）。");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "抽样失败");
    } finally {
      setLoading(false);
    }
  }

  const completedStep = (() => {
    if (replayResult) return 2;
    if (selectedRunId && baselines.length > 0) return 1;
    return 0;
  })();

  function goToStep(index: number) {
    if (index < 0 || index >= STEPS.length) return;
    if (index > completedStep + 1) return;
    setCurrentStep(index);
  }

  return (
    <AppShell
      subheader={<Stepper steps={STEPS} current={currentStep} completed={completedStep} onSelect={goToStep} />}
    >
      <div className={styles.page}>
        <main className={styles.main}>
          <header className={styles.topBar}>
            <div className={styles.titleBlock}>
              <h1>在线评测</h1>
              <p>选基线 → 跑新版本回放 → 看多指标对比。任何指标回退都不会通过门禁。</p>
            </div>
          </header>

          {error ? <p className={styles.error}>{error}</p> : null}
          {notice ? <p className={styles.notice}>{notice}</p> : null}

          {currentStep === 0 ? (
            <>
              <section className={styles.stepIntro}>
                <h2>选一个工作台基线</h2>
                <p>基线是在「工作台 · 第 4 步」保存过的评估快照（含原始 rawRows）。我们会用它的对话回放新版本。</p>
                <div className={styles.howTo}>
                  <span className={styles.howToTitle}>怎么用</span>
                  <span>① 输入 customerId（默认 default），点「刷新基线列表」。</span>
                  <span>② 在下拉框里选一个 runId，点击「下一步」。</span>
                </div>
              </section>

              <section className={styles.panel}>
                <h2>基线选择</h2>
                <p>选择客户 + runId；如还没保存基线，先去「工作台 · 第 4 步」保存一份。</p>
                <div className={styles.formGrid}>
                  <label className={styles.label}>
                    客户 ID（customerId）
                    <input
                      className={styles.input}
                      value={customerId}
                      onChange={(event) => setCustomerId(event.target.value)}
                      placeholder="如 default、tenant_a"
                    />
                  </label>
                  <label className={styles.label}>
                    选择基线（runId）
                    <select
                      className={styles.select}
                      value={selectedRunId}
                      onChange={(event) => setSelectedRunId(event.target.value)}
                      disabled={!baselines.length}
                    >
                      <option value="">— 请先加载列表 —</option>
                      {baselines.map((row) => (
                        <option key={row.fileName} value={row.runId}>
                          {row.runId} · {row.createdAt}
                          {row.label ? ` · ${row.label}` : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className={styles.rowActions} style={{ marginTop: 14 }}>
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    disabled={loadingList}
                    onClick={() => void loadBaselines()}
                  >
                    {loadingList ? "加载中…" : "刷新基线列表"}
                  </button>
                  <button
                    type="button"
                    className={styles.primaryButton}
                    disabled={!selectedRunId}
                    onClick={() => goToStep(1)}
                  >
                    下一步：配置回放 →
                  </button>
                </div>
              </section>
            </>
          ) : null}

          {currentStep === 1 ? (
            <>
              <section className={styles.stepIntro}>
                <h2>配置新版本回复通道，跑回放</h2>
                <p>
                  填一个新版本的 Reply API 基址（留空走默认 mock 客户 API），系统会用基线对话作为输入逐条 ping 这个端点，重写
                  assistant 后再做一次完整评估。
                </p>
                <div className={styles.howTo}>
                  <span className={styles.howToTitle}>怎么用</span>
                  <span>① 填新版本回复 API 基址（POST /reply）。</span>
                  <span>② 点「执行回放评估」，跑完会自动跳到「看对比」。</span>
                </div>
              </section>

              <section className={styles.panel}>
                <h2>回复通道 · 回放执行</h2>
                <p>
                  当前基线：
                  <strong>{selectedRunId || "未选择"}</strong>
                </p>
                <div className={styles.formGrid}>
                  <label className={styles.label}>
                    客户回复 API 基址（可选）
                    <input
                      className={styles.input}
                      value={replyApiBaseUrl}
                      onChange={(event) => setReplyApiBaseUrl(event.target.value)}
                      placeholder="例如：https://your-domain/api"
                    />
                  </label>
                </div>
                <div className={styles.rowActions} style={{ marginTop: 14 }}>
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    onClick={() => goToStep(0)}
                  >
                    ← 返回选基线
                  </button>
                  <button
                    type="button"
                    className={styles.primaryButton}
                    disabled={loading || !selectedRunId}
                    onClick={() => void handleReplay()}
                  >
                    {loading ? "执行中…" : "执行回放评估"}
                  </button>
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    disabled={loading}
                    onClick={() => void handleSampleBatch()}
                  >
                    生成临时评测集（约 20 条）
                  </button>
                </div>
                <ul className={styles.metaList} style={{ marginTop: 14 }}>
                  <li>系统会按基线 rawRows 的 user 轮逐条调用 Reply API，把 assistant 替换为新版本输出。</li>
                </ul>
              </section>

              {sampleBatchJson ? (
                <section className={styles.panel}>
                  <h2>临时评测集</h2>
                  <p>
                    默认 good {TEMP_EVAL_SAMPLE_GOODCASE_TARGET} + bad {TEMP_EVAL_SAMPLE_BADCASE_TARGET}；池子不足时仍返回部分 case。
                  </p>
                  <pre className={styles.rawPreview}>{sampleBatchJson}</pre>
                </section>
              ) : null}
            </>
          ) : null}

          {currentStep === 2 ? (
            <>
              <section className={styles.stepIntro}>
                <h2>对比结果</h2>
                <p>基线 vs 新版本的多指标对比、winRate 与图表。任何关键指标回退都应触发 fail。</p>
              </section>

              {replayResult?.baselineEvaluate ? (
                <section className={styles.panel}>
                  <h2>多指标对比（基线 vs 在线回放）</h2>
                  <p>
                    基线 run：<strong>{replayResult.baselineEvaluate.runId}</strong> · 在线 run：
                    <strong>{replayResult.evaluate.runId}</strong>
                  </p>
                  <OnlineCompareCharts baseline={replayResult.baselineEvaluate} current={replayResult.evaluate} />
                </section>
              ) : null}

              {replayResult?.evaluate ? (
                <section className={styles.panel}>
                  <h2>在线回放 · 全量图表</h2>
                  <p>与工作台同款图表载荷，便于细节核对。</p>
                  <ChartsPanel charts={replayResult.evaluate.charts} />
                </section>
              ) : (
                <section className={styles.panel}>
                  <p>还没有回放结果。回到第 2 步执行一次回放。</p>
                  <div className={styles.rowActions} style={{ marginTop: 12 }}>
                    <button type="button" className={styles.secondaryButton} onClick={() => goToStep(1)}>
                      ← 回到第 2 步
                    </button>
                  </div>
                </section>
              )}

              <div className={styles.rowActions}>
                <button type="button" className={styles.secondaryButton} onClick={() => goToStep(1)}>
                  ← 重新跑一次
                </button>
              </div>
            </>
          ) : null}
        </main>
      </div>
    </AppShell>
  );
}
