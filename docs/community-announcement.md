# DSH | DSH SuperAdvisor | A second opinion for your main model, approved by you

> Unofficial project, independently developed and maintained by community members.

Project: [kvmem/dsh-super-advisor](https://github.com/kvmem/dsh-super-advisor)

**Renamed in 0.1.7:** formerly DSH Advisor (`dsh-tool-advisor`), now DSH SuperAdvisor (`dsh-super-advisor`). Existing users: follow the [upgrade steps](https://github.com/kvmem/dsh-super-advisor#upgrading-from-dsh-advisor-016-or-earlier) to replace the old package while keeping settings and audit records.

DSH SuperAdvisor lets the main model request a focused second opinion through `ask_advisor`. You review and approve the complete request before it reaches the advisor. The advisor returns text advice, and the main model continues to verify and carry out the task.

- **Review before sending:** inspect the question and selected evidence, edit the request, remove evidence, or reject it.
- **Reuse your DSH configuration:** select an existing service and model in Settings → Plugins → DSH SuperAdvisor. Endpoints and credentials stay in Models settings.
- **Control the shared context:** only the reviewed text and explicitly selected evidence are sent; the plugin does not automatically attach the full conversation or workspace. The advisor has no execution tools.
- **Read the result:** expand the advice, inspect the original text, and follow the request ID. Send markers and cached results prevent automatic duplicate sends after interruption.

The plugin uses DSH's native tool, model-adapter, approval, user-question, and Web UI extension services. It also adds guidance about when to seek advice; the main model still decides whether to call the tool.

By default, output follows the model service's token budget and the plugin adds no received-text size cap. Model/service limits and the default 120-second timeout still apply. Approved calls may incur your model service's normal charges.

## Typical setups

- **Local main model + cloud advisor:** keep routine analysis and execution with a local model connected to DSH and capable of calling tools. Approve focused requests to a stronger cloud model when help is needed; the local model verifies the advice and continues.
- **Flash main model + Pro advisor:** use `deepseek-v4-flash` for the main task and `deepseek-v4-pro` for difficult questions or focused reviews, with user approval for each consultation.

The aim is to approach the quality of using a stronger model throughout while reducing stronger-model usage and cost. Actual quality and savings depend on the task, models, context size, and consultation frequency. No comparative quality or cost benchmark has been performed.

## Screenshot

Actual DSH settings UI with a local test configuration. The settings card currently uses Chinese labels; documentation is available in English and Chinese.

![Advisor model settings](https://raw.githubusercontent.com/kvmem/dsh-super-advisor/main/docs/screenshots/advisor-settings.png)

## Install

Tested with **DSH 0.1.3-alpha.2, Node 24, Linux, and a local POSIX filesystem**. DSH's installer also requires pnpm. Other versions and operating systems have not been verified.

Download and install the [latest GitHub release](https://github.com/kvmem/dsh-super-advisor/releases/latest) without entering a version number:

```sh
curl -fL https://github.com/kvmem/dsh-super-advisor/releases/latest/download/dsh-super-advisor.tgz -o dsh-super-advisor.tgz
dsh plugin --profile web add ./dsh-super-advisor.tgz
dsh web
```

This downloads the latest release when you run the command; it does not enable automatic background updates.

Configure the service in **Settings → Models**, including its saved Base URL, credentials, and model. Then select the advisor under **Settings → Plugins → DSH SuperAdvisor** and save. Main-model and advisor-model selections are independent; saving settings does not run inference.

The current release passes **51 automated tests**, build checks, real DSH Loader checks, and Chromium settings checks. This release uses controlled model fixtures for testing. Earlier acceptance included a real DeepSeek Flash → Pro → Flash flow. GLM/Qwen tests used local mock endpoints, not their cloud services. See [ACCEPTANCE.md](https://github.com/kvmem/dsh-super-advisor/blob/main/ACCEPTANCE.md) for the full scope.

## 中文简介

这是一个非官方 DSH 顾问插件：主模型遇到难题时，通过 `ask_advisor` 整理问题和证据；你先查看、编辑或拒绝，逐次批准后才发送给顾问模型。顾问返回文字建议，主模型继续验证和执行。

`0.1.7` 起名称改为 **DSH SuperAdvisor**，包名为 `dsh-super-advisor`。旧版用户请参考[中文升级说明](https://github.com/kvmem/dsh-super-advisor/blob/main/README.zh-CN.md)，替换安装包并保留原设置和审计记录。

模型服务、地址和密钥复用 DSH 的 Models 设置，顾问在 Plugins → DSH SuperAdvisor 中选择。默认沿用模型服务的输出预算，插件接收文本不设上限。模型自身限制及请求超时仍有效。

两个典型场景：

- **本地主模型 + 云端大模型顾问**：具备工具调用能力、已接入 DSH 的本地模型处理日常任务；遇到难题，经用户批准后向云端大模型求助。
- **Flash 主模型 + Pro 顾问**：Flash 负责主要执行，按需请 Pro 分析难题或复核，收到建议后由 Flash 继续验证和执行。

目标是在接近全程使用更强模型效果的同时降低成本。实际效果与节省幅度取决于任务、模型、上下文长度和求助频率，目前尚未进行质量与费用的对照评测。

[English README](https://github.com/kvmem/dsh-super-advisor/blob/main/README.md) · [中文说明](https://github.com/kvmem/dsh-super-advisor/blob/main/README.zh-CN.md) · [反馈问题](https://github.com/kvmem/dsh-super-advisor/issues)
