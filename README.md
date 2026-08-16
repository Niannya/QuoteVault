# QuoteVault

一个面向 Windows 的本地聊天截图管理工具：收录截图、整理图库、搜索内容，并把原图快速复制回剪贴板。

## 设计方式

QuoteVault 把每张截图视为一张独立图片：

- 截图存放在一个由用户选择的图库中。
- “成员”只是图库的名称，方便用户按自己的习惯记忆和整理。
- “群组”用于归纳图库，并支持多级结构；它不代表截图实际来自哪个 QQ 群。
- 可搜索文本和标签都是可选的。即使不填写，也可以直接浏览和复制原图。
- OCR 只负责生成可编辑的搜索文本，不识别发言人，也不会自动创建成员。

## 使用流程

### 收录截图

可以通过以下方式添加图片：

- 从剪贴板读取；
- 选择本地图片文件；
- 把图片拖入应用；
- 使用全局快捷键快速暂存剪贴板图片，默认快捷键为 `Ctrl+Alt+F8`。

支持 PNG、JPEG、BMP 和 GIF。单张图片可以直接保存到当前图库；批量导入的图片会进入待处理区，便于之后继续整理。

### 整理图库

- 创建、重命名或删除群组和成员图库；
- 使用多级群组整理图库；
- 将成员拖入其他群组；
- 将截图拖到其他图库、待处理区或回收站；
- 通过框选或多选执行批量移动、回收、恢复和永久删除。

删除成员图库不会删除其中的原图，失去存放位置的截图会转入待处理区。

### 查找与使用

- 左侧搜索覆盖群组、成员图库和全部截图；
- 中间搜索只查找当前图库、待处理区或回收站；
- 搜索范围包括文件名、可搜索文本和标签；
- 截图可以按添加时间或文件名排序；在回收站中，时间排序使用删除时间；
- 支持卡片视图和信息更完整的列表视图；
- 选中截图后可以把整张原图复制到剪贴板。

界面的左侧图库、中间浏览区和右侧工作区均可拖动调整宽度。布局和排序偏好会自动保存，也可以在设置中恢复默认布局。

## OCR

OCR 并不是使用 QuoteVault 的必要条件。默认设置为“不使用 OCR”，用户可以直接填写搜索文本或将其留空。

| 方式 | 适用场景 | 安装情况 |
| --- | --- | --- |
| 不使用 OCR | 只保存图片，或手动填写搜索文本 | 默认选项，无额外依赖 |
| Tesseract 5 | 轻量、快速的基础文字识别 | 随应用提供 |
| PaddleOCR v6 | 更重视中文和复杂截图的识别效果 | 按需安装，约占用 900 MB |

默认 OCR 方式可以在设置中选择；添加或编辑截图时，也可以只为当前图片临时切换识别方式。识别在后台执行，结果始终可以修改、清空或重新识别。

首次选择 PaddleOCR 时，应用会先显示安装确认，不会在后台自动下载。运行环境和模型安装到：

```text
%LocalAppData%\QuoteVault\paddle-runtime\
%LocalAppData%\QuoteVault\paddle-models\
```

## 数据与隐私

图片、索引、搜索文本、标签和设置均保存在本机：

```text
%LocalAppData%\QuoteVault\
├── data.json
├── images\
├── backups\
├── paddle-runtime\    # 仅安装 PaddleOCR 后存在
└── paddle-models\     # 仅安装 PaddleOCR 后存在
```

QuoteVault 不会把截图上传到云端。设置页可以导出包含索引与全部原图的完整 ZIP 备份，也可以从备份恢复；执行恢复前，应用会自动创建一份安全备份。

## 运行要求

- Windows 10 或 Windows 11；
- [.NET 9 Desktop Runtime](https://dotnet.microsoft.com/download/dotnet/9.0)；
- Microsoft Edge WebView2 Runtime。

从源码运行：

```powershell
git clone https://github.com/Niannya/QuoteVault.git
cd QuoteVault
dotnet run
```

如果已经取得发布包，也可以直接运行其中的 `QuoteVault.exe`。

## 构建与验证

```powershell
dotnet restore
dotnet build -c Release
dotnet run -c Release -- --self-test
dotnet publish -c Release -r win-x64 --self-contained false
```

可以单独输出两种 OCR 的识别结果，用于本地比较：

```powershell
dotnet run -c Release -- --ocr-test "截图.png"
dotnet run -c Release -- --paddle-ocr-test "截图.png"
```

PaddleOCR 也可以通过源码中的脚本手动安装：

```powershell
powershell -ExecutionPolicy Bypass -File .\paddleocr\setup-runtime.ps1 -DownloadModels
```

## 代码结构

```text
QuoteVault/
├── MainForm.cs             # 主窗口、导入流程、剪贴板和界面消息处理
├── AppStore.cs             # 本地数据、图片文件、备份与恢复
├── Models.cs               # 数据模型和应用设置
├── OcrService.cs           # Tesseract OCR
├── PaddleOcrService.cs     # PaddleOCR 后台工作进程
├── paddleocr/              # PaddleOCR 脚本、依赖和安装器
├── ui/                     # WebView2 界面
└── SelfTest.cs             # 无需启动界面的基础自检
```
