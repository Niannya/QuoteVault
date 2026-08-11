# QuoteVault

QuoteVault 是一个 Windows 本地聊天截图库。它可以从剪贴板、拖拽或文件选择器收录截图，使用离线 OCR 提取中文消息，并按成员和用户自建的多级群组整理、检索与复制原图。

## 当前 MVP 功能

- 从剪贴板按钮收录截图。
- 使用可配置全局快捷键快速收录（默认 `Ctrl+Alt+F8`）。
- 拖拽或批量导入 PNG、JPEG、BMP、GIF 图片。
- 将原图复制到 `%LocalAppData%\QuoteVault\images` 统一管理。
- 使用 Tesseract 进行简体中文和英文离线 OCR。
- OCR 消息逐行编辑，并可为每行指定发言人。
- 一张截图可关联多个成员。
- 用户自建多级群组，一个成员可属于多个群组。
- 按消息内容、成员名称与自定义关键词检索截图。
- 在左侧空白处右键或使用 `＋` 原位新建群组和成员图库。
- 卡片二级菜单、右键菜单与批量选择操作。
- 重复图片导入提示，由用户决定继续、跳过或查看已有截图。
- 一键复制整张原图到剪贴板。
- 软件内回收站、恢复与永久删除。
- 完整图库 ZIP 备份及恢复；恢复前自动创建安全备份。

## 运行

需要 Windows 和 [.NET 9 Desktop Runtime](https://dotnet.microsoft.com/download/dotnet/9.0)。

```powershell
cd D:\Project\QuoteVault
dotnet run
```

或者直接运行构建产物：

```text
D:\Project\QuoteVault\bin\Release\net9.0-windows\win-x64\publish\QuoteVault.exe
```

## 构建与验证

```powershell
dotnet restore
dotnet build
dotnet run -- --self-test
dotnet publish -c Release -r win-x64 --self-contained false
```

## 数据位置

```text
%LocalAppData%\QuoteVault\
├── data.json
└── images\
```

图片和索引不会上传到云端。备份功能会把 `data.json` 和 `images` 一并打包。

## OCR 说明

当前使用 Tesseract 5，并打包 `chi_sim` 与 `eng` 模型。聊天截图中的复杂背景、表情、特殊字体和很小的字号可能导致误识别，因此识别结果始终允许人工修正。

群昵称候选目前基于 OCR 文本行和常见的“昵称：消息”形式推断。昵称行与消息行会分开处理，不会弹出阻塞式确认窗口，也不会在未经用户操作时自动创建成员。后续应使用匿名化的真实截图样本继续调整版面分析与候选规则。

## 项目结构

- `MainForm.cs`：主窗口、导入、检索、剪贴板、群组/成员操作和全局快捷键。
- `ui/`：主界面、原位弹层、设置页、批量操作及响应式布局。
- `AppStore.cs`：JSON 索引、图片管理、回收站和备份恢复。
- `OcrService.cs`：离线 OCR 与群昵称候选提取。
- `Models.cs`：数据模型。
- `SelfTest.cs`：无需 UI 的基础自检。
- `docs/PRODUCT-SPEC.md`：当前需求基线。
