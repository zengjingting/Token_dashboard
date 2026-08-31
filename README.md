# Token Dashboard

面向 Claude Code 与 Codex 用户的本地使用分析和会话管理工具。它把分散在不同 AI 编程工具中的 Token、成本、模型和历史会话信息汇总到一个界面，帮助用户了解资源消耗、定位高成本项目，并回顾过去的工作过程。

## 项目背景

同时使用多个 AI 编程工具时，使用数据通常分散在不同目录和统计口径中：Token 类型难以直接比较、费用缺少统一视图、历史会话也不方便跨工具检索。

Token Dashboard 将 Claude Code 和 Codex 的本地数据统一整理为三个产品模块：

- **使用概览**：查看指定时间范围内的 Token、费用、缓存利用和模型分布。
- **成本分析**：按模型和项目观察资源消耗，识别主要成本来源。
- **会话管理**：集中浏览、搜索、重命名和导出 Claude Code、Codex 历史会话。

## 简要使用说明

打开页面后，用户首先在仪表盘选择 `5小时`、`今日`、`3天`、`7天` 或自定义时间范围，查看两个 AI 工具的整体消耗及分项数据。页面每 30 秒更新一次当前统计。

进入“会话历史”后，可以按项目浏览 Claude Code 和 Codex 会话，查看用户消息、Assistant 回复和工具调用记录；也可以进行跨会话全文搜索、修改本地标题，或将完整会话导出为 Markdown 文件。

## 核心能力

- 聚合 Claude Code 与 Codex 两类本地数据
- 统一展示输入、输出、缓存 Token 与费用
- 支持 5 种时间范围和实时刷新
- 展示模型成本与项目成本分布
- 按项目合并并浏览跨工具会话
- 支持全局搜索、会话内搜索和结果定位
- 支持会话重命名、复制 ID、删除和 Markdown 导出
- 提供中英文界面

## 指标口径

- **总 Token**：输入 + 输出 + 缓存创建 + 缓存读取。
- **总费用**：展示 Claude Code 与 Codex 的合计及分项费用。
- **缓存利用**：仅按 Claude Code 的缓存读取与缓存创建数据计算，避免混用不同工具的字段口径。
- **项目成本**：当前仅统计 Claude Code 项目，并按全部历史数据汇总。

## 本地运行

### 环境要求

- macOS
- Node.js 22
- 已产生本地会话数据的 Claude Code 和/或 Codex
- `ccusage` 与 `@ccusage/codex` 命令行工具，用于日期范围和费用统计

当前版本按 Apple Silicon Homebrew 的默认路径调用 Node.js 和统计工具。如安装路径不同，需要相应调整 `readers/cli-runner.js` 中的路径。

### 启动步骤

```bash
git clone https://github.com/zengjingting/Token_dashboard.git
cd Token_dashboard
npm install
npm start
```

然后访问：<http://localhost:3333>

运行测试：

```bash
npm test
```

## 数据与隐私

- 数据直接读取自本机的 Claude Code 与 Codex 会话目录，不上传到远端服务。
- 服务仅监听 `127.0.0.1`，默认不向局域网开放。
- 自定义会话标题保存在浏览器本地存储中。
- 删除会话会直接删除对应的本地 JSONL 文件，操作前请确认已完成备份。

## 已知限制

- Codex 本地会话数据没有与 Claude Code 完全对齐的费用字段，部分视图中的 Codex 费用可能显示为 `0`。
- 项目成本目前仅统计 Claude Code，且不随页面时间范围切换。
- 当前版本面向本地单用户使用，不是生产环境部署方案。
- 统计工具路径暂未自动发现，非默认 Homebrew 环境需要手动配置。

更完整的功能说明见 [使用手册](docs/user-manual.md)。

## License

[MIT](LICENSE)
