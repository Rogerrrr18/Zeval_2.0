/**
 * @fileoverview Predefined chart templates for MVP chart rendering.
 */

import type { ChartKey } from "@/types/pipeline";

/**
 * Template declaration used by backend schema filler.
 * Runtime values in params are replaced by aggregated outputs.
 */
export type ChartTemplate = {
  chartKey: ChartKey;
  title: string;
  chartType: "line" | "bar";
  schema: {
    xField: string;
    yField: string;
    seriesField?: string;
  };
  params: {
    dataSource: "enriched";
    groupBy: string[];
    aggregations: Array<{
      op: "count" | "avg" | "sum";
      field: string;
      as: string;
    }>;
    filters?: Array<{
      field: string;
      eq?: string | number | boolean;
      gte?: number;
      lte?: number;
    }>;
  };
};

/**
 * MVP default chart templates. Keep template count small and stable.
 */
export const CHART_TEMPLATES: ChartTemplate[] = [
  {
    chartKey: "emotionCurve",
    title: "情绪轨迹",
    chartType: "line",
    schema: {
      xField: "turnIndex",
      yField: "emotionScore",
      seriesField: "sessionId",
    },
    params: {
      dataSource: "enriched",
      groupBy: ["sessionId", "turnIndex"],
      aggregations: [{ op: "avg", field: "emotionScore", as: "emotionScore" }],
    },
  },
  {
    chartKey: "dropoffDistribution",
    title: "流失断点",
    chartType: "bar",
    schema: {
      xField: "turnIndex",
      yField: "dropoffCount",
    },
    params: {
      dataSource: "enriched",
      groupBy: ["turnIndex"],
      aggregations: [{ op: "count", field: "isDropoffTurn", as: "dropoffCount" }],
      filters: [{ field: "isDropoffTurn", eq: true }],
    },
  },
  {
    chartKey: "activeHourDistribution",
    title: "活跃时段",
    chartType: "bar",
    schema: {
      xField: "activeHour",
      yField: "messageCount",
      seriesField: "role",
    },
    params: {
      dataSource: "enriched",
      groupBy: ["activeHour", "role"],
      aggregations: [{ op: "count", field: "content", as: "messageCount" }],
    },
  },
  {
    chartKey: "topicSwitchFrequency",
    title: "话题切换",
    chartType: "bar",
    schema: {
      xField: "sessionId",
      yField: "topicSwitchCount",
    },
    params: {
      dataSource: "enriched",
      groupBy: ["sessionId"],
      aggregations: [{ op: "sum", field: "isTopicSwitch", as: "topicSwitchCount" }],
    },
  },
];
