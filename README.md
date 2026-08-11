# QuoteVault

QuoteVault 是一款 Windows 本地聊天截图管理工具。它可以从剪贴板、拖放或文件选择器收录截图，使用离线 OCR 提取聊天内容，并按成员和用户自建的多级群组整理、检索与复制原图。

名称由两个英文词组成：`Quote` 表示语录或聊天片段，`Vault` 表示保险库或收藏库；合起来可以理解为“聊天语录保险库”。

## 当前功能

- 从剪贴板、文件选择器或拖放操作收录 PNG、JPEG、BMP、GIF 截图。
- 使用可配置的全局快捷键快速收录，默认 `Ctrl+Alt+F8`。
- 使用 Tesseract 对简体中文和英文执行离线 OCR。
- 新增截图时即可修改 OCR 消息、逐条指定发言人、添加消息及设置关键词。
- 已收录截图可以在“编辑”页继续修改；重新 OCR 不会把截图移出当前图库。
- 一张截图可关联多个成员，成员可归入用户自建的多级群组。
- 支持拖动成员到群组，并可将截图拖到其他成员图库、待处理或回收站。
- 支持框选、多选，以及批量移动、回收等操作；切换页面时自动退出多选。
- 左侧可搜索群组、成员和全部截图；中间可在当前图库内搜索消息、成员和关键词。
- 卡片视图用于同时浏览更多截图；列表视图展示更完整的消息信息。
- 待处理与回收站位于左侧底部；切换区域时会清除不再有效的预览，待处理截图可继续编辑，回收站支持还原和永久删除。
- 一键将整张原图复制到剪贴板。
- 支持完整图库 ZIP 备份与恢复；恢复前自动创建安全备份。

## 运行

需要 Windows 和 [.NET 9 Desktop Runtime](https://dotnet.microsoft.com/download/dotnet/9.0)。

```powershell
git clone https://github.com/Niannya/QuoteVault.git
cd QuoteVault
dotnet run
```

或直接运行发布产物：

```text
bin\Release\net9.0-windows\win-x64\publish\QuoteVault.exe
```

## 构建与验证

```powershell
dotnet restore
dotnet build -c Release
dotnet run -c Release -- --self-test
dotnet publish -c Release -r win-x64 --self-contained false
```

## 数据位置

```text
%LocalAppData%\QuoteVault\
├── data.json
└── images\
```

图片和索引只保存在本机，不会上传到云端。备份功能会将 `data.json` 与 `images` 一并打包。

## OCR 说明

当前使用 Tesseract 5，并打包 `chi_sim` 与 `eng` 模型。聊天截图中的复杂背景、表情、特殊字体和很小的字号可能导致误识别，因此新增和编辑流程始终允许人工修正。

群昵称候选目前根据 OCR 文本行和常见的“昵称：消息”形式推断。昵称行与消息行分开处理，不会弹出阻塞式确认窗口，也不会在未经用户操作时自动创建成员。

## 项目结构

- `MainForm.cs`：主窗口、导入、搜索、剪贴板、群组/成员操作和全局快捷键。
- `ui/`：主界面、原位弹层、设置页、批量操作和响应式布局。
- `AppStore.cs`：JSON 索引、图片管理、回收站和备份恢复。
- `OcrService.cs`：离线 OCR 与群昵称候选提取。
- `Models.cs`：数据模型。
- `SelfTest.cs`：无需 UI 的基础自检。
- `docs/PRODUCT-SPEC.md`：当前需求基线。
