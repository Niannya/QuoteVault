# QuoteVault

QuoteVault 是一款 Windows 本地聊天截图图库。它可以从剪贴板、拖放或文件选择器收录截图，放入按成员命名的图库，并通过可选的 OCR 文本和标签快速检索、复制原图。

## 当前功能

### 截图收录与编辑

- 支持 PNG、JPEG、BMP、GIF 图片，以及剪贴板、文件选择和拖放收录。
- 支持可配置的全局收录快捷键，默认是 `Ctrl+Alt+F8`。
- 添加截图时可直接校正整张截图的可搜索文本并设置标签；两者都可以留空。
- 已收录截图可随时重新编辑或重新 OCR。
- 设置页只决定以后导入时的默认 OCR；添加与编辑页面可为当前截图临时切换，不会修改全局默认值。
- OCR 在后台执行；识别期间仍可浏览、搜索、预览和管理其他截图。

### 图库组织

- 成员只是一个便于用户记忆的图库名称，不参与截图内容、发言人或身份判断。
- 每张截图只存放在一个图库中；移动操作只改变存放位置。
- 使用用户自建的多级群组整理成员，成员也可保留在“未分组”中。
- 提供待处理区和回收站，并支持恢复或永久删除。
- 支持拖动成员调整群组，以及在成员图库、待处理区和回收站之间拖动截图。

### 浏览、检索与批量操作

- 深色界面，支持卡片视图和信息更完整的列表视图。
- 支持鼠标框选、多选、批量移动和批量回收。
- 支持全局搜索群组、成员图库、可搜索文本和标签，也支持图库内搜索。
- 可将选中的整张原图复制到剪贴板。

### OCR

- **默认不使用 OCR**，导入后可直接保存，也可以手动填写可搜索文本。
- 设置页可选择 Tesseract 5 轻量兼容模式。
- PaddleOCR v6 medium 作为可选的高质量中文识别方案；选择时由用户确认是否安装，不随主程序打包。
- PaddleOCR 模式会结合文字坐标与相邻区域背景整理多行正文；昵称和群等级只作为界面噪声过滤，不会作为身份数据保存。
- OCR 结果统一进入一个可编辑的大文本框，不拆分消息、不识别发言人，也不会自动创建成员。

## 运行

需要 Windows 和 [.NET 9 Desktop Runtime](https://dotnet.microsoft.com/download/dotnet/9.0)。

```powershell
git clone https://github.com/Niannya/QuoteVault.git
cd QuoteVault
dotnet run
```

也可以直接运行发布目录中的 `QuoteVault.exe`。

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
├── images\
└── backups\
```

图片和索引只保存在本机，不会上传到云端。完整备份包含 `data.json` 和 `images`。

## 可选安装 PaddleOCR

在设置页选择 PaddleOCR 后，应用会先说明预计占用空间，并在用户确认后安装：

```text
运行环境：%LocalAppData%\QuoteVault\paddle-runtime
识别模型：%LocalAppData%\QuoteVault\paddle-models
合计占用：约 900 MB
```

也可以在源码目录中手动安装：

```powershell
powershell -ExecutionPolicy Bypass -File .\paddleocr\setup-runtime.ps1 -DownloadModels
```

安装和模型下载完成后，识别过程完全在本机执行。复杂背景、特殊字体和很小的字号仍可能导致误识别，因此添加和编辑流程始终允许人工修正。

可使用以下命令单独比较识别输出：

```powershell
dotnet run -c Release -- --ocr-test "截图.png"
dotnet run -c Release -- --paddle-ocr-test "截图.png"
```

## 项目结构

- `MainForm.cs`：主窗口、导入、搜索、剪贴板、群组/成员操作和全局快捷键。
- `ui/`：主界面、设置页、批量操作和响应式布局。
- `AppStore.cs`：JSON 索引、图片管理、回收站和备份恢复。
- `OcrService.cs`：Tesseract 离线 OCR。
- `PaddleOcrService.cs`、`paddleocr/`：可选 PaddleOCR 工作进程、文本整理和安装脚本。
- `Models.cs`：数据模型。
- `SelfTest.cs`：无需 UI 的基础自检。
