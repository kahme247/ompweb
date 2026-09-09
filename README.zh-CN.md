# ompweb

[![npm version](https://img.shields.io/npm/v/@kahme247/ompweb.svg?logo=npm&color=e05d44)](https://www.npmjs.com/package/@kahme247/ompweb)
[![node version](https://img.shields.io/node/v/@kahme247/ompweb.svg?logo=node.js&color=44cc11)](https://nodejs.org)
[![license](https://img.shields.io/github/license/kahme247/ompweb.svg?color=44cc11)](./LICENSE)
[![npm downloads](https://img.shields.io/npm/dm/@kahme247/ompweb.svg?color=44cc11)](https://www.npmjs.com/package/@kahme247/ompweb)
[![GitHub stars](https://img.shields.io/github/stars/kahme247/ompweb.svg?logo=github)](https://github.com/kahme247/ompweb/stargazers)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/kahme247/ompweb/pulls)

[English](./README.md) | [简体中文](./README.zh-CN.md) | [日本語](./README.ja.md)

社区：[加入 OMPWEB Discord](https://discord.gg/evqgGzRfM5)

[oh-my-pi (omp)](https://github.com/can1357/oh-my-pi) 编程智能体的现代 Web UI。它读取本地的 omp 会话，在浏览器中提供实时对话、项目会话浏览、配置管理和文件预览等功能。

![ompweb — 演示](docs/demo.gif)

<details>
<summary>截图（浅色 / 深色主题）</summary>

![ompweb — 浅色主题](docs/screenshot-light.png)

![ompweb — 深色主题](docs/screenshot-dark.png)

</details>

## 环境要求

- 已安装 [omp](https://github.com/can1357/oh-my-pi) 且在 `PATH` 中（或通过 `OMP_WEB_OMP_BIN` 指定路径）
- Node.js `>= 22.19.0`

## 快速开始

**免安装直接运行：**

```bash
npx @kahme247/ompweb@latest
```

**或全局安装：**

```bash
npm install -g @kahme247/ompweb
ompweb
```

在浏览器中打开 [http://127.0.0.1:30177](http://127.0.0.1:30177)。

### CLI 选项

```bash
ompweb --port 8080                         # 自定义端口
ompweb --hostname 0.0.0.0                  # 监听网络地址
ompweb --password "your-password"          # 启用密码保护
ompweb --no-open                           # 不自动打开浏览器
```

## 功能特性

- **实时对话**：与本地 `omp` 智能体进行低延迟流式交互。
- **会话管理**：按项目浏览历史会话，支持会话分叉与分支回溯。
- **实时任务与子智能体**：可折叠面板实时展示任务清单（todo）与子智能体进度，并支持查看完整转录。
- **文件管理与预览**：与对话并排浏览文件，支持代码、Markdown、图片、音频及 PDF 预览。
- **Git Worktree 支持**：直接在侧边栏切换与管理 Git 工作树。
- **可视化设置**：在 Web 界面中直接配置模型、API 密钥、MCP 服务器、技能、插件及 OMP 原生设置。
- **快捷指令与命令面板**：内置常用指令（`/plan`、`/review`、`/fix`、`/test` 等）及 `⌘K` / `Ctrl+K` 全局面板。
- **主题与多语言**：温暖纸感深浅主题，完整支持英语、简体中文及日本語。

## 环境变量

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `PORT` | 服务端口 | `30177` |
| `OMP_WEB_HOSTNAME` | 绑定主机名 | `127.0.0.1` |
| `OMP_WEB_PASSWORD` | 可选的 Web 访问密码 | _无（未启用验证）_ |
| `OMP_WEB_NO_OPEN` | 设为 `1` 时禁止自动打开浏览器 | `0` |
| `OMP_WEB_OMP_BIN` | `omp` 二进制路径（未在 PATH 时使用） | _自动检测_ |
| `PI_CODING_AGENT_DIR` | 自定义 omp agent 目录 | `~/.omp/agent` |
| `OMP_WEB_STT_ENDPOINT` | OpenAI 兼容的语音转文字接口 URL | _无（默认禁用）_ |
| `OMP_WEB_STT_KEY` | STT 接口对应的 API Key | _无_ |
| `OMP_WEB_STT_MODEL` | STT 接口的模型名称 | _无_ |

## 本地开发

```bash
git clone https://github.com/kahme247/ompweb.git
cd ompweb
npm install
npm run dev
```

本地开发服务器运行在 [http://127.0.0.1:30178](http://127.0.0.1:30178)。

### 代码检查

```bash
npm run typecheck   # TypeScript 类型检查
npm run lint        # ESLint 检查
npm test            # 运行测试套件
```

> **注意**：本地开发期间请勿运行 `npm run build`，以免污染 `.next/` 导致开发服务器异常。

## 致谢与许可证

- 分叉自 [agegr/pi-web](https://github.com/agegr/pi-web)（MIT），针对 [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) 进行适配。
- 采用 [MIT 许可证](./LICENSE) 开源。
