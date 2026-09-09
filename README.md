# DSH Advisor

English | [简体中文](README.zh-CN.md)

An independent, on-demand advisor tool for DeepSeek Harness. The main model calls `ask_advisor`, a person reviews and approves the complete request, and the advisor returns text advice for the main model to verify and act on.

Source: [kvmem/dsh-advisor](https://github.com/kvmem/dsh-advisor). This is a DeepSeek Harness plugin that uses DSH's existing model, permission, and approval services.

**2026-09-08: completed a real DeepSeek Flash → Pro advisor call, plus Chromium acceptance checks for approval, editing, rejection, cancellation, timeout, and restart.** Version `0.1.1` fixed closing an approval card being reported as `unavailable`; it now returns `cancelled`. See the [acceptance record (Chinese)](ACCEPTANCE.md) for results and the scope of testing.

Version `0.1.2` added support for longer responses. The Flash/Pro example sets both output budgets to 384,000 tokens and the advisor response byte limit to 16 MiB. Actual output remains subject to model capabilities and context limits. The plugin's general defaults are unchanged; higher limits apply only when explicitly configured.

Version `0.1.3` improved approval and result presentation: requests are divided into question, goal, constraints, attempts, and evidence, with call configuration available separately. Web results start with a short preview and can expand to show the full advice and original text. A system prompt section explains when to ask for help and distinguishes starting a local approval from sending data to a model service.

Version `0.1.4` added configuration through **Settings → Plugins → Advisor model (`顾问模型`)**. Installation no longer requires a provider/model selection. Choose a service and model already configured in DSH, or enter a model ID manually, then save. Saving, refreshing, and switching selections do not automatically start inference. Supported services follow the DSH adapter's capabilities and are not limited to DeepSeek or OpenAI-compatible APIs.

## Features

- The main model explicitly supplies a question, goal, constraints, attempted actions and their results, and up to eight evidence items.
- File evidence uses the existing DSH `read` tool's permission and execution pipeline. Tool-result evidence must come from completed calls in the current task.
- Only the selected text line ranges are included. Full conversations, system history, images, and hidden reasoning are not automatically attached.
- Native user-question cards show the destination, provider/model, output limit, and all system instructions and request text that will be sent.
- Users can replace the question, goal, constraints, attempts, or individual evidence text, and can delete evidence. Edits generate a new preview that requires a separate approval.
- Each approval is bound to an immutable snapshot. General automatic approvals, fabricated `approved` arguments, and Code Mode wrappers cannot bypass this review.
- Each request calls DSH's `PreparedLlmCall.stream` once, without automatic retries or provider switching. Timeouts and interruptions return explicit statuses.
- A send marker is persisted before the call starts. Re-entering the same task and call reuses a saved result or refuses to send again.

## Compatibility

Verified with **Node 24, Linux, a local POSIX filesystem, and DSH `0.1.3-alpha.2`**. DSH dependencies are intentionally pinned because the plugin uses this version's `prepareCall`, tool execution tokens, settings catalog, and native approval services. Compatibility with older DSH versions is not guaranteed.

Model access uses DSH's `provider + model` routing and `ctx.llm.prepareCall`. The plugin has no separate HTTP client, does not manage model deployment, and does not require an OpenAI-compatible API. DSH adapters use the protocols they support.

The selected provider must be registered in `listConfigurableProviders()`, and its **DSH provider configuration must explicitly set `baseURL`**. The URL must not contain a username, password, query parameters, or fragment. Credentials remain managed by DSH's adapter/credentials services, not by this plugin.

For example, `llm-deepseek` uses `baseURL` at the configuration root; `llm-pi-ai` uses `providers.<your-provider>.baseURL`. Third-party adapters must honor DSH's call-snapshot contract, avoid uploading task data during preparation, and avoid automatic internal retries within a single stream.

## Build and install

```sh
git clone https://github.com/kvmem/dsh-advisor.git
cd dsh-advisor
npm ci
npm run check
npm pack
```

`check` includes source and test type checks, integration tests, and a standalone Node check that loads the build through a real Loader/Include and `cordis.yml`. Model responses come from a controlled adapter; these tests do not call real paid models.

Use Node 24 or later, with DSH and the pnpm executable required by its plugin installer available. After building, run these commands from the project directory to install the plugin and start the Web UI:

```sh
dsh plugin --profile web add "$PWD/dsh-tool-advisor-0.1.4.tgz"
dsh web
```

Initial setup can be completed entirely in the UI. The advisor settings card currently uses Chinese labels:

1. In **Settings → Models**, add or edit a service with its actual endpoint, API key, and model information. For custom GLM, Qwen, or other services, choose a protocol supported by both the service and the DSH adapter. DSH credentials manages the key.
2. In **Settings → Plugins → Advisor model (`顾问模型`)**, select the service and advisor model, then save. You can enter a model ID manually, but whether it is usable depends on the adapter; the current Pi-ai adapter requires the model to be registered in Models first.
3. **Output settings (`输出设置`)** controls the per-call output budget. Check the selected model's limits when switching services. **Enable advisor (`启用顾问`)** controls whether new requests are allowed.

DSH persists these settings across page refreshes and server restarts. They do not change the main task's selected model. Every advisor request still requires individual approval. Changing advisor settings while approval is pending invalidates the old snapshot; requests already sent retain their original snapshot. When two pages edit settings at once, an outdated draft cannot overwrite a newer configuration and must be reloaded first.

The included `cordis.patch.yml` inserts an `advisor` entry. Advanced deployments can still provide initial values through the launch environment variables `DSH_ADVISOR_PROVIDER` / `DSH_ADVISOR_MODEL`, or through a profile patch:

```yaml
- id: advisor
  config:
    provider: your-existing-provider
    model: your-advisor-model
```

Settings saved in the UI override these initial values. Without a target, the plugin loads normally and remains configurable, while the tool returns `not_configured` without sending. It also refuses to send when the service is unavailable or lacks an explicit `baseURL`.

For local development, load the built module directly:

```sh
dsh web --patch "$PWD/examples/local.cordis.patch.yml"
```

Run these commands from the repository root. DSH resolves `../dist/index.js` relative to the patch file, so the examples do not depend on a particular machine's directory. The [DeepSeek example](examples/deepseek-flash-pro.cordis.patch.yml) configures Flash as the main model and Pro as the advisor, using `deepseek-v4-flash` and `deepseek-v4-pro`. Configure credentials through DSH or provide `DEEPSEEK_API_KEY` to the launching process before loading the overlay. Keep keys out of the patch:

```sh
dsh web --patch "$PWD/examples/deepseek-flash-pro.cordis.patch.yml" --no-open
```

The DeepSeek example uses a high output budget; actual output remains subject to service and model limits. For other services, use the general configuration and register the model in Models.

Choose either the installed bundle or a local overlay to avoid registering the tool twice. The profile must provide `tools`, `llm`, `settings`, `agents`, `approval`, `userQuestions`, and `systemPrompt`, plus an interactive UI that can display the complete `detail` field. File evidence also requires the existing `read` tool. Web result cards are discovered through the package's `./client` export and DSH tool presentation slots with either installation method.

The repository contains rebuildable source and tests; `npm pack` generates the installable package. A release can attach the `.tgz` to GitHub Releases without committing dependencies or local build output. See the [release guide (Chinese)](docs/RELEASING.md) for file selection and release steps.

## Request and approval example

The plugin injects advisor guidance into root tasks that can access `ask_advisor`: handle routine work independently; seek a focused independent review after two substantive failed attempts at the same obstacle, when evidence contradicts an explanation, or when a core correctness assumption remains unresolved. For complex arguments involving concurrency, crash recovery, retries, and idempotency, the guidance asks the model to form a candidate conclusion and counterexamples, then consult the advisor before reaching a final conclusion. The model interprets this guidance; there is no programmatic counter or automatic model switch, and it does not guarantee a call on every task. Explicit user restrictions take precedence. A custom persona that replaces the entire system prompt can also override this guidance.

The main model can call:

```json
{
  "question": "Where is this empty-input error most likely occurring? Suggest a way to verify it.",
  "goal": "Fix the parser's handling of empty input",
  "constraints": "Preserve the existing public API",
  "attempts": "Ran the tests; ordinary input passes, but empty input fails.",
  "evidence": [
    { "kind": "file", "source": "src/parser.ts", "start_line": 30, "end_line": 55 },
    { "kind": "tool_result", "source": "prior-test-call-id", "start_line": 1, "end_line": 8 }
  ]
}
```

File paths are resolved against the current DSH task directory. `tool_result.source` is the ID of a completed tool call in the current task; Code Mode child-call IDs are also supported. Line selection uses 1-based line numbers in the combined text result. Missing lines, binary content, mixed media, and excerpts truncated by the file-reading tool are rejected. Use `[]` when no additional evidence is needed.

The user first sees a complete preview divided into fields, then chooses **Approve and send (`批准并发送`)**, **Edit content (`编辑内容`)**, **Delete evidence (`删除证据`)**, **Reject (`拒绝`)**, or **View call details (`查看调用详情`)**. Call details show the full configuration and request ID. Returning from that view still requires a separate approval; viewing details does not send anything. Editing uses field selection and full-text replacement in native question cards, rather than a separate page editor. Only selecting and submitting **Approve and send** authorizes transmission. Closing the card, leaving it unanswered, general approvals, and old answers do not authorize the current request.

The advisor receives only text and has no file access, browser, or execution tools. The tool returns `status/text/request_id/truncated`, and the main model is responsible for verifying the advice. `truncated: true` means the advisor reached the output token limit.

The Web result card initially shows a short preview from the beginning of the advice, not another model-generated summary. Expanding it displays headings, lists, emphasis, and code. **Original text and verification details (`原文与核对信息`)** retains the full unmodified response and request ID. Unsupported Markdown appears as text; HTML, links, and images do not load external resources. Presentation does not rewrite the structured tool result, persisted records, or existing conversation.

| Status | Meaning |
| --- | --- |
| `ok` | Text advice has been saved; the main model can continue |
| `denied` / `cancelled` | No valid approval was obtained, or the request was cancelled before sending |
| `unavailable` | Interactive services, preparation, or storage are unavailable, or an earlier call was interrupted before sending |
| `not_configured` / `disabled` | No advisor target has been configured, or the advisor is disabled; nothing was sent |
| `model_unavailable` | The adapter does not have the selected model available; register it in Models before selecting it; nothing was sent |
| `unknown` | The request may have been sent, but there is no reliable completion record; it will not be resent automatically |
| `conflict` | The same call ID was used with different arguments |
| `budget_exhausted` | The task has used all available dispatch slots |
| `evidence_*` / `context_too_large` / `invalid_*` / `endpoint_required` | Evidence, arguments, or provider configuration needs correction; nothing was sent |
| `error` | The advisor finished without returning text advice |

A rejection does not trigger another request automatically. For `unknown`, a person must decide whether to start a new call; the old approval cannot authorize a retry. Cancellation cannot retract text that has already reached the remote service.

## Configuration and audit records

| Setting | Default | Purpose |
| --- | --- | --- |
| `provider`, `model` | Empty; configure in the UI | Use an existing DSH model route; a patch or environment variables can supply initial values |
| `enabled` | true | The UI's Enable advisor toggle, persisted in DSH's `advisor` settings |
| `storageDir` | `$DSH_HOME/advisor-audit`, or `~/.dsh/advisor-audit` when DSH_HOME is unset | Local audit and recovery records |
| `maxInputBytes` | 32768 | Combined UTF-8 byte limit for system instructions and the complete request |
| `maxOutputTokens` | 4096 | Output limit passed to the adapter; configurable from 128 to 1,000,000, subject to the selected model's limits |
| `maxOutputBytes` | 131072 | Local response byte limit; configurable from 1024 to 16,777,216 |
| `maxCallsPerTask` | 8 | Persistent dispatch budget shared across processes |
| `timeoutMs` | 120000 | Maximum model-call wait time after approval, in milliseconds |

Oversized input is rejected rather than silently truncated. Token limits and billing semantics are implemented by the provider. Approval displays the adapter's resolved call configuration without estimating cost. A request allows at most 20 preview rebuilds.

The audit directory must be owned by the current user with mode `0700`; files use `0600`, and symlink paths are rejected. Records include request snapshots processed by redaction rules, approval decisions, send markers, and final results. They exclude raw provider configurations, authentication headers, API-key environment values, remote error details, and model reasoning streams. Snapshots may still contain code and business information explicitly approved by the user.

Audit records are not deleted automatically: deleting them also removes the basis for duplicate prevention and task call limits. Apply a retention policy only after the relevant tasks will no longer be resumed and no requests are running. The main model's file and command tools must not be able to modify the audit directory; that isolation is part of the DSH deployment configuration.

## Boundaries

- This is an on-demand advisor. It does not implement background review, multi-advisor voting, task takeover, or independent advisor browsing.
- This version supports interactive root tasks only. Non-interactive environments and DSH `approval: never` do not send requests.
- Approval freezes **the text and model-call configuration**. Later file changes do not silently refresh approved evidence; updated evidence requires a new request.
- Secret detection uses heuristics and cannot identify every kind of private information. Users must review the complete preview to decide what may be sent. DSH itself still records the main model's original tool arguments.
- `baseURL` identifies the adapter's configured receiving base URL. Proxies, DNS, HTTP redirects, and other plugins in the same process are part of the trusted deployment boundary; the plugin does not guarantee control over the final network peer.
- The guarantee is local duplicate prevention, not exactly-once processing across providers. A crash may consume a dispatch slot without sending a request; recovery returns an unknown outcome instead of resending.
- Ordinary filesystem permissions cannot protect against arbitrary code running as the same OS user. Keep the audit directory outside the main model's writable scope.
- Integration tests cover real DSH services, Code Mode, file reads, and Loader. Real Flash/Pro and Playwright-driven Chromium were also used to verify the full Standard mode approval flow. Reasoning settings, other adapters, other browsers, and browser interactions in Code Mode were outside that cloud acceptance run; see the [acceptance record (Chinese)](ACCEPTANCE.md).

See [DESIGN.md (Chinese)](DESIGN.md) for implementation boundaries and maintenance notes. DSH interface references: [model adapters](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/llm/llm), [approval service](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/interaction/user-approval), [user-question service](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/interaction/user-questions), and [plugin packaging](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md).
