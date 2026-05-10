/**
 * @fileoverview Build chart payloads from enriched rows and templates.
 */

import { CHART_TEMPLATES } from "@/config/chartTemplates";
import type { ChartPayload, EnrichedChatlogRow } from "@/types/pipeline";

/**
 * Build P0 chart payloads from enriched rows.
 * @param rows Enriched rows.
 * @returns Chart payload array for frontend rendering.
 */
export function buildChartPayloads(rows: EnrichedChatlogRow[]): ChartPayload[] {
  return CHART_TEMPLATES.map((template) => {
    if (template.chartKey === "emotionCurve") {
      return {
        chartKey: template.chartKey,
        title: template.title,
        description: "按会话与轮次呈现 100 分制情绪分，用于判断波动、恢复与 segment 质量。",
        chartType: template.chartType,
        xField: template.schema.xField,
        yField: template.schema.yField,
        seriesField: template.schema.seriesField,
        data: rows.map((row) => ({
          sessionId: row.sessionId,
          turnIndex: row.turnIndex,
          emotionScore: row.emotionScore,
        })),
      };
    }

    if (template.chartKey === "dropoffDistribution") {
      const distribution = rows
        .filter((row) => row.isDropoffTurn)
        .reduce<Record<string, number>>((acc, row) => {
          const key = String(row.turnIndex);
          acc[key] = (acc[key] ?? 0) + 1;
          return acc;
        }, {});
      return {
        chartKey: template.chartKey,
        title: template.title,
        description: "识别用户流失出现在哪些轮次，用于定位关键断点。",
        chartType: template.chartType,
        xField: template.schema.xField,
        yField: template.schema.yField,
        data: Object.entries(distribution).map(([turnIndex, dropoffCount]) => ({
          turnIndex: Number(turnIndex),
          dropoffCount,
        })),
      };
    }

    if (template.chartKey === "activeHourDistribution") {
      const distribution = rows.reduce<Record<string, number>>((acc, row) => {
        const key = `${row.activeHour ?? "unknown"}_${row.role}`;
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {});
      return {
        chartKey: template.chartKey,
        title: template.title,
        description: "查看不同时段与角色消息量，判断交互发生高峰。",
        chartType: template.chartType,
        xField: template.schema.xField,
        yField: template.schema.yField,
        seriesField: template.schema.seriesField,
        data: Object.entries(distribution).map(([key, messageCount]) => {
          const [activeHour, role] = key.split("_");
          return {
            activeHour,
            role,
            messageCount,
          };
        }),
      };
    }

    const sessionDistribution = rows
      .filter((row) => row.isTopicSwitch)
      .reduce<Record<string, number>>((acc, row) => {
        acc[row.sessionId] = (acc[row.sessionId] ?? 0) + 1;
        return acc;
      }, {});
    const sessionIds = [...new Set(rows.map((row) => row.sessionId))];

    return {
      chartKey: template.chartKey,
      title: template.title,
      description: "统计每个会话中的话题跳转次数，判断对话连贯度。",
      chartType: template.chartType,
      xField: template.schema.xField,
      yField: template.schema.yField,
      data: sessionIds.map((sessionId) => ({
        sessionId,
        topicSwitchCount: sessionDistribution[sessionId] ?? 0,
      })),
    };
  });
}
