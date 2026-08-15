# QuoteVault

QuoteVault 是一款 Windows 本地聊天截图管理工具。它可以从剪贴板、拖放或文件选择器收录截图，使用离线 OCR 提取聊天内容，并按成员和用户自建的多级群组整理、检索与复制原图。

## 当前功能

### 截图收录与识别

- 从剪贴板、文件选择器或拖放操作收录 PNG、JPEG、BMP、GIF 图片。
- 通过可配置的全局快捷键快速收录，默认快捷键为 `Ctrl+Alt+F8`。
- 默认使用实验性的 PaddleOCR v6 medium 在本机识别简体中文和英文，并保留 Tesseract 兼容模式。
- 根据文字坐标与气泡背景合并同一条消息中的多行文本，并分离带时间的昵称行。
- 收录时可以直接校正识别结果、设置每条消息的发言人、编辑多行消息并添加自定义关键词。

### 图库组织

- 以成员图库管理截图，一张截图可以关联多个成员。
- 使用用户自建的多级群组整理成员，成员也可以暂时保留在“未分组”中。
- 提供待处理区暂存尚未整理的截图，并通过回收站完成还原或永久删除。
- 支持拖动成员调整群组，以及在成员图库、待处理区和回收站之间拖动截图。

### 浏览与批量管理

- 默认采用深色界面，并针对窗口化与全屏布局进行适配。
- 卡片视图适合同时浏览更多截图，列表视图用于查看更完整的消息摘要。
- 支持鼠标框选、多选、批量移动和批量回收。
- 右侧面板提供原图预览、截图添加和消息编辑。

### 检索与复用

- 全局搜索群组、成员、消息内容和自定义关键词。
- 在当前成员图库、待处理区或回收站内进行范围检索。
- 将选中的整张原图复制到剪贴板，便于重新发送。

### 本地数据

- 图片、成员、群组、消息和关键词索引全部保存在本机。
- 支持将完整图库导出为 ZIP 备份，并从备份恢复数据。

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
├── images\
└── backups\
```

图片和索引只保存在本机，不会上传到云端。备份功能会将 `data.json` 与 `images` 一并打包；恢复前的安全备份保存在 `backups` 中。

## OCR 说明

测试版默认使用 PaddleOCR v6 medium。首次使用前运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\paddleocr\setup-runtime.ps1
```

运行环境会安装到 `%LocalAppData%\QuoteVault\paddle-runtime`，模型会在首次识别时下载到 `%LocalAppData%\QuoteVault\paddle-models`。下载完成后识别过程完全在本机执行。设置页可以切换回 Tesseract 5 兼容模式。

当前实验运行环境与模型合计约占用 900 MB，尚未针对正式发布包压缩；后续会再评估原生推理或更轻量的运行时。

可以直接比较两个引擎的输出：

```powershell
dotnet run -c Release -- --ocr-test "截图.png"
dotnet run -c Release -- --paddle-ocr-test "截图.png"
```

聊天截图中的复杂背景、表情、特殊字体和很小的字号仍可能导致误识别，因此新增和编辑流程始终允许人工修正。

PaddleOCR 模式会结合文字坐标、相邻区域背景和常见昵称特征推断消息块；Tesseract 兼容模式仍使用文本行规则。识别结果不会在未经用户操作时自动创建成员。

## 项目结构

- `MainForm.cs`：主窗口、导入、搜索、剪贴板、群组/成员操作和全局快捷键。
- `ui/`：主界面、原位弹层、设置页、批量操作和响应式布局。
- `AppStore.cs`：JSON 索引、图片管理、回收站和备份恢复。
- `OcrService.cs`：离线 OCR 与群昵称候选提取。
- `PaddleOcrService.cs`、`paddleocr/`：PaddleOCR v6 实验工作进程、消息分组与运行环境安装。
- `Models.cs`：数据模型。
- `SelfTest.cs`：无需 UI 的基础自检。
