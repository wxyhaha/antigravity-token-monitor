# Antigravity Token & TPS Monitor

一个用于 **Google Antigravity**（桌面端 & IDE）的原生侧边栏实时监控插件，直接以只读方式解析本地对话数据库（SQLite + WAL）、`transcript.jsonl` 与后台运行日志，在右侧辅助栏实时展示 Token 消耗、生成速率（TPS）、每轮模型归因以及正在进行的请求流程与后台异常诊断。

---

## 1. 插件功能介绍

### 1.1 实时请求流程 & 后台异常诊断（核心功能）
解决主界面一直转圈显示 `Working`，但后台其实已经报错或重试、导致白白等待的问题：
- **实时状态机**：每 1.5 秒刷新当前对话状态，准确区分「等待模型首字响应」「模型流式输出中」「工具执行中」「步骤排队中」「后台异常重试中」「后台已报错」和「空闲 / 已完成」。
- **卡顿与耗时告警**：实时计时当前步骤已等待/运行时长，超过 30 秒自动标黄提醒留意异常。
- **后台错误即时捕获**：自动解析 `gen_metadata` 中的 API 重试/失败记录、`steps.error_details` 工具报错以及 `language_server.log` 近期错误，第一时间展示 **503 算力不足**、**429 限流**、**5 分钟空闲超时**、**EOF / 网络连接重置**、**地区限制** 等具体原因。
- **当前轮次步骤流水线**：实时列出当前轮次的每一步（用户提问 → 模型响应 → 工具调用 → 检查点），包括尚未返回 Token 的进行中步骤。

### 1.2 实时看板（Live）
- **核心 KPI 卡片**：实时生成速率（TPS，含平均/峰值/流式峰值）、总输出 Tokens（拆分「思考 Tokens」与「正文/工具调用 Tokens」）、当前上下文窗口大小、新增输入 vs Prompt Cache 缓存命中率、TTFT 首字延迟与单步平均耗时。
- **本对话模型汇总**：按模型统计调用次数、输出占比、输入/缓存消耗与平均/峰值 TPS（例如可清晰区分 `Orchestrator (Argon)` 规划模型与 `Gemini Flash` 执行模型）。
- **TPS 与上下文趋势图**：SVG 柱状+折线组合图，直观查看近期每步上下文增长与生成速度波动。
- **各轮对话 & 每步模型实时轨迹**：按对话轮次（Round）分组展示用户提问、各轮用到的模型徽章以及每一步的明细指标。

### 1.3 步骤明细 & 全局汇总
- **步骤明细**：支持按关键词、模型名称筛选，支持按最新/最早/TPS 最高/输出最多/耗时最长排序。
- **全局汇总**：自动汇总本机 **Antigravity Desktop** 与 **Antigravity IDE** 的全部历史对话，点击任意历史对话卡片即可切换查看。
- **独立网页模式**：除了作为原生 Sidecar 侧边栏运行外，也支持脱离主程序单独启动本地 HTTP 看板用于排查或对比。

---

## 2. 换机后如何直接使用

本插件仅依赖 Node.js 原生内置模块（`node:sqlite`、`node:http`、`node:fs`、`node:os`）与 Antigravity 自带的 `sidecar_sdk`，**无需执行 `npm install`**，也**不包含任何隐私数据或密钥**。

### 环境要求
- 已安装 **Google Antigravity**（桌面端或 IDE）
- **Node.js ≥ 22.5**（需支持原生内置 `node:sqlite`）

### 一键安装步骤

在新机器打开终端，直接将本仓库克隆到 Antigravity 的全局插件目录 `token-monitor` 下：

- **Windows (PowerShell)**：
  ```powershell
  git clone https://github.com/wxyhaha/antigravity-token-monitor.git "$env:USERPROFILE\.gemini\config\plugins\token-monitor"
  ```

- **macOS / Linux**：
  ```bash
  git clone https://github.com/wxyhaha/antigravity-token-monitor.git ~/.gemini/config/plugins/token-monitor
  ```

### 启用与打开面板
1. 重启 Antigravity（或在 **Customizations / Plugins** 管理页找到 **Token & TPS Monitor** 并启用）。
2. 在对话中让助手打开监控面板，或直接通过右侧边栏打开 **Token & TPS** 面板。

### 后续更新版本
在新机器或当前机器上，进入插件目录拉取最新代码即可：
```bash
git -C ~/.gemini/config/plugins/token-monitor pull
```
（Windows PowerShell 可将路径替换为 `"$env:USERPROFILE\.gemini\config\plugins\token-monitor"`）

---

## 3. 命令行自检与独立模式

```bash
# 运行只读自检，输出当前解析到的对话数与指标摘要
node ~/.gemini/config/plugins/token-monitor/sidecars/token_dashboard/main.mjs --self-test

# 启动独立本地 HTTP 服务（默认端口 4399，可在浏览器访问）
node ~/.gemini/config/plugins/token-monitor/sidecars/token_dashboard/main.mjs --standalone 4399
```
