/**
 * @fileoverview Bilingual (zh/en) copy dictionary for the public landing page.
 */

export type Locale = "zh" | "en";

export type LandingCapability = {
  eyebrow: string;
  title: string;
  description: string;
  bullets: string[];
};

export type LandingLoopStep = {
  step: string;
  description: string;
};

export type LandingOutcome = {
  title: string;
  text: string;
};

export type LandingTestimonial = {
  quote: string;
  author: string;
};

export type LandingFaqItem = {
  question: string;
  answer: string;
};

export type LandingHeroStat = {
  label: string;
  value: string;
};

export type LandingCopy = {
  nav: { label: string; href: string }[];
  ctaPrimary: string;
  ctaSecondary: string;
  ctaLogin: string;
  langSwitch: { label: string; switchTo: string };
  trustHeader: string;
  trustLogos: string[];
  hero: {
    eyebrow: string;
    headline: { line1: string; line2Pre: string; accent: string; line2Post: string };
    lead: { intro: string; bold: string; outro: string };
    stats: LandingHeroStat[];
  };
  capabilitiesSection: { eyebrow: string; title: string; lead: string };
  capabilities: LandingCapability[];
  loopSection: { eyebrow: string; title: string };
  loopSteps: LandingLoopStep[];
  outcomesSection: { eyebrow: string; title: string };
  outcomes: LandingOutcome[];
  testimonialsSection: { eyebrow: string; title: string };
  testimonials: LandingTestimonial[];
  faqSection: { eyebrow: string; title: string };
  faq: LandingFaqItem[];
  cta: { eyebrow: string; title: string; lead: string };
  footer: {
    tagline: string;
    columns: {
      product: { title: string; links: { label: string; href: string }[] };
      resources: { title: string; links: { label: string; href: string }[] };
      company: { title: string; links: { label: string; href: string }[] };
    };
    copyright: (year: number) => string;
    builtFor: string;
  };
};

const ZH: LandingCopy = {
  nav: [
    { label: "Docs", href: "/docs" },
    { label: "Pricing", href: "/pricing" },
    { label: "Blog", href: "/blog" },
    { label: "About", href: "/about" },
  ],
  ctaPrimary: "联系我们",
  ctaSecondary: "进入工作台",
  ctaLogin: "登录",
  langSwitch: { label: "中", switchTo: "EN" },
  trustHeader: "正在服务的 Agent 产品类型",
  trustLogos: [
    "AI Team · ToB 客服",
    "AI Team · 情绪陪伴",
    "AI Team · 电商客服",
    "AI Team · 内网 IT",
    "AI Team · 教研助手",
  ],
  hero: {
    eyebrow: "AI Quality Loop · For Agent Products",
    headline: {
      line1: "每一次失败对话，",
      line2Pre: "都是下一次发版前的",
      accent: "测试",
      line2Post: "。",
    },
    lead: {
      intro: "ZERORE 不是再做一个 eval dashboard。它把真实 bad case 自动编译为",
      bold: " 证据、调优包和回归验证",
      outro: "，让 AI 产品的每次失败都进入下一次发版前的质量闭环。",
    },
    stats: [
      { label: "核心闭环", value: "发现 → 证据 → 调优包 → 回放" },
      { label: "当前接入", value: "CSV · JSON · TXT · MD" },
      { label: "判定策略", value: "规则优先 · LLM 兜底" },
      { label: "治理层", value: "κ 一致性 · drift 检测" },
    ],
  },
  capabilitiesSection: {
    eyebrow: "Capabilities",
    title: "从真实对话问题，到可执行的修复任务。",
    lead: "ZERORE 把每一次失败会话变成一个带证据的修复任务，直接对接 Claude Code / Codex 的 agent 执行能力。",
  },
  capabilities: [
    {
      eyebrow: "01 / Evidence",
      title: "每一个问题都带证据、原因、置信度",
      description:
        "不止一个分数。每条 bad case 都附带 evidence 片段、触发规则、原因解释和置信度，让产品和工程同屏对齐。",
      bullets: [
        "规则优先 + LLM 兜底的混合判定",
        "goalCompletion、recoveryTrace 贯穿 session",
        "answerOffTopic / empathy / giveup 等信号可追溯",
      ],
    },
    {
      eyebrow: "02 / Agent-ready package",
      title: "Bad case 自动编译为 Agent 可读调优包",
      description:
        "issue-brief.md、remediation-spec.yaml、badcases.jsonl、acceptance-gate.yaml 四件套，直接交给 Claude Code / Codex 执行。",
      bullets: [
        "优先级 P0/P1/P2 自动判级",
        "编辑范围收敛到 prompt / policy / orchestration / code",
        "目标指标与 guard 阈值一起打包",
      ],
    },
    {
      eyebrow: "03 / Replay & sandbox",
      title: "修完是否变好，由回放和沙箱说了算",
      description:
        "baseline replay 按 winRate 判胜负、固定 sample batch 控回归、后续沙箱场景套件补 SLA。任何指标回退都不会通过门禁。",
      bullets: [
        "Replay gate + offline eval 双校验",
        "改动前后的 KPI 均分可对比",
        "guard 触发即 fail，避免“看起来变好了”",
      ],
    },
    {
      eyebrow: "04 / Judge governance",
      title: "Judge 自身也被校准和漂移监测",
      description:
        "gold set + 多标注人一致性（Cohen κ / Spearman）+ 漂移检测脚本，让评估本身可被审计，不是黑盒打分。",
      bullets: [
        "calibration:judge / agreement / drift 三条 CLI",
        "报告留痕到 calibration/reports/",
        "CI 回归门禁（规划中）",
      ],
    },
  ],
  loopSection: {
    eyebrow: "The Loop",
    title: "每个失败，都应该进入下一次发版前的验证链路。",
  },
  loopSteps: [
    { step: "发现问题", description: "定位失败会话、死亡轮次、情绪低谷和高风险信号。" },
    { step: "提取证据", description: "为每个问题输出 evidence、reason、confidence 和触发指标。" },
    { step: "生成调优包", description: "把 bad case、验收门槛和修复目标编译成结构化任务文件。" },
    { step: "交给 agent 执行", description: "让 Claude Code / Codex 基于调优包改 prompt、policy、orchestration 或代码。" },
    { step: "回放 / 沙箱验证", description: "用 replay、固定批次和 sandbox 证明这次修复真的变好。" },
  ],
  outcomesSection: { eyebrow: "Outcomes", title: "交付的不是报告本身，而是下一步动作。" },
  outcomes: [
    { title: "给产品经理", text: "从“感觉这版好像变好了”切到“哪一轮出了问题、改完是否回升”。" },
    { title: "给工程师", text: "把失败会话直接变成可执行的修复任务和回归门槛，而不是只看一屏图表。" },
    { title: "给创始人", text: "把坏体验沉淀成长期资产，让每次失败都能变成下次发版前的测试。" },
  ],
  testimonialsSection: { eyebrow: "Testimonials", title: "已经把质量闭环跑通的团队怎么说。" },
  testimonials: [
    {
      quote: "以前我们 release 前只靠研发凭感觉看几条对话；用 ZERORE 之后每次发版都带着一份由调优包证明过的回归报告。",
      author: "产品负责人 · ToB 客服 Agent",
    },
    {
      quote: "最关键的不是指标，是它把“哪一轮为什么失败”说清楚了。我们的 agent 迭代第一次有了可执行 checklist。",
      author: "Tech Lead · 情绪陪伴产品",
    },
  ],
  faqSection: { eyebrow: "FAQ", title: "常见问题" },
  faq: [
    {
      question: "ZERORE 和传统 eval 平台有什么区别？",
      answer:
        "传统 eval 提供的是“给定数据集 + 给定指标”的打分面板。ZERORE 的出发点是生产 bad case → 证据包 → 调优任务 → 回放验证的闭环，面向的是“下一次发版前把这次问题修掉”。",
    },
    {
      question: "需要接入内部系统吗？",
      answer:
        "不用。最低支持 CSV / JSON / TXT / MD 的对话日志直接上传。在接入 SDK 或 OpenTelemetry GenAI 语义后可以自动采集生产 trace。",
    },
    {
      question: "LLM judge 的稳定性如何保障？",
      answer:
        "我们提供 gold set + 多标注人一致性 + drift 检测三件套。任何 judge 切换都必须先过 κ/Spearman 阈值，报告留痕可审计。",
    },
    {
      question: "调优包如何交给 Agent 执行？",
      answer:
        "每个调优包都是 4 个标准文件（issue-brief.md / remediation-spec.yaml / badcases.jsonl / acceptance-gate.yaml），可以直接粘贴到 Claude Code / Codex 的任务提示里，或通过我们的 agent-run 接口派发。",
    },
    {
      question: "支持私有化部署吗？",
      answer:
        "支持。核心 pipeline 是纯 Node/Next 本地代码，判定/召回层可以对接自建模型；数据留痕都是本地 artifact 文件，后续会接 SQLite + 异步队列。",
    },
  ],
  cta: {
    eyebrow: "Less dashboards. More fixes.",
    title: "不要再靠感觉发版。",
    lead: "把一批真实对话带进来，让 ZERORE 自动告诉你哪一轮出了问题、怎么修、改完是否真的变好。",
  },
  footer: {
    tagline: "AI Quality Loop For Agent Products",
    columns: {
      product: {
        title: "产品",
        links: [
          { label: "工作台", href: "/workbench" },
          { label: "调优包", href: "/remediation-packages" },
          { label: "案例池", href: "/datasets" },
          { label: "在线评测", href: "/online-eval" },
        ],
      },
      resources: {
        title: "资源",
        links: [
          { label: "Docs", href: "/docs" },
          { label: "Blog", href: "/blog" },
          { label: "Pricing", href: "/pricing" },
        ],
      },
      company: {
        title: "公司",
        links: [
          { label: "About", href: "/about" },
          { label: "联系我们", href: "/contact" },
          { label: "Privacy", href: "/privacy" },
          { label: "Terms", href: "/terms" },
        ],
      },
    },
    copyright: (year) => `© ${year} ZERORE · 保留所有权利。`,
    builtFor: "为构建 agent 产品的团队而生。",
  },
};

const EN: LandingCopy = {
  nav: [
    { label: "Docs", href: "/docs" },
    { label: "Pricing", href: "/pricing" },
    { label: "Blog", href: "/blog" },
    { label: "About", href: "/about" },
  ],
  ctaPrimary: "Talk to an expert",
  ctaSecondary: "Open workbench",
  ctaLogin: "Login",
  langSwitch: { label: "EN", switchTo: "中" },
  trustHeader: "Agent products already running the loop",
  trustLogos: [
    "AI Team · B2B Support",
    "AI Team · Emotional Companion",
    "AI Team · E-commerce Support",
    "AI Team · Internal IT",
    "AI Team · Education Assistant",
  ],
  hero: {
    eyebrow: "AI Quality Loop · For Agent Products",
    headline: {
      line1: "Every failed conversation",
      line2Pre: "becomes the next release's ",
      accent: "test",
      line2Post: ".",
    },
    lead: {
      intro: "ZERORE isn't another eval dashboard. It compiles real bad cases into",
      bold: " evidence, remediation packages, and regression checks",
      outro: ", so every failure feeds back into the quality loop before your next ship.",
    },
    stats: [
      { label: "Core loop", value: "Detect → Evidence → Package → Replay" },
      { label: "Inputs", value: "CSV · JSON · TXT · MD" },
      { label: "Judging", value: "Rules first · LLM fallback" },
      { label: "Governance", value: "κ agreement · drift checks" },
    ],
  },
  capabilitiesSection: {
    eyebrow: "Capabilities",
    title: "From real conversation problems to executable fix tasks.",
    lead: "ZERORE turns each failed session into an evidence-backed fix task that plugs directly into Claude Code / Codex.",
  },
  capabilities: [
    {
      eyebrow: "01 / Evidence",
      title: "Every issue ships with evidence, reason and confidence",
      description:
        "Not just a score. Each bad case carries evidence snippets, triggered rules, reasons, and confidence — so PMs and engineers see the same thing.",
      bullets: [
        "Hybrid judging: rules first, LLM as fallback",
        "goalCompletion and recoveryTrace tracked across sessions",
        "answerOffTopic / empathy / giveup signals are traceable",
      ],
    },
    {
      eyebrow: "02 / Agent-ready package",
      title: "Bad cases compile into agent-readable remediation packages",
      description:
        "Four files — issue-brief.md, remediation-spec.yaml, badcases.jsonl, acceptance-gate.yaml — handed off directly to Claude Code / Codex.",
      bullets: [
        "Auto-prioritized P0 / P1 / P2",
        "Edit scope scoped to prompt / policy / orchestration / code",
        "Target metrics and guard thresholds bundled in",
      ],
    },
    {
      eyebrow: "03 / Replay & sandbox",
      title: "Replay and sandbox decide whether the fix actually worked",
      description:
        "Baseline replay decides win-rate, fixed sample batches catch regressions, and sandbox suites cover SLAs. Any metric regression fails the gate.",
      bullets: [
        "Replay gate + offline eval double-check",
        "Side-by-side KPI deltas before and after",
        "Guard trips fail the gate — no 'feels better' shipping",
      ],
    },
    {
      eyebrow: "04 / Judge governance",
      title: "The judge itself is calibrated and drift-monitored",
      description:
        "Gold set + multi-rater agreement (Cohen κ / Spearman) + drift detection — evaluation becomes auditable, not a black-box score.",
      bullets: [
        "Three CLIs: calibration:judge / agreement / drift",
        "Reports persisted to calibration/reports/",
        "CI regression gating (planned)",
      ],
    },
  ],
  loopSection: {
    eyebrow: "The Loop",
    title: "Every failure should enter the gate before your next release.",
  },
  loopSteps: [
    { step: "Detect", description: "Surface failed sessions, dead turns, emotion troughs, and high-risk signals." },
    { step: "Extract evidence", description: "Output evidence, reason, confidence, and triggered metrics for each issue." },
    { step: "Compile package", description: "Bundle bad cases, acceptance gates, and fix targets into structured task files." },
    { step: "Hand to agent", description: "Let Claude Code / Codex modify prompt, policy, orchestration, or code from the package." },
    { step: "Replay / sandbox", description: "Use replay, fixed batches, and sandbox to prove the fix actually improved things." },
  ],
  outcomesSection: { eyebrow: "Outcomes", title: "What ships isn't a report — it's the next move." },
  outcomes: [
    { title: "For PMs", text: "Move from 'this version feels better' to 'which turn broke, and did the fix recover it'." },
    { title: "For engineers", text: "Failed sessions become executable fix tasks with regression gates, not another chart wall." },
    { title: "For founders", text: "Bad experiences become long-lived assets — every failure turns into a pre-release test." },
  ],
  testimonialsSection: { eyebrow: "Testimonials", title: "Teams already running the quality loop." },
  testimonials: [
    {
      quote:
        "Releases used to mean engineers eyeballing a few transcripts. With ZERORE every release ships with a regression report proven by a remediation package.",
      author: "Head of Product · B2B Support Agent",
    },
    {
      quote:
        "The metric isn't the point — it's the 'which turn failed and why' that finally clicks. Our agent iteration has a real checklist for the first time.",
      author: "Tech Lead · Emotional Companion product",
    },
  ],
  faqSection: { eyebrow: "FAQ", title: "Frequently asked" },
  faq: [
    {
      question: "How is ZERORE different from a traditional eval platform?",
      answer:
        "Traditional eval gives you a 'fixed dataset + fixed metric' scoreboard. ZERORE starts from production bad cases → evidence packs → fix tasks → replay verification — closing the loop on 'fix this before the next release'.",
    },
    {
      question: "Do I need to integrate internal systems?",
      answer:
        "No. The minimum path accepts CSV / JSON / TXT / MD chat logs uploaded directly. After SDK or OpenTelemetry GenAI integration, production traces stream in automatically.",
    },
    {
      question: "How is the LLM judge kept stable?",
      answer:
        "Gold set + multi-rater agreement + drift detection. Any judge swap must clear κ/Spearman thresholds first, with auditable reports.",
    },
    {
      question: "How does the agent execute the package?",
      answer:
        "Each package is four standard files (issue-brief.md / remediation-spec.yaml / badcases.jsonl / acceptance-gate.yaml). Paste them into Claude Code / Codex prompts, or dispatch through our agent-run API.",
    },
    {
      question: "Self-hosting?",
      answer:
        "Supported. The core pipeline is plain Node/Next code; the judging/recall layer can plug in self-hosted models. Artifacts persist locally; SQLite + async queue is on the roadmap.",
    },
  ],
  cta: {
    eyebrow: "Less dashboards. More fixes.",
    title: "Stop shipping on vibes.",
    lead: "Bring in real conversations and let ZERORE tell you which turn broke, how to fix it, and whether the fix actually worked.",
  },
  footer: {
    tagline: "AI Quality Loop For Agent Products",
    columns: {
      product: {
        title: "Product",
        links: [
          { label: "Workbench", href: "/workbench" },
          { label: "Remediation packages", href: "/remediation-packages" },
          { label: "Case pool", href: "/datasets" },
          { label: "Online eval", href: "/online-eval" },
        ],
      },
      resources: {
        title: "Resources",
        links: [
          { label: "Docs", href: "/docs" },
          { label: "Blog", href: "/blog" },
          { label: "Pricing", href: "/pricing" },
        ],
      },
      company: {
        title: "Company",
        links: [
          { label: "About", href: "/about" },
          { label: "Talk to an expert", href: "/contact" },
          { label: "Privacy", href: "/privacy" },
          { label: "Terms", href: "/terms" },
        ],
      },
    },
    copyright: (year) => `© ${year} ZERORE · All rights reserved.`,
    builtFor: "Built for teams that ship agent products.",
  },
};

export const LANDING_COPY: Record<Locale, LandingCopy> = { zh: ZH, en: EN };
