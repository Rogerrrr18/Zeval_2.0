/**
 * @fileoverview Suggestion builder bound to metric outputs.
 */

import type { EnrichedChatlogRow, ObjectiveMetrics, SubjectiveMetrics } from "@/types/pipeline";

/**
 * Build ranked optimization suggestions for the frontend.
 * @param rows Enriched rows.
 * @param objectiveMetrics Objective metrics.
 * @param subjectiveMetrics Subjective metrics.
 * @returns Ranked suggestion list.
 */
export function buildSuggestions(
  rows: EnrichedChatlogRow[],
  objectiveMetrics: ObjectiveMetrics,
  subjectiveMetrics: SubjectiveMetrics,
): string[] {
  const lowEmotionTurns = rows.filter((row) => row.emotionScore <= 40).length;
  const switchCount = rows.filter((row) => row.isTopicSwitch).length;
  const userQuestions = rows.filter((row) => row.isQuestion && row.role === "user").length;
  const empathy = subjectiveMetrics.dimensions.find((item) => item.dimension === "共情程度")?.score ?? 1;
  const avgEmotionScore = subjectiveMetrics.emotionCurve.length
    ? Number(
        (
          subjectiveMetrics.emotionCurve.reduce((sum, row) => sum + row.emotionScore, 0) /
          subjectiveMetrics.emotionCurve.length
        ).toFixed(1),
      )
    : 0;
  const interestDeclineRisk =
    subjectiveMetrics.signals.find((item) => item.signalKey === "interestDeclineRisk")?.severity ?? "low";
  const understandingBarrierRisk =
    subjectiveMetrics.signals.find((item) => item.signalKey === "understandingBarrierRisk")?.severity ?? "low";
  const recoveryFailureRisk =
    subjectiveMetrics.signals.find((item) => item.signalKey === "emotionRecoveryFailureRisk")?.severity ?? "low";
  const goalCompletionTotal = subjectiveMetrics.goalCompletions.length;
  const achievedGoalCount = subjectiveMetrics.goalCompletions.filter((item) => item.status === "achieved").length;
  const failedGoalCount = subjectiveMetrics.goalCompletions.filter((item) => item.status === "failed").length;
  const goalCompletionRate = goalCompletionTotal
    ? Math.round((achievedGoalCount / goalCompletionTotal) * 100)
    : 0;
  const completedRecoveryCount = subjectiveMetrics.recoveryTraces.filter((item) => item.status === "completed").length;
  const failedRecoveryCount = subjectiveMetrics.recoveryTraces.filter((item) => item.status === "failed").length;

  return [
    `P0：当前平均情绪分为 ${avgEmotionScore}，其中 ${lowEmotionTurns} 个轮次低于 40 分，建议在低谷后两轮内强制触发共情确认与恢复性追问。`,
    `P0：当前目标达成率为 ${goalCompletionRate}% ，共有 ${failedGoalCount} 个 session 明确未达成，建议优先把这些 bad case 编译为调优包并加入回放回归。`,
    `P0：平均响应间隔为 ${Math.round(objectiveMetrics.avgResponseGapSec)} 秒，建议首轮确认性回复压缩到 20 秒内，并监控长间隔后的 topic 延续判断。`,
    `P1：当前 topic segment 切换共 ${switchCount} 次，建议在切段前加入“主题确认句”，减少无意跳转。`,
    `P1：用户主动提问 ${userQuestions} 次；理解障碍风险为 ${understandingBarrierRisk}，建议执行“先回答、再扩展”的固定顺序。`,
    `P1：当前识别到 ${completedRecoveryCount} 条成功恢复轨迹、${failedRecoveryCount} 条失败恢复轨迹，建议沉淀成功修复话术并对失败片段生成 remediation spec。`,
    `P1：兴趣衰减风险为 ${interestDeclineRisk}、情绪恢复失败风险为 ${recoveryFailureRisk}，建议把信号层直接接入策略触发器。`,
    `P2：当前共情维度得分 ${empathy}/5，建议继续沉淀 segment 级证据片段，提升主观评估的可解释性。`,
  ];
}
