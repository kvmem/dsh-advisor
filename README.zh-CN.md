# DSH Advisor

[English](README.md) | 简体中文

独立的、按需调用的 DeepSeek Harness 顾问工具。主模型调用 `ask_advisor`，人查看并批准本次完整请求，顾问返回文字建议，主模型继续执行。

源码仓库：[kvmem/dsh-advisor](https://github.com/kvmem/dsh-advisor)。这是 DeepSeek Harness 插件，复用 DSH 的模型、权限和审批服务。

**2026-09-08：已完成真实 DeepSeek Flash 主模型 → Pro 顾问调用，以及 Chromium 中的审批、编辑、拒绝、取消、超时和重启验收。** `0.1.1` 修复关闭审批卡被记为 `unavailable` 的问题，现在正确返回 `cancelled`。完整结果和实测边界见 [验收记录](ACCEPTANCE.md)。

`0.1.2` 扩展长回答支持。Flash/Pro 示例均配置 384,000 tokens，顾问正文接收上限为 16 MiB；实际单次输出仍受模型能力和上下文限制。插件通用默认值保持不变，只有显式使用该配置时才提高限制。

`0.1.3` 改善审批与顾问结果展示：审批按问题、目标、约束、尝试、证据分段；调用配置可另行查看。Web 中顾问结果先显示简短预览，支持展开完整建议及核对原文。新增随插件加载的系统提示，说明何时主动求助，以及发起本地审批与实际云端发送的区别。

`0.1.4` 支持直接在 **设置 → 插件 → 顾问模型** 中配置。首次安装可以不提供 provider/model；选择 DSH 已接入的服务和模型后保存即可使用，也支持手动填写未列出的模型 ID。保存、刷新和切换不会自动发起推理请求。模型接入范围跟随 DSH adapter，不限于 DeepSeek 或 OpenAI-compatible。

## 已实现

- 主模型明确提交问题、目标、约束、已尝试动作及结果，以及最多 8 项证据。
- 文件证据走已有 DSH `read` 工具的权限与执行管线；工具结果只能引用当前任务中已完成的调用。
- 按指定行范围提取纯文本，不自动附带整段会话、系统历史、图片或隐藏推理。
- 原生用户问题卡展示接收地址、provider/model、输出上限，以及实际发送的全部系统指令和求助文本。
- 可替换问题、目标、约束、尝试记录或单项证据内容，也可删除证据；修改后重新生成预览，再单独批准。
- 每次批准绑定不可变快照；通用自动允许、伪造 `approved` 参数、Code Mode 包装均不能省略该审批。
- 只调用一次 DSH `PreparedLlmCall.stream`，不自动重试或切换 provider。超时/中断后返回明确状态。
- 审计先持久化发送标记，再开始调用；同一任务、同一调用重入时复用已保存结果，或拒绝重复发送。

## 兼容范围

已验证 **Node 24、Linux、本地 POSIX 文件系统、DSH `0.1.3-alpha.2`**。依赖有意固定版本，因为用到了该版本的 `prepareCall`、工具执行 token、设置目录和原生审批服务；不承诺旧版 DSH 可用。

模型接入使用 DSH 的 `provider + model` 和 `ctx.llm.prepareCall`。插件没有自己的 HTTP 客户端，不管理模型部署，也不要求 OpenAI-compatible。DSH adapter 可使用自身支持的协议。

所选 provider 须在 `listConfigurableProviders()` 中登记，并且对应的 **DSH provider 配置须显式设置 `baseURL`**。地址不能含 URL 用户名、密码、查询参数或 fragment。凭证继续由 DSH 的 adapter/credentials 管理，不配置在本插件中。

例如，`llm-deepseek` 的配置根对象使用 `baseURL`；`llm-pi-ai` 的配置在 `providers.<你的 provider>.baseURL`。第三方 adapter 须遵守 DSH 的调用快照契约，且预处理不上传任务数据、单次 stream 不在内部自动重试。

## 构建与安装

```sh
git clone https://github.com/kvmem/dsh-advisor.git
cd dsh-advisor
npm ci
npm run check
npm pack
```

`check` 包含源码和测试的类型检查、集成测试，以及使用真实 Loader/Include 从 `cordis.yml` 加载构建产物的独立 Node 验证。测试通过受控 adapter 回答，不调用任何真实付费模型。

使用 Node 24 或更新版本，并准备 DSH 和其插件安装所需的 pnpm。在项目目录构建后安装并启动 Web 界面：

```sh
dsh plugin --profile web add "$PWD/dsh-tool-advisor-0.1.4.tgz"
dsh web
```

首次使用全部可以在界面完成：

1. 在 **设置 → 模型（Models）** 中添加或编辑模型服务，填写实际服务地址、API key 和模型信息。接入自定义 GLM、Qwen 或其他服务时，选择该服务支持且 DSH adapter 提供的协议；密钥由 DSH credentials 管理。
2. 在 **设置 → 插件（Plugins）→ 顾问模型** 选择模型服务、顾问模型并保存。也可手动填写模型 ID，但是否能直接使用由 adapter 决定；例如当前 Pi-ai adapter 要求先在 Models 中登记该模型。
3. “输出设置”可以调整单次输出预算；更换服务后须符合所选模型的限制。“启用顾问”可控制是否允许发起新的求助。

配置由 DSH 持久化，刷新页面、重启服务后仍保留。它不修改主任务选择的模型。每次求助继续逐次审批；待审批期间修改顾问配置会使旧快照失效，已发出的请求继续使用原快照。两个页面同时编辑时，过期草稿不能覆盖新配置，需要先重新载入。

随包的 `cordis.patch.yml` 插入 `advisor` 配置项。高级部署仍可用启动环境变量 `DSH_ADVISOR_PROVIDER` / `DSH_ADVISOR_MODEL` 设置初始值，或在 profile 的 patch 中提供：

```yaml
- id: advisor
  config:
    provider: your-existing-provider
    model: your-advisor-model
```

界面保存的 `advisor` 设置覆盖这些初始值。缺少目标时插件正常加载，界面可配置，工具返回 `not_configured` 并且不发送。模型服务不可用或没有显式 `baseURL` 时，同样不发送。

本地开发可直接加载构建文件：

```sh
dsh web --patch "$PWD/examples/local.cordis.patch.yml"
```

以上命令从源码仓库根目录运行；DSH 将示例中的 `../dist/index.js` 按 patch 文件位置解析，避免配置依赖特定机器上的目录。Flash 主模型、Pro 顾问的完整开发配置另见 [DeepSeek 示例](examples/deepseek-flash-pro.cordis.patch.yml)，使用模型 ID `deepseek-v4-flash`、`deepseek-v4-pro`。先通过 DSH 配置凭证或向启动进程提供 `DEEPSEEK_API_KEY`，再加载该 overlay；不要把密钥写入 patch：

```sh
dsh web --patch "$PWD/examples/deepseek-flash-pro.cordis.patch.yml" --no-open
```

该 DeepSeek 示例配置了较高的输出预算，实际输出受服务及模型限制。其他服务使用通用配置，并在 Models 页面登记模型。

请选择安装 bundle 或本地 overlay 中的一种，避免注册两个同名工具。Profile 必须已有 `tools`、`llm`、`settings`、`agents`、`approval`、`userQuestions`、`systemPrompt` 服务，以及能呈现完整 `detail` 的交互界面。文件证据另需现有的 `read` 工具。Web 结果卡通过包内 `./client` 和 DSH 工具展示插槽加载；使用上述安装或本地加载方式均可发现。

仓库保存可重新构建的源码和测试；安装包由 `npm pack` 生成。发布时可将 `.tgz` 作为 GitHub Release 附件，不提交依赖目录或本机构建输出。文件范围和发布步骤见 [发布说明](docs/RELEASING.md)。

## 求助和审批示例

插件向能使用 `ask_advisor` 的根任务注入求助指引：常规工作自行完成；同一障碍两次实质尝试失败、证据与解释矛盾、核心正确性假设未解决时，发起一次聚焦的独立复核。对并发、崩溃恢复、重试和幂等相互影响的复杂正确性论证，要求先形成候选结论及反例，再在最终定论前求助。该规则由模型理解并执行，不是程序计数器或自动切换器，不能保证每次必然调用；明确的用户限制仍优先。替换整个系统提示的自定义 persona 也可能覆盖这些指引。

主模型可以调用：

```json
{
  "question": "这个空输入错误最可能发生在哪里？请给出验证方法。",
  "goal": "修复解析器的空输入处理",
  "constraints": "保留现有公开接口",
  "attempts": "已运行测试；普通输入通过，空输入失败。",
  "evidence": [
    { "kind": "file", "source": "src/parser.ts", "start_line": 30, "end_line": 55 },
    { "kind": "tool_result", "source": "prior-test-call-id", "start_line": 1, "end_line": 8 }
  ]
}
```

文件路径按 DSH 当前任务目录解释。`tool_result.source` 是当前任务中已经完成的工具调用 ID，Code Mode 的子调用 ID 也可引用。工具结果只在拼接后的文本中按 1 起始行号选择。不存在的行、二进制内容、混合媒体和被文件读取工具截断的片段会被拒绝；没有需要补充的证据时传 `[]`。

用户先看到按字段分段的完整预览，再选择“批准并发送”“编辑内容”“删除证据”“拒绝”或“查看调用详情”。调用详情展示完整配置和请求编号，返回审批后仍须单独批准；查看详情不发送。编辑使用原生问题卡的字段选择和全文替换，并非独立网页编辑器。只有选择“批准并发送”并提交才授权发送；关闭界面、无回答、通用批准或旧回答都不算此次批准。

发送后顾问只有文字上下文，无文件、网络浏览或执行工具。工具返回 `status/text/request_id/truncated`，主模型负责验证建议；`truncated: true` 表示顾问达到输出 token 上限。

Web 结果卡默认显示顾问正文首段的简短预览（并非另一次模型摘要）。展开后按标题、列表、强调和代码显示建议；“原文与核对信息”保留未经展示转换的完整正文及请求编号。未支持的 Markdown 以文本呈现，HTML、链接和图片不触发外部资源加载。模型接收的结构化结果、持久化记录及原有会话不因此改写。

| 状态 | 含义 |
| --- | --- |
| `ok` | 文字建议已保存，可以继续执行 |
| `denied` / `cancelled` | 未取得有效授权，或在发送前取消 |
| `unavailable` | 缺少交互服务、准备/存储不可用，或旧调用在发送前中断 |
| `not_configured` / `disabled` | 尚未从界面配置顾问目标，或顾问已停用；未发送 |
| `model_unavailable` | Adapter 尚未接入所选模型；先从 Models 界面添加，再选择；未发送 |
| `unknown` | 可能已发送，但没有可靠的完成记录；不会自动重发 |
| `conflict` | 同一调用 ID 被用于不同参数 |
| `budget_exhausted` | 本任务已耗尽可用的发送名额 |
| `evidence_*` / `context_too_large` / `invalid_*` / `endpoint_required` | 证据、参数或接入配置需要修正，尚未发送 |
| `error` | 顾问完成但没有文字建议 |

拒绝后不自动再次求助。`unknown` 需要由人决定是否发起新调用；旧授权不允许重试。取消无法撤回已经到达远端的文本。

## 配置和审计

| 配置 | 默认值 | 用途 |
| --- | --- | --- |
| `provider`、`model` | 空，等待界面配置 | 使用已有 DSH 模型路由；旧 patch / 环境变量可提供初始值 |
| `enabled` | true | 界面中的“启用顾问”，保存在 DSH 的 `advisor` 设置中 |
| `storageDir` | `$DSH_HOME/advisor-audit`，未设置 DSH_HOME 时为 `~/.dsh/advisor-audit` | 本地审计与恢复记录 |
| `maxInputBytes` | 32768 | 系统指令和完整求助文本合计 UTF-8 字节上限 |
| `maxOutputTokens` | 4096 | 向 adapter 指定的输出上限；可配置 128–1,000,000，实际须符合所选模型限制 |
| `maxOutputBytes` | 131072 | 本地接收输出的字节上限；可配置 1024–16,777,216 |
| `maxCallsPerTask` | 8 | 持久化发送名额，跨进程共享 |
| `timeoutMs` | 120000 | 批准后模型调用的最长等待时间 |

输入超限不静默截断；token 上限和实际计费语义由 provider 实现。审批展示 adapter 解析后的调用配置，不估算费用。一次求助最多允许 20 轮预览重建。

审计目录要求当前用户所有、权限 `0700`，文件 `0600`，拒绝符号链接路径。默认保存经过规则脱敏的请求快照、审批决定、发送标记和最终结果；不会写入原始 provider 配置、认证 headers、API key 环境值、远端错误详情或模型推理流。快照可能仍含用户明确批准的代码和业务信息。

审计记录不自动删除：删除记录会同时删除防重复与任务调用限额的依据。只在相关任务不再恢复、没有运行中请求后，由用户按自己的保留策略处理。主模型的文件/命令工具不得具有修改该审计目录的权限；这属于 DSH 运行环境的隔离配置。

## 具体边界

- 这是按需顾问，未实现后台被动审查、多顾问投票、模型接管任务或顾问自主浏览。
- 首版仅支持有交互界面的根任务。无交互环境或 DSH `approval: never` 均不发送。
- 审批冻结的是**文本和模型调用配置**，文件在预览后变化也不会偷偷刷新；更新证据需要新请求。
- 密钥检测是启发式规则，不能识别所有私密信息。用户须通过完整预览决定哪些文本可以发送；原始主模型工具参数仍由 DSH 自己记录。
- `baseURL` 表示 adapter 使用的接收基址。代理、DNS、HTTP 重定向和同进程其他插件属于受信任部署边界，不承诺控制最终网络对端。
- 保证的是本地防止重复发起，不是跨 provider 的“恰好一次”处理。宕机可能消耗一个名额而未实际发出；宁可返回未知，也不重发。
- 普通文件权限不能对抗同一 OS 用户运行的任意代码。需要把审计目录隔离在主模型可写范围之外。
- 已完成真实 DSH 服务、Code Mode、文件读取和 Loader 集成测试；另已用真实 Flash/Pro 和 Playwright 操作 Chromium 验收 Standard mode 的完整审批流程。推理开关、其他 adapter、其他浏览器及 Code Mode 的浏览器交互不在本次云端验收范围内，详见 [验收记录](ACCEPTANCE.md)。

实现边界和维护说明见 [DESIGN.md](DESIGN.md)。DSH 接口依据：[模型 adapter](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/llm/llm)、[审批服务](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/interaction/user-approval)、[用户问题服务](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/interaction/user-questions)、[插件打包说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)。
