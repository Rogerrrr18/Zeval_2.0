# 12-调优包 Skill 化交付

调优包从原来的“四件套文档”升级为可在客户侧 IDE/Agent 内执行的 Skill 文件夹模板。客户不再需要把 issue-brief 等文档手动喂给 Agent，只需安装 Skill，在 Claude Code / Codex / Cursor 等 IDE 中触发执行即可完成单次调优，用完即弃。

## 12.1 设计目标

1. 一次评估 → 一份 Skill：每个 `remediation_packages.id` 对应一个可独立分发的 Skill 文件夹。
2. 客户侧零状态：Skill 不在客户仓库中长期保留，运行完成后客户可直接删除文件夹。
3. 通用 IDE 兼容：Skill 必须能被 Claude Code、Codex、Cursor 等支持 SKILL.md 协议或类似机制的 Agent 读取并执行。
4. 不暴露 Zeval 内部实现：Skill 内文档使用业务语义文案，不展示模型名、prompt 版本、内部 stage。
5. 完整可追溯：Skill 内包含 evaluation_run_id、badcase_ids、触发指标 key，便于客户回到 Zeval 复核来源。

## 12.2 Skill 包结构

每个调优包导出为下述结构的文件夹，文件夹名建议 `zeval-remediation-{packageId}`：

```
zeval-remediation-{packageId}/
├─ SKILL.md                 # 入口说明 + 触发指令 + Agent 行动剧本
├─ issue-brief.md           # 问题摘要、影响范围、触发指标与证据
├─ remediation-spec.yaml    # 修复规范：目标、约束、步骤、验收
├─ badcases.jsonl           # 负例集合：transcript、标签、来源 evaluation_run_id
├─ acceptance-gate.yaml     # 验收门槛：客观/主观/隐式信号阈值与回归用例 ID
├─ prompts/
│  ├─ system-prompt.md      # 推荐的系统 prompt 调整建议（可选）
│  └─ user-prompt.md        # 推荐的用户 prompt 模板（可选）
├─ scripts/
│  ├─ run.md                # Agent 触发剧本（自然语言步骤）
│  └─ verify.md             # 验证步骤（如何用客户侧 harness 复跑）
└─ metadata.json            # Skill 元数据：版本、来源、签发时间、作用域
```

### 12.2.1 SKILL.md 必填字段

```markdown
# Zeval 调优包 · 退款流程优化

## description
{1–2 句话说明这个调优包修哪类问题；用业务语义。}

## triggers
- "运行调优包 zeval-remediation-{packageId}"
- "执行 Zeval 退款流程优化"

## inputs
- 客户当前 Agent 系统 prompt
- 客户当前回复 API 或 harness 入口
- （可选）最近一次评估 / baseline 引用

## actions
1. 读取本目录 issue-brief.md 与 remediation-spec.yaml。
2. 按 remediation-spec.yaml 中的 steps 修改客户侧 Agent 配置或 prompt。
3. 运行 scripts/verify.md 中的回归用例。
4. 汇报每个 acceptance-gate 是否通过。

## outputs
- 修改后的 prompt / 配置 diff
- 回归用例运行结果
- 未达成的 acceptance-gate 列表（如有）
```

`description / triggers / actions` 三段是 Claude Code / Cursor Skills 协议中常见的关键字段，必须保留。

### 12.2.2 metadata.json 字段

```json
{
  "skillVersion": "1.0.0",
  "packageId": "rp_xxx",
  "evaluationRunIds": ["evr_xxx"],
  "scopeBadCaseIds": ["case_xxx"],
  "triggerMetricKeys": ["interestDeclineRisk", "empathyScore"],
  "capabilityDimension": "multi_turn_coherence",
  "targetFailureLayer": "L3_memory",
  "experimentRouteId": "expr_xxx",
  "issuedAt": "2026-05-08T00:00:00.000Z",
  "issuer": "Zeval",
  "expiresAt": null,
  "expectedClient": ["claude-code", "codex", "cursor"]
}
```

`capabilityDimension`、`targetFailureLayer`、`experimentRouteId` 三个字段必填（详见 [`15-能力维度评测与归因.md`](./15-能力维度评测与归因.md)）：

- `capabilityDimension`：本调优包针对哪个能力维度。
- `targetFailureLayer`：本调优包修复的 harness 层。客户在 IDE 中触发时，Agent 据此决定改 prompt（L8）/ 改 tool schema（L5）/ 改 retrieval（L4）等不同动作剧本。
- `experimentRouteId`：本调优包来源的对照实验路由（如有）；客户复跑验证时引用同一组评测集。

## 12.3 客户侧使用方式

1. 在 Zeval 工作台或 API 中导出调优包，生成 `zeval-remediation-{packageId}` 文件夹（或 zip）。
2. 客户把文件夹放入 IDE 支持的 skills 目录，例如：
   - Claude Code：`~/.claude/skills/` 或仓库 `.claude/skills/`
   - Codex CLI：客户自定 skill 目录
   - Cursor：`~/.cursor/skills/` 或仓库 `.cursor/skills/`
3. 客户在 IDE 中向 Agent 说 “运行调优包 zeval-remediation-{packageId}”，Agent 按 SKILL.md 中的 `actions` 顺序执行。
4. 完成验收后，客户可直接删除文件夹（用完即弃）。
5. 若客户需要复跑，可重新从 Zeval 下载相同 packageId 的 Skill；Zeval 侧仍可生成新版本。

## 12.4 与现有 4 件套的关系

- 4 件套（issue-brief / remediation-spec / badcases / acceptance-gate）继续作为 Skill 内的核心文档保留。
- 新增 SKILL.md / metadata.json / scripts/ / prompts/ 是“可执行壳”，不改变 4 件套语义。
- 旧的纯文档导出方式继续支持，但不作为推荐路径。

## 12.5 服务端实现要求

### 12.5.1 数据模型

新增字段到 `remediation_packages`：

| 字段 | 用途 |
| --- | --- |
| `skill_version` | Skill 版本号，便于客户对账 |
| `skill_artifact_uri` | Skill 文件夹的 zip / tar 在 Supabase Storage 的存放路径 |
| `skill_metadata` | metadata.json 内容的 JSONB 副本 |

可在 `remediation_artifacts` 中新增类型：`skill_md / metadata_json / prompt_md / script_md`，用于把 Skill 内每个文件作为单条 artifact 持久化，便于审计与重新打包。

### 12.5.2 API

新增（与现有 `/api/remediation-packages/[id]` 同级）：

| 路由 | 方法 | 用途 |
| --- | --- | --- |
| `/api/remediation-packages/[id]/skill` | GET | 返回 Skill metadata 与下载 URL |
| `/api/remediation-packages/[id]/skill/download` | GET | 返回 zip / tar 文件流 |
| `/api/remediation-packages/[id]/skill/regenerate` | POST | 重新打包 Skill（如客户希望修改文档语气、调整阈值） |

下载响应建议：

```http
Content-Type: application/zip
Content-Disposition: attachment; filename="zeval-remediation-{packageId}-v{version}.zip"
```

### 12.5.3 触发模板

`SKILL.md` 中的 `triggers` 必须包含中文与英文两种形式，例如：

```
- "运行调优包 zeval-remediation-{packageId}"
- "Run Zeval remediation package {packageId}"
```

确保中英混用环境下都能命中。

## 12.6 安全与边界

- Skill 中不得包含 Zeval 数据库连接串、API Key、Supabase publishable key。
- Skill 中证据片段必须遵循 PII 最小披露：仅保留必要的对话上下文。
- Skill 不得读取客户仓库中未授权的目录；scripts/run.md 中的步骤需明确仅限于：
  - 修改 Agent 系统 prompt 或 prompt 模板。
  - 调用客户侧 harness 的回放接口。
  - 写入诊断日志到 `./.zeval-out/`（或客户指定目录）。

## 12.7 验收

1. 任一调优包都能导出为 Skill 文件夹，结构与 12.2 一致。
2. 任一 Skill 在 Claude Code / Codex / Cursor 中通过 `triggers` 中文或英文触发后，Agent 必须能按 `actions` 顺序执行并报告 acceptance-gate 结果。
3. Skill 在客户侧用完即弃后，再次下载相同 `packageId` 不会破坏服务端状态（接口幂等）。
4. Skill 不暴露任何 Zeval 内部模型名、prompt 版本号、stage 枚举值。
