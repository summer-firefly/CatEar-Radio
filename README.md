# 猫耳收音机

多音源音乐搜索与播放客户端。

技术栈：**Rust（Tauri 2）后端 + 系统 WebView 前端（Vite + TypeScript）**。

字体：**Zen Maru Gothic / Noto Sans SC** 已本地托管（`src/assets/fonts`），不再依赖 Google Fonts。

## 支持平台

仅支持：

- **macOS**
- **Windows**
- **Android**

不维护 iOS / Linux 等其它目标。

## 功能

- 多音源搜索：网易云 / QQ / 酷我（交错合并，按页翻看；单源失败可见；播放可跨页续播）
- 发现页：热门歌曲、榜单歌单；列表按窗口高度分页
- 我的：收藏（分页）、最近播放、自建歌单（新建 / 重命名 / 删除、曲目移除与排序）、导入导出备份
- 播放：进度、音量、播放模式（列表循环 / 单曲循环 / 随机）、定时关闭；窄屏保留进度条与模式切换
- 系统媒体控制：桌面 Media Session；Android 通知栏 / 锁屏控制
- 歌词：侧栏高亮、字号调节、时间偏移、点击跳转
- 下载：歌曲本地下载；设置中可改下载目录
- 设置：启用音源、每源结果数、音源 JSON 导入

## 环境

- Rust 1.77+（推荐通过 rustup）
- Node.js 18+
- macOS / Windows：系统 WebView
- Android：Android SDK + NDK（`tauri android`）

## 运行

```bash
cd 猫耳收音机
npm install
npm run tauri dev
```

## 打包

```bash
# macOS / Windows（在对应系统或按文档交叉编译 Windows）
npm run tauri build

# Android
npm run tauri -- android build --apk --ci
```

产物说明见 [`releases/README.md`](releases/README.md)。

## 工程结构

```
猫耳收音机/
├── src/                 # WebView 前端
├── src-tauri/
│   ├── gen/android/     # Android 工程（Tauri 生成）
│   └── src/
│       ├── commands.rs  # Tauri IPC
│       ├── model.rs     # Track / 歌单 / 设置
│       ├── source/      # 各音源 HTTP 客户端
│       ├── repo/        # 搜索合并、推荐
│       ├── library.rs   # 收藏与歌单持久化
│       └── settings.rs
├── releases/            # 本地构建产物（不入库）
├── package.json
└── README.md
```

## 说明

Apache-2.0 风格学习演示项目。音乐版权归各平台及原作者；第三方聚合 API 仅作演示，请勿用于商业用途。
