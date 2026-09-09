# 发布文件与步骤

源码仓库为 [kvmem/dsh-super-advisor](https://github.com/kvmem/dsh-super-advisor)。本项目是 DeepSeek Harness 插件；运行和测试依赖版本由 `package.json` 与 `package-lock.json` 固定。

## GitHub 源码范围

| 文件 | 用途 |
| --- | --- |
| `src/` | 顾问调用、审批、证据、配置与审计实现 |
| `client/index.js` | Web 顾问设置和结果卡 |
| `scripts/build-client.mjs` | 构建 Web 模块 |
| `test/` 中的 `.ts`、`.mjs` 文件 | 自动化回归、受控 adapter 和真实 Loader 验证 |
| `package.json`、`package-lock.json` | 包元数据、依赖、固定版本和构建命令 |
| `tsconfig.json`、`tsconfig.test.json` | 源码与测试类型检查配置 |
| `cordis.patch.yml` | DSH 插件安装入口 |
| `examples/` | 不含密钥的通用及 DeepSeek 配置示例 |
| `README.md`、`README.zh-CN.md`、`DESIGN.md`、`ACCEPTANCE.md`、本文 | 英文默认说明、可切换的中文说明、设计、验收范围与发布说明 |
| `.gitignore` | 排除本地环境及生成文件 |
| `LICENSE` | MIT 许可证，版权署名 kvmem |
| `docs/screenshots/`、`docs/releases/`、`docs/community-announcement.md` | 已检查的产品截图、版本发布说明和社区介绍 |

本机任务指引 `AGENTS.md`、交接目标 `GOAL.md`、人工验收截图 `docs/acceptance/`、私有 `.acceptance/`、环境文件和日志不上传。`node_modules/`、`dist/`、覆盖率和测试临时目录不提交；依赖由安装恢复，构建产物由源码生成。现有本地文件无需删除。

不要把 `git add .` 作为首次上传的文件选择方式。按上述范围显式选择文件，并在提交前检查 `git diff --cached --stat` 和 `git diff --cached`。测试中的两条 `sk-` 字母序列是用于脱敏回归的人造样本，不是可用凭证。

## 安装包

在 Node 24 或更新版本的 Linux 环境中运行：

```sh
npm ci
npm run check
npm pack
tar -tzf dsh-super-advisor-0.1.7.tgz
```

`npm pack` 的 `prepack` 构建后端和 Web client。包内容由 `package.json` 的 `files` 白名单控制，仅分发 `dist/`、包元数据、LICENSE、用户文档、选定的产品截图、示例和 DSH patch；不打包源码测试、私有验收环境、凭证或本机任务记录。

可选的解包 Loader 验证（先完成 `npm run check`）：

```sh
packed_dir=$(mktemp -d "$PWD/test/.packed-XXXXXX")
tar -xzf dsh-super-advisor-0.1.7.tgz -C "$packed_dir"
ADVISOR_SMOKE_MODULE="$packed_dir/package/dist/index.js" node test/loader-smoke.mjs
rm -r -- "$packed_dir"
```

## 分发

发布 GitHub Release 时，将通过检查的 `.tgz` 作为附件上传，源码通过对应提交和版本标签关联。每个 Release 同时上传带版本号的包和内容相同的 `dsh-super-advisor.tgz`，以及 SHA256SUMS；固定文件名支持下方的最新版下载地址。先创建草稿、上传并核对所有附件，再公开发布并标记为 latest。`.tgz` 不进入 Git 源码历史。GitHub 自动生成的 Source code 压缩包不含预构建 `dist/`，不能替代插件安装包。

用户使用已配置的 DSH 和 pnpm，下载并安装最新版，无需填写版本号：

```sh
curl -fL https://github.com/kvmem/dsh-super-advisor/releases/latest/download/dsh-super-advisor.tgz -o dsh-super-advisor.tgz
dsh plugin --profile web add ./dsh-super-advisor.tgz
dsh web
```

当前没有供 Git 安装自动构建的 `prepare` 步骤；使用 `.tgz`，或先克隆源码并执行上述构建步骤。npm 发布需要另行确认包名可用性及发布账户权限；这里的构建与打包命令不会执行 npm 发布或创建 GitHub Release。

`0.1.7` 起使用 DSH SuperAdvisor / `dsh-super-advisor`。为了兼容已公开的旧下载命令，Release 另附 `dsh-tool-advisor.tgz`，内容必须是已发布的原版 0.1.6 包，不能把新包改成旧文件名冒充原包。SHA256SUMS 同时覆盖该兼容附件。历史版本和标签保留，旧版用户按 README 的步骤移除旧包后安装新包，保留原设置和审计目录。

许可证为 MIT，版权署名 `kvmem`。`package.json` 保留 `dsh-plugin`、`deepseek-harness` 关键词；GitHub 仓库关联同名 Topic，方便社区发现。社区介绍发到官方仓库的 Show Your Plugins! 分区，一个项目维护一个帖子，后续更新该帖而不重复发布。
