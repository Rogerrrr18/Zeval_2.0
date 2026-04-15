/**
 * @fileoverview Build summary cards for the frontend overview panel.
 */

import type { ObjectiveMetrics, SubjectiveMetrics, SummaryCard } from "@/types/pipeline";

/**
 * Build summary cards for the primary insight row.
 * @param objectiveMetrics Objective metrics.
 * @param subjectiveMetrics Subjective metrics.
 * @param sessionCount Session count.
 * @param messageCount Message count.
 * @returns Summary card array.
 */
export function buildSummaryCards(
  objectiveMetrics: ObjectiveMetrics,
  subjectiveMetrics: SubjectiveMetrics,
  sessionCount: number,
  messageCount: number,
): SummaryCard[] {
  const empathyScore =
    subjectiveMetrics.dimensions.find((item) => item.dimension === "共情程度")?.score ?? 0;
  const highRiskSignals = subjectiveMetrics.signals.filter((item) => item.severity === "high").length;
  const avgEmotionScore = subjectiveMetrics.emotionCurve.length
    ? Number(
        (
          subjectiveMetrics.emotionCurve.reduce((sum, item) => sum + item.emotionScore, 0) /
          subjectiveMetrics.emotionCurve.length
        ).toFixed(1),
      )
    : 0;

  return [
    {
      key: "sessionCount",
      label: "会话规模",
      value: `${sessionCount}`,
      hint: `${messageCount} 条消息进入本次评估`,
    },
    {
      key: "responseGap",
      label: "平均响应间隔",
      value: `${Math.round(objectiveMetrics.avgResponseGapSec)}s`,
      hint: "越低通常意味着更平顺的交互节奏",
    },
    {
      key: "topicSwitch",
      label: "话题切换率",
      value: `${objectiveMetrics.topicSwitchRate.toFixed(2)}`,
      hint: "这里按每个 session 的平均 segment 切换次数统计",
    },
    {
      key: "emotion",
      label: "平均情绪分",
      value: `${avgEmotionScore}`,
      hint: subjectiveMetrics.status === "degraded" ? "当前为规则近似 + 局部校正结果" : "当前为 segment 级结构化情绪分",
    },
    {
      key: "empathy",
      label: "共情得分",
      value: `${empathyScore}/5`,
      hint: "情绪分与共情分联合反映体验质量",
    },
    {
      key: "signals",
      label: "高风险信号",
      value: `${highRiskSignals}`,
      hint: "来自隐式推断信号层的高风险项数量",
    },
  ];
}
