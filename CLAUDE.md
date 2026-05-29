# BrowserPilot（浏览器领航员）

## 项目概述

BrowserPilot 是一个本地浏览器 Agent 客户端，使用 AI 模型驱动浏览器自动执行网页任务。核心思路是：用户输入自然语言任务 → Agent 规划下一步操作 → 通过 Playwright 执行浏览器动作 → 观察页面变化 → 循环直到任务完成。

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面客户端 | Tauri v2 + React + TypeScript + Vite |
| 本地服务 | Node.js 原生 http server（纯 ES Module，.mjs 后缀） |
| 浏览器控制 | Playwright（Chromium persistent context） |
| AI 模型 | DeepSeek（通过 `@ai-sdk/deepseek` + Vercel AI SDK） |
| 包管理 | pnpm workspace monorepo |
| 前端样式 | 纯 CSS（`apps/desktop/src/styles.css`），未使用任何 UI 框架 |

## 目录结构

```
browser-pilot/
├── apps/desktop/                 # Tauri + React 桌面客户端
│   ├── src/
│   │   ├── App.tsx               # 全部前端逻辑（单文件，~3000行）
│   │   ├── main.tsx              # React 入口
│   │   └── styles.css            # 全局样式
│   ├── src-tauri/                # Tauri（Rust）配置
│   └── index.html
├── services/local-server/        # 本地 Agent 服务
│   └── src/
│       ├── server.mjs            # HTTP API 路由 + SSE 事件推送
│       ├── deepseek-agent.mjs    # Agent 核心调度（规划 + 重试 + 修复）
│       ├── browser-tools.mjs     # 浏览器工具注册（navigate/click/type/scroll）
│       ├── accessibility-snapshot.mjs  # 无障碍快照
│       ├── thinking-log.mjs      # 思考过程日志记录
│       └── agent/
│           ├── config.mjs        # 预算配置、Prompt 模板、步骤限制
│           ├── llm-client.mjs    # LLM API 请求封装 + 响应解析
│           ├── observations.mjs  # 分层观察构建（核心观测逻辑）
│           ├── progress.mjs      # 进度追踪、循环检测(LoopJudge)、安全规则
│           ├── intent-lexicon.mjs # 意图词法分析（正则匹配）
│           └── text.mjs          # 文本工具函数
├── packages/                     # 可复用逻辑包
│   ├── agent-runtime/src/index.mjs    # 动作规范化 + ToolRegistry 工具注册器
│   ├── browser-core/src/index.mjs     # 浏览器控制抽象
│   ├── dom-inspector/src/index.mjs    # DOM/可交互元素分析
│   ├── vision-inspector/src/index.mjs # 视觉理解接口
│   ├── extractor/src/index.mjs        # 内容提取（Firecrawl 封装）
│   ├── safety-guard/                  # 风险识别拦截
│   ├── recorder/                      # 操作录制
│   ├── player/                        # 操作回放
│   ├── task-engine/                   # 多步骤任务执行
│   └── report-engine/                 # 任务报告生成
├── integrations/                 # 外部系统适配
│   ├── playwright/src/
│   │   ├── index.mjs             # BrowserPilotSession（Playwright 操作封装）
│   │   └── webview-cdp.mjs       # Tauri WebView CDP 桥接
│   ├── chrome-cdp/               # Chrome DevTools Protocol 适配
│   ├── openai/                   # OpenAI 模型适配
│   ├── ollama/                   # 本地模型适配
│   └── code-run-guard/           # 代码验收场景扩展
├── storage/                      # 本地持久化
│   ├── sqlite/                   # settings.json（DeepSeek API Key 等）
│   ├── profiles/                 # 浏览器 profile、cookie
│   ├── snapshots/                # 截图、DOM 快照
│   └── task-runs/                # 任务执行记录
└── docs/                         # 设计文档
    ├── product.md
    ├── architecture.md
    ├── roadmap.md
    └── safety.md
```

## 核心架构

### Agent 执行主流程

```
用户输入任务
  ↓
POST /api/chat → runChatTurn()  在 server.mjs
  ↓
[1] session.snapshot()          获取页面状态
[2] planBrowserAction()         调用 LLM 规划下一步动作
     ↓
     ├── deterministicSafetyPlan()    硬编码安全检查（重复提交/连续点击）
     ├── planFromIntentOnly()         意图快速路由（第1步可跳过页面观察）
     └── 正式规划循环：
          ├── LoopJudge（步骤超限时）检测死循环
          ├── buildTaskState()        构建任务状态
          ├── buildAgentObservations() 分层观察
          ├── requestPlan()           调用 LLM
          ├── shouldRetryNoAction()   判断是否需要修复
          └── repairNoAction()        从候选动作中修复空操作
[3] executeSessionBrowserActions()  执行浏览器动作
[4] 通过 SSE 将思考过程推送到前端
  ↓
返回结果，前端显示，继续下一轮
```

### 分层观察体系（observations.mjs）

Agent 不直接看原始 DOM，而是接收三层结构化观察数据：

1. **fullSnapshot**（首次/导航后）：页面切片，包含 regions、blocks、targets、inputs、relations
2. **actionableDiff**（操作后）：页面变化增量，包含 activeElement 变化、新增/更新的输入框、操作按钮、目标消失
3. **focusedTargetContext**（任务相关）：根据用户意图检索最相关的候选目标、推荐动作

### 预算自适应机制（config.mjs）

三级预算控制每次给 LLM 的数据量：

| 预算 | contentLimit | targetLimit | maxTokens | timeoutMs |
|------|-------------|-------------|-----------|-----------|
| normal | 4 个内容块 | 8 个目标 | 420 | 15s |
| compact | 3 个内容块 | 6 个目标 | 280 | 12s |
| minimal | 2 个内容块 | 4 个目标 | 180 | 10s |

规划失败时自动降级到更小的预算重试。

### 模型回退机制（llm-client.mjs 中的 modelCandidates）

```
主模型 → deepseek-v4-pro → deepseek-chat
```
400 错误（模型兼容性问题）自动跳过当前模型。

### 循环安全机制

1. **hard limit**：`absoluteMaxSteps()`（默认 softMaxSteps+8=16，最小24，硬上限40）— 超过强制停止
2. **soft limit**：`softMaxSteps=8` — 超过触发 LoopJudge
3. **LoopJudge**：独立 LLM 调用判断是否死循环（通过 URL 变化、页面指纹、动作序列分析）
4. **确定性规则**（progress.mjs）：
   - 连续 2 次提交相同文本 → 停止
   - 连续 3 次点击同一目标 → 停止

### 意图快速路由（intent-lexicon.mjs）

第一步（step=1 + 无历史 + 包含导航关键词）时，先走轻量意图识别：
- 识别出明确导航意图（"打开 X 网站"）→ 直接返回 navigate 动作，跳过页面观察
- 不匹配 → 回退到完整页面规划

## 服务端 API（server.mjs）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查 |
| GET | `/api/settings` | 读取设置 |
| PUT | `/api/settings` | 保存设置（含 API Key） |
| GET | `/api/browser/state` | 当前页面状态 |
| POST | `/api/browser/navigate` | 导航到 URL |
| POST | `/api/browser/refresh` | 刷新页面 |
| POST | `/api/browser/click` | 点击目标 |
| POST | `/api/browser/pointer` | 手动鼠标操作 |
| POST | `/api/browser/show` | 显示浏览器窗口 |
| GET | `/api/browser/accessibility-snapshot` | 无障碍快照 |
| POST | `/api/extract/scrape` | Firecrawl 单页抓取 |
| POST | `/api/extract/crawl` | Firecrawl 站点爬取 |
| POST | `/api/extract/batch-scrape` | Firecrawl 批量抓取 |
| POST | `/api/extract/map` | Firecrawl 站点地图 |
| GET | `/api/webview-cdp/status` | Tauri WebView CDP 状态 |
| POST | `/api/webview-cdp/execute` | 通过 CDP 执行 WebView 动作 |
| POST | `/api/agent/observe` | 外部浏览器状态观测 |
| POST | `/api/agent/plan` | 外部浏览器动作规划 |
| **POST** | **`/api/chat`** | **核心：对话式任务执行（SSE 流式）** |

## 开发命令

```bash
npm install                    # pnpm install
npm run dev                    # 启动 local-server(4178) + Vite(5173)
npm run dev:server             # 仅启动 local-server
npm run dev:desktop            # 仅启动 Vite
npm run desktop:tauri -- dev   # Tauri 桌面客户端
npm run setup:browsers         # 安装 Playwright Chromium
npm run stop:dev               # 停止 4178 和 5173 端口
npm run build                  # 构建所有包
```

## 重要设计约束

1. **所有源文件使用 .mjs 或 .ts/.tsx 扩展名**，纯 ES Module
2. **Playwright 优先使用系统 Chrome**，不可用时回退到 Playwright Chromium
3. **Agent 操作必须通过 DOM 检查器先定位目标**，再用坐标点击
4. **高风险操作（登录、支付、删除、提交）必须经过 safety-guard 前置拦截**
5. **API Key 存储在 `storage/sqlite/settings.json`**，不回传给前端明文
6. **前端是单文件组件架构**，`App.tsx` 包含所有 UI 逻辑（~3000 行）
7. **LLM 返回必须是 JSON**，支持 `actions[]`（新）和 `action:{}`（旧）两种格式
8. **不针对特定网站编写逻辑**，所有规划和意图识别都基于通用词汇/模式匹配
9. **默认模型为 deepseek-v4-pro**，可选 deepseek-chat、deepseek-reasoner

## 当前开发状态（第一版）

- ✅ Tauri 客户端骨架：左右分栏布局（浏览器 + 聊天/设置）
- ✅ Playwright 浏览器控制：导航、点击、输入、滚动
- ✅ DeepSeek Agent 集成：单轮任务规划与动作执行
- ✅ 思考过程展示：SSE 流式推送规划/观察/执行日志
- ✅ 安全拦截：高风险动作需用户确认
- ✅ DOM 分析：可交互元素检测与目标定位
- ✅ 循环检测：LoopJudge + 确定性安全规则
- ✅ 内容提取：Firecrawl 集成
- ✅ WebView CDP 桥接：Tauri 模式下控制子 WebView
- ⬜ 多步骤复杂任务流程（task-engine）
- ⬜ 操作录制与回放（recorder/player）
- ⬜ 视觉模型接入
- ⬜ 任务报告生成
