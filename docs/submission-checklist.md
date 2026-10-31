# 仓库提交清单

核对日期：2026-10-31（Asia/Shanghai）。依据用户提供的作品提交要求截图，仅检查和完善其中“代码仓库”部分；演示视频和技术文档属于独立交付物。

## 截图要求逐项核对

| 要求 | 当前状态 | 证据 / 最后一步 |
| --- | --- | --- |
| GitHub / Gitee，Public 或提供评审访问权限 | 本地已配置 GitHub 远程；远程可见性与权限待上传者确认 | `origin = https://github.com/Gollet488/cnzjz.git`；发布后核对评审可访问 |
| 代码结构清晰、有效注释、遵循主流规范 | 已有模块化源码、关键协议说明、格式/lint/类型检查及测试 | `src/`、`tests/`、ESLint、Prettier、TypeScript；[系统架构](architecture.md) |
| README 含项目介绍 | 已具备 | [README](../README.md) 的项目定位、功能与边界 |
| README 含技术架构 | 已补齐 | README 技术架构与 [系统架构](architecture.md) 的技术栈、职责、数据流 |
| README 含安装运行指南 | 已具备并补充环境入口 | README 启动、使用、检查；[环境配置](environment.md) |
| README 含团队信息 | 已完成 | 团队“CN终结者”，3 人；按用户要求只保留团队名称和人数 |
| 保留完整 Git 历史，体现真实开发过程 | 原有 13 条可达提交保留，本次改动待用户提交 | 从当前仓库推送；不使用不含历史的旧 `.delivery/` 副本重新建仓 |
| 完整环境说明、环境变量模板、依赖清单 | 已补齐 | `.node-version`、`package.json`、`pnpm-lock.yaml`、[.env.example](../.env.example)、[环境配置](environment.md) |

## 本次本机验证

检查使用 Node 24.22.1、pnpm 11.25.0；以下为本次实际结果。

| 检查 | 结果 |
| --- | --- |
| `pnpm install --frozen-lockfile --offline` | 通过；使用本机已有缓存验证锁文件安装，未验证全新机器联网下载 |
| `pnpm prepare:assets` | 通过；模型哈希、MediaPipe 和本地 FFmpeg 资源验证通过 |
| `pnpm format:check` / `pnpm lint` | 通过 |
| `pnpm test` | 348/348 通过；首次有 3 项受限于沙箱的 Windows CIM 查询，放行进程身份检查后完整复验通过 |
| `pnpm build` | 通过，包含类型检查；ECharts 分块约 595 kB，保留体积提示 |
| Chrome 开发 / 生产浏览器回归 | 62 项通过，2 项需授权真人视频的用例跳过；报告无失败与重试 |
| `.env` 启动入口 | 开发和生产预览均 HTTP 200；使用空 `.env.example` 验证启动参数，未读写真实密钥文件或请求模型 |
| 常见密钥特征与实际 `.env` 路径检查 | 当前 182 个候选文件及 13 条可达提交（202 个唯一历史文件对象）未发现命中；不是完整安全审计 |

浏览器回归设置 `BROWSER_CHANNEL=chrome`、`BROWSER_VITE_CACHE=.qa/submission-vite-cache`，隔离本机已有开发服务的预打包缓存。首次 MKV 导入暴露的 FFmpeg 动态依赖加载问题已通过补充 Vite 预打包声明修复，随后重新完整运行两组回归。用例完成后，框架在此 Windows 环境等待临时服务退出；核对命令行、PID 和创建时间后仅停止本轮两个测试服务，最终命令退出码为 0。详细本机记录保存在被 Git 忽略的 `.qa/submission-*.log` 和 `test-results/browser-results.json`。

本次不请求真实模型，不采集私人摄像头或真实人体视频。自动测试的合成输入和脚本化模型响应不能证明真实人体精度或真实模型效果。远程 Actions、Public 状态和评审访问权限尚未验证。

## 上传前剩余事项

1. 按 [构建与交付](delivery.md) 从当前仓库检查差异、提交并推送，保留已有历史；不要上传旧交付 ZIP 替代 Git 仓库。
2. 确认 GitHub 仓库 Public 或给予评审访问权限，查看远程 Actions 是否通过，并用新目录克隆后核对安装说明。
3. 单独准备截图要求的 5–8 分钟、1080p 及以上 MP4 演示视频，以及不超过 30 页的技术 PDF；现有 Markdown 文档不等于已交付参赛 PDF。

本次只完善本地仓库，不创建虚构团队资料、不补造开发记录；原有提交及用户未提交功能改动保留，由用户最终上传。
