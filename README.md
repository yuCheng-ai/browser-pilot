# BrowserPilot

中文名：浏览器领航员

BrowserPilot 是一个本地浏览器 Agent 客户端，用于在用户自己的浏览器环境中执行网页任务、提取网页数据、录制和回放流程，并对登录态和高风险操作提供本地可控的安全边界。

## 产品定位

- 本地优先：浏览器状态、截图、任务记录和登录态默认留在本机。
- Agent 驱动：把网页操作、页面理解、任务调度和结果报告组合成可追踪的执行链。
- 面向真实业务页面：支持后台系统、登录态任务、本地项目验收和竞品资料调研。

## 产品边界

- 浏览器自动操作
- 网页任务执行
- 网页数据提取
- 流程录制回放
- 登录态任务执行
- 本地项目自动验收
- 业务后台自动操作
- 竞品和资料自动调研

## 目录结构

```text
browser-pilot/
|-- apps/
|   `-- desktop/              # Tauri + React 客户端
|-- services/
|   `-- local-server/         # 本地 Agent 服务
|-- packages/
|   |-- browser-core/         # 浏览器控制核心：open/click/type/scroll
|   |-- agent-runtime/        # Agent 任务调度与工具调用
|   |-- recorder/             # 操作录制
|   |-- player/               # 操作回放
|   |-- dom-inspector/        # DOM / Accessibility Tree 分析
|   |-- vision-inspector/     # 截图理解，后期接入视觉模型
|   |-- task-engine/          # 多步骤任务执行
|   |-- extractor/            # 网页内容提取
|   |-- safety-guard/         # 登录、支付、删除、提交等风险拦截
|   `-- report-engine/        # 任务报告生成
|-- integrations/
|   |-- playwright/           # Playwright 适配层
|   |-- chrome-cdp/           # Chrome DevTools Protocol 适配层
|   |-- openai/               # OpenAI 模型适配
|   |-- ollama/               # 本地模型适配
|   `-- code-run-guard/       # 代码验收场景扩展
|-- storage/
|   |-- sqlite/               # 本地数据库
|   |-- profiles/             # 浏览器用户数据、cookie、登录态
|   |-- snapshots/            # 截图、DOM、页面快照
|   `-- task-runs/            # 每次任务执行记录
|-- docs/
|   |-- product.md
|   |-- architecture.md
|   |-- roadmap.md
|   `-- safety.md
`-- README.md
```

## 文档

- [产品定义](./docs/product.md)
- [架构说明](./docs/architecture.md)
- [路线图](./docs/roadmap.md)
- [安全边界](./docs/safety.md)

## 初始实现顺序

1. 在 `packages/browser-core` 和 `integrations/playwright` 建立最小浏览器控制闭环。
2. 在 `packages/task-engine`、`packages/agent-runtime` 和 `services/local-server` 建立任务执行接口。
3. 在 `apps/desktop` 提供任务输入、执行状态、截图和报告查看界面。
4. 在 `packages/safety-guard` 前置登录、支付、删除、提交等高风险动作拦截。
5. 在 `packages/recorder`、`packages/player`、`packages/extractor` 和 `packages/report-engine` 扩展可复用工作流。

## 第一版开发态

当前第一版已经提供：

- Tauri 客户端骨架：React 主界面右侧承载对话和设置，左侧由 Tauri 子 WebView 直接加载网页。
- Web 调试预览：在普通 Vite 页面下保留截图预览、手动鼠标输入桥接和 DOM 可点击目标覆盖层。
- 右侧任务对话：通过本地服务请求 DeepSeek，单轮执行一次导航、点击或输入动作。
- 本地设置：DeepSeek API Key 写入本地忽略目录，不回传给桌面端显示。
- 点击原则：Agent 动作先由 DOM 检查器找目标，再计算 bounding box 中心点，再由 Playwright 鼠标输入执行坐标点击。
- 客户端浏览器：Tauri 模式下左侧是真 WebView，验证码、登录安全验证和复杂键鼠交互在客户端内人工完成。

启动：

```bash
npm install
npm run dev
```

桌面开发界面默认在 `http://127.0.0.1:5173`，本地服务默认在 `http://127.0.0.1:4178`。

启动 Tauri 客户端：

```bash
npm run desktop:tauri -- dev
```

浏览器控制层默认优先使用系统 Chrome。系统 Chrome 不可用且本机还没有 Playwright Chromium 时，先执行：

```bash
npm run setup:browsers
```
