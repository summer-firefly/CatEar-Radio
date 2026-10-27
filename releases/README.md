# 猫耳收音机 0.1.0 构建产物

仅保留目标平台包：

| 平台 | 文件 | 说明 |
|------|------|------|
| macOS arm64 | `猫耳收音机_0.1.0_aarch64.dmg` | 桌面安装包 |
| Windows x64 | `猫耳收音机_0.1.0_x64-setup.exe` / `maoer_radio.exe` | NSIS / 便携（未签名） |
| Android | `CatEar-Radio_0.1.0_universal-release.apk` | 已签名 APK（侧载） |

不产出、不维护 iOS / Linux 等其它包。Android 签名密钥保存在本地 `src-tauri/android-signing/`（不入库）。
