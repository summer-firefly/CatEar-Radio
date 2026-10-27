# 猫耳收音机

多音源音乐搜索与播放客户端。

技术栈：**Rust（Tauri 2）后端 + 系统 WebView 前端（Vite + TypeScript）**。参考 [BlueMusic](../BlueMusic) 的产品结构与音源抽象。

## 支持平台

仅支持：

- **macOS**
- **Windows**
- **Android**

不维护 iOS / Linux 等其它目标。

## 功能

- 多音源搜索：网易云 / QQ / 酷我（交错合并，支持加载更多）
- 发现页：热门歌曲与榜单歌单
- 正在播放：进度、歌词、播放模式（列表循环 / 单曲循环 / 随机）
- 我的：收藏、自建歌单、JSON 导入导出
- 设置：启用音源、每源结果数
- 本地播放：WebView HTML5 Audio（由 Rust 解析播放地址）

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
npm run tauri -- android build --apk --ci --target aarch64
```

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
├── package.json
└── README.md
```

## 说明

Apache-2.0 风格学习演示项目。音乐版权归各平台及原作者；第三方聚合 API 仅作演示，请勿用于商业用途。
