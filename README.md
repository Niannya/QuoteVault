# QuoteVault

一个面向 Windows 的本地聊天截图管理工具：收录截图、整理图库、搜索内容，并把原图快速复制回剪贴板。

## 下载与运行

前往 [Releases](https://github.com/Niannya/QuoteVault/releases/latest) 下载名称中带有 `win-x64` 的 ZIP 压缩包。下载完成后请先完整解压，再双击其中的 `QuoteVault.exe`；不要直接在压缩包预览窗口中运行程序。

发布包已经包含 .NET 运行环境，不需要另外安装 .NET。Windows 10 和 Windows 11 通常已经带有 Microsoft Edge WebView2 Runtime；如果程序提示缺少 WebView2，请自行搜索并安装 Microsoft Edge WebView2 Runtime。

## 使用流程

### 收录截图

可以通过以下方式添加图片：

- 从剪贴板读取；
- 选择本地图片文件；
- 把图片拖入应用；
- 使用全局快捷键快速暂存剪贴板图片，默认快捷键为 `Ctrl+Alt+Q`。

快捷键可以在设置页中点击快捷键框后，直接按下新的键盘组合进行录入。

支持 PNG、JPEG、BMP 和 GIF。单张图片可以直接保存到当前图库；批量导入的图片会进入待处理区，便于之后继续整理。

### 整理图库

- 创建、重命名或删除群组和成员图库；
- 使用多级群组整理图库；
- 通过框选或多选执行批量添加标签、移动、回收、恢复和永久删除。

删除成员图库不会删除其中的原图，失去存放位置的截图会转入待处理区。

### 查找与使用

- 左侧搜索覆盖群组、成员图库和全部截图；中间搜索只查找当前图库、待处理区或回收站；搜索范围包括文件名、可搜索文本和标签；
- 截图可以按添加时间或文件名排序；
- 支持卡片视图和信息更完整的列表视图；
- 选中截图后可以把整张原图复制到剪贴板。

界面的左侧图库、中间浏览区和右侧工作区均可拖动调整宽度。窗口位置、窗口大小、卡片/列表模式、群组折叠状态、布局、深浅主题和排序偏好都会自动保存，也可以在设置中恢复默认布局。默认使用深色主题。

设置页提供分类导航和搜索，可以直接定位界面、OCR、快捷键及数据备份选项。

## OCR

OCR 并不是使用 QuoteVault 的必要条件。默认设置为“不使用 OCR”，用户可以直接填写搜索文本或将其留空。

| 方式 | 适用场景 | 安装情况 |
| --- | --- | --- |
| 不使用 OCR | 只保存图片，或手动填写搜索文本 | 默认选项，无额外依赖 |
| PaddleOCR v6 | 更重视中文和复杂截图的识别效果 | 按需安装，约占用 900 MB |

默认 OCR 方式可以在设置中选择；添加或编辑截图时，也可以只为当前图片临时切换识别方式。识别在后台执行，结果始终可以修改、清空或重新识别。

QuoteVault 不在应用内下载 PaddleOCR。未安装时选择 PaddleOCR，软件会显示说明并提供本仓库的安装指南链接；用户可以在 GitHub 页面自行决定是否下载。安装完成后重新打开 QuoteVault 即可使用。设置页也可以删除已经安装的 PaddleOCR，删除不会影响已保存的截图和文字。运行环境和模型安装到：

```text
%LocalAppData%\QuoteVault\paddle-runtime\
%LocalAppData%\QuoteVault\paddle-models\
```

### 安装 PaddleOCR

下面的步骤面向不熟悉命令行的用户。安装期间需要下载 PaddleOCR、运行环境和中文识别模型，请预留约 900 MB 空间，并保持网络连接。

#### 1. 安装 Python 3.10

安装脚本需要 **64 位 Python 3.10**。如果电脑上还没有，请自行搜索“Python 3.10 Windows 64 位下载”并完成安装。

安装 Python 时请注意：

- 勾选 **Add Python to PATH**；
- 保留 Python Launcher（`py`）组件；
- 安装完成后重新打开终端，使环境变量生效。

#### 2. 打开 QuoteVault 所在文件夹

解压 QuoteVault 发布包，然后进入包含 `QuoteVault.exe` 和 `paddleocr` 文件夹的目录。在文件夹空白处按住 `Shift` 并单击鼠标右键，选择“在终端中打开”或“在此处打开 PowerShell”。

也可以单击文件资源管理器顶部的地址栏，输入 `powershell` 后按回车。

#### 3. 检查 Python

在打开的 PowerShell 窗口中输入：

```powershell
py -3.10 --version
```

正常情况下会显示类似 `Python 3.10.x` 的版本号。如果提示找不到 `py` 或 Python 3.10，请重新安装 Python 3.10，并确认已经勾选 PATH 和 Python Launcher 选项。

#### 4. 运行安装脚本

确认终端当前位于 QuoteVault 文件夹后，复制并运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\paddleocr\setup-runtime.ps1 -DownloadModels
```

安装过程可能持续几分钟，期间会下载多个文件。请不要关闭窗口。看到下面两类完成信息时即表示安装成功：

```text
PaddleOCR runtime installed at: ...
PaddleOCR models installed at: ...
```

#### 5. 在 QuoteVault 中启用

关闭并重新打开 QuoteVault，在设置页或添加、编辑截图时选择 `PaddleOCR v6`。首次识别可能需要稍等片刻。

如果安装失败，请先检查 Python 是否确实为 3.10、网络是否正常、磁盘空间是否充足，然后重新运行安装命令。终端中的红色错误信息通常会说明失败原因。已经安装后，可以在设置页使用“删除 PaddleOCR”移除运行环境和模型。

## 数据与隐私

图片、索引、搜索文本、标签和设置均保存在本机：

```text
%LocalAppData%\QuoteVault\
├── data.json
├── images\
├── thumbnails\        # 可随时重新生成的缩略图缓存
├── backups\
├── paddle-runtime\    # 仅安装 PaddleOCR 后存在
└── paddle-models\     # 仅安装 PaddleOCR 后存在
```

QuoteVault 不会把截图上传到云端。设置页可以导出包含索引与全部原图的完整 ZIP 备份，也可以从备份恢复。恢复前会校验索引、图片文件和文件哈希，并自动创建安全备份；只有验证通过后才会整体替换当前图库。

## 运行要求

- Windows 10 或 Windows 11；
- Microsoft Edge WebView2 Runtime；
- 仅从源码构建时需要 .NET 9 SDK，下载发布包的普通用户不需要安装 .NET。

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

可以单独输出 PaddleOCR 的识别结果，用于本地测试：

```powershell
dotnet run -c Release -- --paddle-ocr-test "截图.png"
```

## 代码结构

```text
QuoteVault/
├── MainForm.cs             # 主窗口、导入流程、剪贴板和界面消息处理
├── AppStore.cs             # 本地数据、图片文件、备份与恢复
├── Models.cs               # 数据模型和应用设置
├── PaddleOcrService.cs     # PaddleOCR 后台工作进程
├── paddleocr/              # PaddleOCR 脚本、依赖和安装器
├── ui/                     # WebView2 界面
└── SelfTest.cs             # 无需启动界面的基础自检
```
