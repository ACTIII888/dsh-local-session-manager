# DeepSeek Harness 本地会话管理工具

> 界面与交互**移植自** [codex-local-session-manager](https://github.com/zhengshukeji/codex-local-session-manager)（Apache-2.0），
> 数据层针对 DeepSeek Harness 的存储格式重写，详见 [来源与致谢](#来源与致谢)。

单文件网页工具，用于在本地浏览、检索、导出和清理 **DeepSeek Harness (DSH)** 的会话记录。
功能对齐 Codex 本地会话管理器（https://codex-local-session-manager.zhengshuyun.com/），数据格式适配 DSH 的 `~/.dsh` 目录。

## 快速开始

1. 打开 `dsh-session-manager.html`（推荐 Chrome / Edge 122+，需支持 File System Access API）。
2. 点击「选择目录」，在弹窗中选中你的 **`~/.dsh`** 目录（Windows 默认 `C:\Users\<你>\.dsh`）。
3. 首次授权后即可浏览会话列表；数据全程留在本机，不上传任何服务器。

## 截图

![会话列表与详情](test/screenshots/01-overview-light.png)

![对话时间线（显示全部语块）](test/screenshots/02-conversation-all-light.png)

![深色主题](test/screenshots/03-conversation-all-dark.png)

## 功能

- **会话扫描**：读取 `~/.dsh/sessions/<项目>/<会话>/session.v4.jsonl.zstd`，自动解压 zstd（含多帧拼接）并解析 JSONL。
- **投影缓存合并**：读取 `~/.dsh/storages/session_projcache/sessions/*.json` 与 `session_projcache_archive_manager_v2`，补齐标题、轮次、模型、权限、Token 用量等元数据。
- **脏索引识别**：区分「有缓存无会话」「有会话目录无日志」「空项目目录」「遗留扁平日志」四类陈旧项，并可一键清理。
- **列表与检索**：按更新时间 / 大小 / 标题排序，按时间范围、精确日期、仅陈旧项筛选；元数据搜索 + 正文（用户/助手消息）搜索，命中高亮。
- **会话详情**：概览面板（会话 ID、项目目录、大小、创建/更新时间、模型、权限、轮次/步骤、Token 出入、事件/异常行数）与对话时间线。
- **对话块过滤**：user / assistant / reasoning / toolCall / toolOutput / system 分类开关，默认隐藏 reasoning 与 system。
- **导出**：导出解压后的 JSONL，或下载原始 `.zstd` 文件。
- **删除**：删除当前会话 / 删除选中会话（倒计时确认弹窗，同时清理投影缓存）。
- **界面**：中文 / English 切换，浅色 / 深色主题。

## 实现要点

- 纯前端、零依赖构建产物：`dsh-session-manager.html` 内嵌 CSS、应用脚本与解码 worker。
- zstd 解码使用内置的 fzstd（`vendor/fzstd.min.js`），因为当前 Chromium 尚未提供 `DecompressionStream("zstd")`。
- 解码在 Web Worker 中进行，读取文件句柄后把 `ArrayBuffer` 转移给 worker，避免主线程卡顿。
- 扫描阶段只对文件前缀做「提前停止」解码以提取元数据（约 10 ms/文件），完整时间线在选中会话时按需解码并缓存。
- JSONL 解析容错：损坏行会被跳过并计入「异常行」统计，不会中断整篇会话的解析。

## 目录结构

- `src/index.html` — 页面模板，含 `{{STYLES}}` / `{{WORKER_JS}}` / `{{APP_JS}}` 占位符
- `src/app.js` — 主应用逻辑（扫描、筛选、渲染、导出、删除）
- `src/worker.js` — 解码 worker（元数据前缀解码 + 完整时间线解码）
- `src/styles.css` — 样式
- `vendor/fzstd.min.js` — zstd 解压库
- `build.mjs` — 构建脚本，生成单文件 `dsh-session-manager.html`
- `dsh-session-manager.html` — 构建产物（提交进仓库，可直接下载使用）
- `test/e2e.mjs` — 端到端测试（Playwright + OPFS 夹具）
- `test/file-url-check.mjs` — `file://` 直接打开的可用性校验
- `test/shot.mjs` — 界面截图脚本
- `LICENSE` / `NOTICE` — 本项目许可证与署名信息

## 开发

```powershell
# 修改 src/ 后重新构建单文件产物
node .\build.mjs

# 运行端到端测试（Playwright + 静态服务器 + OPFS 夹具）
node .\test\e2e.mjs
```

`test/e2e.mjs` 会把 `test/fixture/.dsh` 写入浏览器 OPFS，并把 `showDirectoryPicker` 打桩为 `navigator.storage.getDirectory()`，从而在没有真实文件系统授权的情况下验证完整流程。

```powershell
# 校验 file:// 直接打开的可用性（安全上下文 / 目录选择 / worker / zstd 解码）
node .\test\file-url-check.mjs

# 生成界面截图到 test/screenshots
node .\test\shot.mjs
```

`test/file-url-check.mjs` 用内存文件系统模拟用户选择的 `.dsh` 目录，验证双击打开 HTML（`file://`）时同样可以完整扫描与解码。

## 隐私

所有解析、检索、导出与删除都在浏览器本地完成，会话内容不会离开你的机器。

页面唯一的外部请求是可选字体样式表（Google Fonts 的 IBM Plex），且以非阻塞方式加载：加载失败或断网时自动回退到系统字体，不影响任何功能。如需完全离线，删除 `src/index.html` 中的该 `<link>` 后重新构建即可。
## 来源与致谢

本项目的界面结构、交互流程与部分样式**移植自开源项目**：

- [zhengshukeji/codex-local-session-manager](https://github.com/zhengshukeji/codex-local-session-manager) — Copyright (C) zhengshuyun.com，Apache-2.0 许可
  （原 `zhengshuyun-com/codex-local-session-manager` 已重定向至该仓库）

原项目用于管理 Codex 的本地会话（`~/.codex`）；本项目保留其界面与交互，将会话读取、zstd 解码、
投影缓存合并与脏索引清理等逻辑针对 **DeepSeek Harness（`~/.dsh`）** 的存储格式重新实现。

同时使用了以下第三方组件：

- [fzstd](https://github.com/101arrowz/fzstd) — Copyright (c) 2020 Arjun Barrett，MIT 许可，
  以 `vendor/fzstd.min.js` 内置，用于解压 DSH 的多帧 zstd 会话日志

完整的署名信息见 [NOTICE](NOTICE)，第三方许可证全文见 [vendor/fzstd.LICENSE.txt](vendor/fzstd.LICENSE.txt)。

## 许可证

[Apache License 2.0](LICENSE)