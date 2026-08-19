# QuoteVault

一个面向 Windows 的本地聊天截图管理工具：收录截图、按成员图库和群组整理、搜索内容，并把原图快速复制回剪贴板或直接拖到 QQ 等聊天窗口。

所有截图、成员资料、搜索文本、标签和设置默认只保存在本机。OCR 为可选功能，不安装也可以正常使用。

## 下载与运行

前往 [Releases](https://github.com/Niannya/QuoteVault/releases/latest) 下载名称中带有 `win-x64` 的 ZIP 压缩包。下载完成后请先完整解压，再双击其中的 `QuoteVault.exe`；不要直接在压缩包预览窗口中运行程序。

发布包已经包含 .NET 运行环境，普通用户不需要另外安装 .NET。Windows 10 和 Windows 11 通常已经带有 Microsoft Edge WebView2 Runtime；如果程序提示缺少 WebView2，请安装 Microsoft Edge WebView2 Runtime。

## 使用流程

### 收录截图

可以通过以下方式添加图片：

- 从剪贴板读取；
- 选择本地图片文件；
- 把图片从文件管理器拖到右侧“添加”区域；
- 使用全局快捷键快速暂存剪贴板图片，默认快捷键为 `Ctrl+Alt+V`。

快捷键可以在设置页中点击快捷键框后，直接按下新的键盘组合进行录入。

支持 PNG、JPEG、BMP 和 GIF。

添加单张截图时，可以选择一个或多个成员图库。同一张截图可以同时属于多个图库，QuoteVault 只保存一份原图，不会因为放入多个图库而复制多份图片文件。

### 整理图库

左侧由“群组”和“成员图库”组成：

- 群组用于整理成员图库，可以建立多级群组；
- 成员图库可以拖动调整顺序，也可以拖到其他群组；
- 成员可以同时属于多个群组；
- 在成员编辑页中可以修改 ID、头像、QQ号、备注和所属群组；

### 查找与使用

左侧搜索用于查找成员和截图；中间搜索只查找当前正在查看的图库、待处理或回收站。

搜索内容包括：

- 成员 ID、QQ号和备注；

- 截图文件名；

- 可搜索文本；

- 标签。


图片可直接从一个图库拖动到另一个图库，直接拖动是移动，按住 `Ctrl` 拖动则是复制。

从图库中的截图卡片向 QuoteVault 窗口外拖动，可以把真实图片文件直接拖到 QQ 等支持 Windows 文件拖放的程序。多选多张截图后，从其中一张已选截图拖出时，可以一起拖出当前选中的图片。

界面的左侧图库、中间浏览区和右侧工作区均可调整宽度，左侧图库也可以隐藏。窗口位置、窗口大小、最大化状态、左右区域宽度、缩略图密度、群组折叠状态、主题和排序偏好会自动保存。

设置页提供界面、OCR、快捷键、数据备份等选项。

## OCR

OCR 并不是使用 QuoteVault 的必要条件。默认设置为“不使用 OCR”，用户可以直接填写搜索文本，也可以完全留空。

| 方式 | 适用场景 | 安装情况 |
| --- | --- | --- |
| 不使用 OCR | 只保存图片，或手动填写搜索文本 | 默认选项，无额外依赖 |
| PaddleOCR v6 | 希望自动识别中文聊天截图中的文字 | 按需安装，约占用 900 MB |

默认 OCR 方式可以在设置中选择；添加或编辑截图时，也可以只为当前图片临时切换识别方式。识别结果会写入“可搜索文本”，之后仍然可以手动修改、清空或重新识别。

QuoteVault 默认不安装 PaddleOCR。未安装时选择 PaddleOCR，软件会提示需要额外安装。运行环境和模型安装到：

```text
%LocalAppData%\QuoteVault\paddle-runtime\
%LocalAppData%\QuoteVault\paddle-models\
```

已经安装后，也可以在设置页删除 PaddleOCR。删除 OCR 运行环境不会删除已经保存的截图、搜索文本或标签。

### 安装 PaddleOCR

安装期间需要下载 PaddleOCR、运行环境和中文识别模型，请预留约 900 MB 空间，并保持网络连接。

#### 1. 安装 Python 3.10

安装脚本需要 **64 位 Python 3.10**。如果电脑上还没有，请先自行搜索安装 Python 3.10。

安装 Python 时请注意：

- 勾选 **Add Python to PATH**；
- 保留 Python Launcher（`py`）组件；
- 安装完成后重新打开终端，使环境变量生效。

#### 2. 打开 QuoteVault 所在文件夹

解压 QuoteVault 发布包，然后进入包含 `QuoteVault.exe` 和 `paddleocr` 文件夹的目录。在文件夹空白处单击鼠标右键，选择“在终端中打开”或“在此处打开 PowerShell”。

也可以单击文件资源管理器顶部的地址栏，输入 `powershell` 后按回车。

#### 3. 检查 Python

在打开的 PowerShell 窗口中输入：

```powershell
py -3.10 --version
```

正常情况下会显示类似 `Python 3.10.x` 的版本号。如果提示找不到 `py` 或 Python 3.10，请重新检查 Python 3.10 是否已正确安装。

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

如果安装失败，请先检查 Python 是否为 3.10、网络是否正常、磁盘空间是否充足，然后重新运行安装命令。终端中的红色错误信息通常会说明失败原因。

## 数据与隐私

图片、索引、成员资料、搜索文本、标签和设置均保存在本机：

```text
%LocalAppData%\QuoteVault\
├── data.json
├── images\
├── thumbnails\        # 可随时重新生成的缩略图缓存
├── backups\
├── paddle-runtime\    # 仅安装 PaddleOCR 后存在
└── paddle-models\     # 仅安装 PaddleOCR 后存在
```

图库中为了提高加载速度会显示缩略图，但原始图片不会因此被缩小或压缩。查看大图、复制到剪贴板以及拖到 QQ 时使用的是原图。

QuoteVault 不会把截图上传到云端。

设置页可以导出包含索引与全部原图的完整 ZIP 备份，也可以从备份恢复。恢复前会校验备份内容，并在必要时自动创建安全备份。数据结构升级时也会先保留旧索引备份，再执行迁移。

成员头像同样保存在本地数据中，并会包含在完整备份里。

## 运行要求

- Windows 10 或 Windows 11；
- Microsoft Edge WebView2 Runtime；
- 下载发布包的普通用户不需要安装 .NET；
- 仅从源码构建时需要 .NET 9 SDK；
- PaddleOCR 为可选功能，仅在需要 OCR 时安装 Python 3.10 和对应运行环境。

从源码运行：

```powershell
git clone https://github.com/Niannya/QuoteVault.git
cd QuoteVault
dotnet run
```

如果已经取得发布包，也可以直接运行其中的 `QuoteVault.exe`。

## 构建与验证

项目目标框架为 `net9.0-windows`。

常规构建和自检：

```powershell
dotnet restore
dotnet build -c Release
dotnet run -c Release -- --self-test
```

仓库提供一键发布脚本时，可以直接双击：

```text
生成发布版.cmd
```

脚本会依次执行还原、Release 构建、自检、Windows x64 自包含发布，并在 `artifacts` 目录生成发布 ZIP。

也可以单独输出 PaddleOCR 的识别结果，用于本地测试：

```powershell
dotnet run -c Release -- --paddle-ocr-test "截图.png"
```

## 代码结构

```text
QuoteVault/
├── MainForm.cs             # 主窗口、WebView2 消息、导入、拖放和剪贴板
├── AppStore.cs             # 本地数据、图片、缩略图、备份与恢复
├── Models.cs               # 数据模型和应用设置
├── PaddleOcrService.cs     # PaddleOCR 后台工作进程
├── Program.cs              # 程序入口
├── SelfTest.cs             # 无需启动界面的基础自检
├── paddleocr/              # PaddleOCR 工作脚本和安装器
└── ui/                     # WebView2 前端界面
    ├── index.html
    └── app-runtime.js
```

版本更新内容请查看仓库中的 `CHANGELOG.md`。README 只说明当前版本的功能和使用方法，不作为更新履历。
