/**
 * @fileoverview Rule-first topic segmentation with optional long-gap LLM review.
 */

import { parseJsonObjectFromLlmOutput, requestSiliconFlowChatCompletion } from "@/lib/siliconflow";
import { mapWithConcurrency, resolvePositiveInteger } from "@/lib/concurrency";
import { buildVersionedJudgeSystemPrompt } from "@/llm/judgeProfile";
import type { FieldSource, NormalizedChatlogRow, TopicSegment } from "@/types/pipeline";

const LONG_GAP_REVIEW_SEC = 180;
const DEFAULT_TOPIC_SEGMENT_CONCURRENCY = 4;
const EXPLICIT_CONTINUATION_PATTERN = /(继续|接着|上次|还记得|再来一次|今晚继续|刚才|那个故事)/;
const TOPIC_SWITCH_PATTERN = /(这个|上面|刚才|还有|另外|再问|换个|ok\s*那|OK\s*那)/;
const NEGATIVE_TOPIC_BREAK_PATTERN = /(错了|不对|不是|不行|重来|换一个|没回答|没解决|答非所问)/;

type RuleTopicCandidate = {
  label: string;
  domain: string;
  confidence: number;
};

type MutableTopicSegment = {
  sessionId: string;
  topicSegmentIndex: number;
  rows: NormalizedChatlogRow[];
  sources: FieldSource[];
  confidences: number[];
};

type ContinuityJudgePayload = {
  isContinuation?: boolean;
  confidence?: number;
  reason?: string;
};

/**
 * Build topic segments for all sessions.
 * @param rows Normalized chat rows.
 * @param useLlm Whether long-gap continuity review can call the LLM.
 * @returns Structured topic segments.
 */
export async function buildTopicSegments(
  rows: NormalizedChatlogRow[],
  useLlm: boolean,
  runId?: string,
): Promise<TopicSegment[]> {
  const grouped = new Map<string, NormalizedChatlogRow[]>();
  rows.forEach((row) => {
    if (!grouped.has(row.sessionId)) {
      grouped.set(row.sessionId, []);
    }
    grouped.get(row.sessionId)?.push(row);
  });

  const sessionSegments = await mapWithConcurrency(
    [...grouped.entries()],
    resolveTopicSegmentConcurrency(),
    ([sessionId, sessionRows]) => buildSessionTopicSegments(sessionId, sessionRows, useLlm, runId),
  );

  return sessionSegments.flat();
}

/**
 * Resolve bounded cross-session topic segmentation concurrency.
 * Per-session segmentation remains ordered because each decision can depend on
 * the active segment; different sessions can run independently.
 *
 * @returns Positive concurrency limit.
 */
function resolveTopicSegmentConcurrency(): number {
  return resolvePositiveInteger(
    process.env.ZEVAL_JUDGE_TOPIC_CONCURRENCY ?? process.env.ZEVAL_JUDGE_GLOBAL_CONCURRENCY,
    DEFAULT_TOPIC_SEGMENT_CONCURRENCY,
  );
}

/**
 * Segment rows by topic using rules only.
 *
 * @param rows Normalized rows.
 * @returns Topic segments without LLM continuity review.
 */
export function segmentByTopic(rows: NormalizedChatlogRow[]): TopicSegment[] {
  const grouped = new Map<string, NormalizedChatlogRow[]>();
  rows.forEach((row) => {
    grouped.set(row.sessionId, [...(grouped.get(row.sessionId) ?? []), row]);
  });
  return [...grouped.entries()].flatMap(([sessionId, sessionRows]) => buildSessionTopicSegmentsByRule(sessionId, sessionRows));
}

/**
 * Build topic segments for one session.
 * @param sessionId Session identifier.
 * @param rows Session rows in turn order.
 * @param useLlm Whether long-gap continuity review can call the LLM.
 * @returns Topic segments for the session.
 */
async function buildSessionTopicSegments(
  sessionId: string,
  rows: NormalizedChatlogRow[],
  useLlm: boolean,
  runId?: string,
): Promise<TopicSegment[]> {
  if (rows.length === 0) {
    return [];
  }

  const segments: MutableTopicSegment[] = [];
  let activeSegment = createMutableSegment(sessionId, 1, rows[0], "rule");

  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    const previousRow = rows[index - 1];
    const gapSec =
      row.timestampMs !== null && previousRow.timestampMs !== null
        ? Math.max(0, Math.round((row.timestampMs - previousRow.timestampMs) / 1000))
        : null;

    const currentCandidate = inferRuleTopicCandidate(row.content);
    const previousCandidate = summarizeSegmentCandidate(activeSegment.rows);
    const explicitContinuation = EXPLICIT_CONTINUATION_PATTERN.test(row.content);
    const ruleShouldSplit = shouldSplitByRule(previousCandidate, currentCandidate, row);
    let shouldSplit = ruleShouldSplit;
    let decisionSource: FieldSource = ruleShouldSplit ? "rule" : "fallback";

    if (gapSec !== null && gapSec >= LONG_GAP_REVIEW_SEC && useLlm && !explicitContinuation) {
      const llmDecision = await reviewLongGapTopicContinuation(activeSegment.rows, row, currentCandidate, gapSec, {
        runId,
        sessionId,
      });
      shouldSplit = !llmDecision.isContinuation;
      decisionSource = "llm";
      activeSegment.confidences.push(llmDecision.confidence);
    } else if (explicitContinuation) {
      shouldSplit = false;
      decisionSource = "rule";
    } else if (!ruleShouldSplit) {
      decisionSource = "rule";
    }

    if (shouldSplit) {
      activeSegment.sources.push(decisionSource);
      segments.push(activeSegment);
      activeSegment = createMutableSegment(sessionId, segments.length + 1, row, decisionSource);
      continue;
    }

    activeSegment.rows.push(row);
    activeSegment.sources.push(decisionSource);
    activeSegment.confidences.push(currentCandidate.confidence);
  }

  segments.push(activeSegment);

  return segments.map((segment) => finalizeTopicSegment(segment));
}

function buildSessionTopicSegmentsByRule(sessionId: string, rows: NormalizedChatlogRow[]): TopicSegment[] {
  if (rows.length === 0) {
    return [];
  }
  const segments: MutableTopicSegment[] = [];
  let activeSegment = createMutableSegment(sessionId, 1, rows[0], "rule");
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    const shouldSplit = shouldSplitByRule(
      summarizeSegmentCandidate(activeSegment.rows),
      inferRuleTopicCandidate(row.content),
      row,
    );
    if (shouldSplit) {
      activeSegment.sources.push("rule");
      segments.push(activeSegment);
      activeSegment = createMutableSegment(sessionId, segments.length + 1, row, "rule");
      continue;
    }
    activeSegment.rows.push(row);
    activeSegment.sources.push("rule");
  }
  segments.push(activeSegment);
  return segments.map(finalizeTopicSegment);
}

/**
 * Create a mutable topic segment buffer.
 * @param sessionId Session identifier.
 * @param topicSegmentIndex Segment index within the session.
 * @param row First row in the segment.
 * @param source Field source for the first decision.
 * @returns Mutable segment.
 */
function createMutableSegment(
  sessionId: string,
  topicSegmentIndex: number,
  row: NormalizedChatlogRow,
  source: FieldSource,
): MutableTopicSegment {
  const candidate = inferRuleTopicCandidate(row.content);
  return {
    sessionId,
    topicSegmentIndex,
    rows: [row],
    sources: [source],
    confidences: [candidate.confidence],
  };
}

/**
 * Finalize a mutable segment into the public contract.
 * @param segment Mutable segment buffer.
 * @returns Stable topic segment.
 */
function finalizeTopicSegment(segment: MutableTopicSegment): TopicSegment {
  const candidate = summarizeSegmentCandidate(segment.rows);
  const topicSource = segment.sources.includes("llm") ? "llm" : "rule";
  const topicConfidence = Number(
    (segment.confidences.reduce((sum, confidence) => sum + confidence, 0) / segment.confidences.length).toFixed(2),
  );
  const startTurn = segment.rows[0]?.turnIndex ?? 1;
  const endTurn = segment.rows[segment.rows.length - 1]?.turnIndex ?? startTurn;

  return {
    sessionId: segment.sessionId,
    topicSegmentId: `${segment.sessionId}_topic_${segment.topicSegmentIndex}`,
    topicSegmentIndex: segment.topicSegmentIndex,
    topicLabel: candidate.label,
    topicSummary: buildTopicSummary(candidate.label, segment.rows),
    topicSource,
    topicConfidence,
    startTurn,
    endTurn,
    messageCount: segment.rows.length,
    emotionPolarity: "neutral",
    emotionIntensity: "medium",
    emotionLabel: "中性-中强度",
    emotionBaseScore: 50,
    emotionScore: 50,
    emotionEvidence: "待情绪模块补全",
    emotionSource: "fallback",
    emotionConfidence: 0.4,
    emotionValenceWeight: 0,
    emotionLengthWeight: 0,
    emotionStyleWeight: 0,
    emotionGapWeight: 0,
    emotionRecoveryWeight: 0,
    emotionRiskPenalty: 0,
  };
}

/**
 * Decide whether two adjacent rows should be split by rules only.
 * @param previousCandidate Current segment candidate.
 * @param currentCandidate Current row candidate.
 * @param row Current row.
 * @returns Whether the segment should be split.
 */
function shouldSplitByRule(
  previousCandidate: RuleTopicCandidate,
  currentCandidate: RuleTopicCandidate,
  row: NormalizedChatlogRow,
): boolean {
  const { content, role } = row;
  if (role === "user" && (TOPIC_SWITCH_PATTERN.test(content) || NEGATIVE_TOPIC_BREAK_PATTERN.test(content))) {
    return true;
  }
  if (previousCandidate.domain === currentCandidate.domain) {
    return false;
  }

  if (role === "user" && /(扮演|练习|模拟|继续讲|剧情|口令|模板|先找|先读)/.test(content)) {
    return true;
  }

  if (isCompatibleDomain(previousCandidate.domain, currentCandidate.domain)) {
    return false;
  }

  if (currentCandidate.domain === "casual") {
    return false;
  }

  if (role === "assistant" && !/(模板|最后一步|下次|关掉手机|继续钟楼线)/.test(content)) {
    return false;
  }

  if (currentCandidate.domain === "wrap_up") {
    return /(模板|最后一步|明天|休息|下次|关掉手机|继续钟楼线)/.test(content);
  }

  if (/(扮演|练习|模拟|继续讲|剧情|口令|模板|先找|先读)/.test(content)) {
    return true;
  }

  return currentCandidate.confidence >= 0.84;
}

/**
 * Review long-gap continuity with the LLM.
 * @param previousRows Rows in the current active segment.
 * @param nextRow Current row after the long gap.
 * @param currentCandidate Rule topic candidate for the current row.
 * @param gapSec Gap size in seconds.
 * @returns Whether the topic continues.
 */
async function reviewLongGapTopicContinuation(
  previousRows: NormalizedChatlogRow[],
  nextRow: NormalizedChatlogRow,
  currentCandidate: RuleTopicCandidate,
  gapSec: number,
  context: {
    runId?: string;
    sessionId: string;
  },
): Promise<{ isContinuation: boolean; confidence: number }> {
  const previousExcerpt = previousRows
    .slice(-4)
    .map((row) => `[turn ${row.turnIndex}] [${row.role}] ${row.content}`)
    .join("\n");

  const rawResponse = await requestSiliconFlowChatCompletion(
    [
      {
        role: "system",
        content: buildVersionedJudgeSystemPrompt("topic_continuity_review", [
          "你是对话预处理模块中的 topic continuity judge。",
          "请判断长时间间隔后的新消息，是否仍然延续前一个 topic segment。",
          "你只输出 JSON，不要输出 markdown，不要解释。",
          '输出格式：{"isContinuation":true,"confidence":0.82,"reason":"..."}',
        ]),
      },
      {
        role: "user",
        content: [
          `长间隔：${gapSec} 秒`,
          `当前规则候选 topic：${currentCandidate.label}`,
          "前一 topic segment 末尾消息：",
          previousExcerpt,
          "长间隔后的当前消息：",
          `[turn ${nextRow.turnIndex}] [${nextRow.role}] ${nextRow.content}`,
          "请判断：当前消息是否仍在延续前一 topic segment？",
        ].join("\n\n"),
      },
    ],
    {
      stage: "topic_continuity_review",
      runId: context.runId,
      sessionId: context.sessionId,
    },
  );

  const parsed = parseJsonObjectFromLlmOutput(rawResponse) as ContinuityJudgePayload;
  return {
    isContinuation: Boolean(parsed.isContinuation),
    confidence: clampConfidence(parsed.confidence ?? 0.72),
  };
}

/**
 * Summarize one segment into a rule topic candidate.
 * @param rows Segment rows.
 * @returns Stable rule topic candidate.
 */
function summarizeSegmentCandidate(rows: NormalizedChatlogRow[]): RuleTopicCandidate {
  const scored = rows.reduce<Map<string, { label: string; domain: string; score: number }>>((acc, row) => {
    const candidate = inferRuleTopicCandidate(row.content);
    const key = candidate.domain;
    const current = acc.get(key);
    if (!current) {
      acc.set(key, { label: candidate.label, domain: candidate.domain, score: candidate.confidence });
      return acc;
    }
    current.score += candidate.confidence;
    return acc;
  }, new Map());

  const best = [...scored.values()].sort((left, right) => right.score - left.score)[0];
  if (!best) {
    return inferRuleTopicCandidate(rows[0]?.content ?? "");
  }

  return {
    label: best.label,
    domain: best.domain,
    confidence: clampConfidence(best.score / Math.max(1, rows.length)),
  };
}

/**
 * Infer a rule-first topic candidate from one message.
 * @param content Message content.
 * @returns Topic candidate.
 */
export function inferRuleTopicCandidate(content: string): RuleTopicCandidate {
  if (/(守夜人|蒸汽城|钟楼|钥匙|守卫|旅者|铜门|档案室|地图)/.test(content)) {
    return { label: "剧情角色扮演", domain: "story_roleplay", confidence: 0.95 };
  }
  if (/(扮演|练习|模拟|台词|回答|口令|重复|样本小|备用方案)/.test(content)) {
    return { label: "训练演练", domain: "practice", confidence: 0.92 };
  }
  if (/(失眠|闭眼|胸口|四拍呼吸|焦虑|停不下来)/.test(content)) {
    return { label: "失眠与焦虑安抚", domain: "anxiety_relief", confidence: 0.91 };
  }
  if (/(主管|方案|汇报|客户|项目|工作|复盘|转化|否定|逻辑散)/.test(content)) {
    return { label: "工作压力与沟通", domain: "work_stress", confidence: 0.9 };
  }
  if (/(模板|明天|休息|下次|记录|关掉手机|最后一步|继续钟楼线)/.test(content)) {
    return { label: "行动收尾", domain: "wrap_up", confidence: 0.88 };
  }
  if (/(难受|怀疑|委屈|很差|不行|害怕|信任|陪你|支持|正常)/.test(content)) {
    return { label: "情绪倾诉与安抚", domain: "emotion_support", confidence: 0.82 };
  }
  return { label: "开场连接", domain: "casual", confidence: 0.42 };
}

/**
 * Build a readable topic summary for one segment.
 * @param label Segment label.
 * @param rows Rows within the segment.
 * @returns Topic summary.
 */
function buildTopicSummary(label: string, rows: NormalizedChatlogRow[]): string {
  const firstUserMessage = rows.find((row) => row.role === "user")?.content ?? rows[0]?.content ?? "";
  const excerpt = firstUserMessage.slice(0, 20);
  return excerpt ? `${label}：${excerpt}` : label;
}

/**
 * Check whether two rule domains are compatible inside one topic segment.
 * @param left Left domain.
 * @param right Right domain.
 * @returns Whether the domains can stay in one segment.
 */
function isCompatibleDomain(left: string, right: string): boolean {
  const key = `${left}:${right}`;
  return new Set([
    "work_stress:emotion_support",
    "emotion_support:work_stress",
    "anxiety_relief:emotion_support",
    "emotion_support:anxiety_relief",
    "casual:emotion_support",
    "emotion_support:casual",
    "practice:work_stress",
    "work_stress:practice",
    "practice:emotion_support",
    "emotion_support:practice",
    "story_roleplay:casual",
    "casual:story_roleplay",
  ]).has(key);
}

/**
 * Clamp confidence values to the 0-1 range.
 * @param confidence Raw confidence.
 * @returns Safe confidence.
 */
function clampConfidence(confidence: number): number {
  return Math.max(0, Math.min(1, Number(confidence.toFixed(2))));
}
