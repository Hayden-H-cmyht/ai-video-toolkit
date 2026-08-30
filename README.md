# AI 视频工具箱 (avit) — 线上版

浏览器里直接跑的视频处理工具：**Whisper 字幕 · 批量转码 · 高光剪辑 · 清晰度增强**。
所有计算在你的浏览器内完成（WebAssembly / WebGPU），文件不上传任何服务器，
你的电脑关机后这个网站依然可用。

在线使用：https://hayden-h-cmyht.github.io/ai-video-toolkit/

## 线上版 vs 桌面版

| | 线上版（本站） | 桌面版（推荐） |
|---|---|---|
| 引擎 | ffmpeg.wasm + transformers.js | 真 FFmpeg + faster-whisper |
| 速度 | 慢（单线程 WASM） | 快 10-50 倍 |
| 文件上限 | 建议 ≤200MB / 短视频 | 无限制，支持文件夹批量 |
| 字幕烧录进画面 | 不支持 | 支持 |
| AI 超分 (Real-ESRGAN) | 不支持 | 支持（需显卡） |
| 需要安装 | 无 | Python + 依赖（install.bat 一键） |

桌面版源码与下载方法见主仓库的技术说明（README 底部）。

## 技术说明

- 字幕：transformers.js 加载 Xenova/whisper-{tiny,base,small}（WebGPU 优先，自动回退 WASM），
  模型从 hf-mirror.com 镜像下载
- 转码/高光/增强：@ffmpeg/ffmpeg 0.12（单线程 core，无需 COOP/COEP 头，GitHub Pages 直跑）
- 高光选段：16kHz PCM → 0.5s 窗 RMS 分贝 → 平滑 → 能量百分位选段，与桌面版算法一致
- 本仓库只含静态页面；桌面版（Python 后端 + 交互菜单 + CLI）在本地 `D:\zcode\ai-video-toolkit`
