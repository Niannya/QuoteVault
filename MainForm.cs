using System.Diagnostics;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace QuoteVault;

public sealed class MainForm : Form
{
    private const int HotKeyId = 0x5156;
    private const int WmHotKey = 0x0312;
    private const int WmNcHitTest = 0x0084;
    private const int WmNcLButtonDown = 0x00A1;
    private const int HtCaption = 0x0002;
    private const int ResizeBorder = 7;
    private const int DwmWindowCornerPreference = 33;
    private const int DwmBorderColor = 34;
    private const int DwmCornerRound = 2;

    private readonly AppStore _store;
    private readonly PaddleOcrService _paddleOcr = new();
    private readonly WebView2 _webView = new();
    private readonly JsonSerializerOptions _json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    private Guid? _selectedPersonId;
    private Guid? _selectedScreenshotId;
    private string _topView = "library";
    private string _activePanel = "preview";
    private ImportDraft? _draft;
    private PendingDuplicateCommit? _pendingDuplicateCommit;
    private bool _hotKeyRegistered;
    private bool _webReady;
    private string? _hotKeyRegistrationWarning;

    public MainForm() : this(new AppStore()) { }

    internal MainForm(AppStore store)
    {
        _store = store;
        Text = "QuoteVault";
        FormBorderStyle = FormBorderStyle.None;
        BackColor = Color.FromArgb(17, 18, 16);
        Size = new Size(1440, 900);
        MinimumSize = new Size(1120, 720);
        StartPosition = FormStartPosition.CenterScreen;
        KeyPreview = true;
        RestoreWindowPlacement();

        _webView.Dock = DockStyle.Fill;
        _webView.DefaultBackgroundColor = Color.FromArgb(17, 18, 16);
        _webView.CreationProperties = new CoreWebView2CreationProperties
        {
            UserDataFolder = Path.Combine(_store.RootPath, "webview2")
        };
        Controls.Add(_webView);

        Shown += async (_, _) => await InitializeWebViewAsync();
        FormClosed += (_, _) =>
        {
            UnregisterConfiguredHotKey();
            _paddleOcr.Dispose();
        };
        FormClosing += (_, _) => SaveWindowPlacement();
        SizeChanged += async (_, _) =>
        {
            ApplyRoundedWindowChrome();
            if (_webReady) await InvokeWebAsync("setWindowState", WindowState == FormWindowState.Maximized ? "maximized" : "normal");
        };
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        ApplyRoundedWindowChrome();
    }

    private void ApplyRoundedWindowChrome()
    {
        if (!OperatingSystem.IsWindowsVersionAtLeast(10, 0, 22000)) return;
        var cornerPreference = DwmCornerRound;
        DwmSetWindowAttribute(Handle, DwmWindowCornerPreference, ref cornerPreference, sizeof(int));
        var borderColor = ColorTranslator.ToWin32(Color.FromArgb(53, 54, 49));
        DwmSetWindowAttribute(Handle, DwmBorderColor, ref borderColor, sizeof(int));
    }

    private void RestoreWindowPlacement()
    {
        var settings = _store.State.Settings;
        if (!settings.HasWindowPlacement) return;
        var saved = new Rectangle(settings.WindowX, settings.WindowY,
            Math.Max(MinimumSize.Width, settings.WindowWidth),
            Math.Max(MinimumSize.Height, settings.WindowHeight));
        var visible = Screen.AllScreens.Any(screen =>
        {
            var intersection = Rectangle.Intersect(screen.WorkingArea, saved);
            return intersection.Width >= 120 && intersection.Height >= 80;
        });
        if (!visible) return;
        StartPosition = FormStartPosition.Manual;
        Bounds = saved;
        if (settings.WindowMaximized) WindowState = FormWindowState.Maximized;
    }

    private void SaveWindowPlacement()
    {
        var bounds = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
        if (bounds.Width < MinimumSize.Width || bounds.Height < MinimumSize.Height) return;
        var settings = _store.State.Settings;
        settings.HasWindowPlacement = true;
        settings.WindowX = bounds.X;
        settings.WindowY = bounds.Y;
        settings.WindowWidth = bounds.Width;
        settings.WindowHeight = bounds.Height;
        settings.WindowMaximized = WindowState == FormWindowState.Maximized;
        _store.Save();
    }

    private async Task InitializeWebViewAsync()
    {
        try
        {
            await _webView.EnsureCoreWebView2Async();
            var uiPath = Path.Combine(AppContext.BaseDirectory, "ui");
            if (!Directory.Exists(uiPath)) throw new DirectoryNotFoundException($"找不到 UI 资源：{uiPath}");

            _webView.CoreWebView2.SetVirtualHostNameToFolderMapping(
                "app.quotevault.local", uiPath, CoreWebView2HostResourceAccessKind.DenyCors);
            _webView.CoreWebView2.SetVirtualHostNameToFolderMapping(
                "images.quotevault.local", _store.ImagePath, CoreWebView2HostResourceAccessKind.DenyCors);
            _webView.CoreWebView2.SetVirtualHostNameToFolderMapping(
                "thumbs.quotevault.local", _store.ThumbnailPath, CoreWebView2HostResourceAccessKind.DenyCors);
            _webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
            _webView.CoreWebView2.Settings.AreDevToolsEnabled = false;
            _webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
            _webView.CoreWebView2.WebMessageReceived += OnWebMessageReceived;
            _webView.Source = new Uri("https://app.quotevault.local/index.html");
            if (!RegisterConfiguredHotKey())
                _hotKeyRegistrationWarning = $"全局快捷键 {DescribeConfiguredHotKey()} 注册失败，可能已被其他程序占用。请在设置中选择其他组合。";
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, $"界面初始化失败：\n{ex.Message}", "QuoteVault",
                MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private async void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            using var document = JsonDocument.Parse(e.WebMessageAsJson);
            var root = document.RootElement;
            var type = root.GetProperty("type").GetString() ?? string.Empty;
            var payload = root.TryGetProperty("payload", out var value) ? value : default;

            switch (type)
            {
                case "ready":
                    _webReady = true;
                    await SendStateAsync("preview");
                    await InvokeWebAsync("setWindowState", WindowState == FormWindowState.Maximized ? "maximized" : "normal");
                    if (!string.IsNullOrWhiteSpace(_store.LoadWarning))
                        await InvokeWebAsync("showNotice", new { title = "索引读取失败", message = _store.LoadWarning });
                    if (!string.IsNullOrWhiteSpace(_hotKeyRegistrationWarning))
                        await InvokeWebAsync("showNotice", new { title = "快捷键不可用", message = _hotKeyRegistrationWarning });
                    _ = WarmThumbnailCacheAsync();
                    break;
                case "panelChanged":
                    if (payload.TryGetProperty("name", out var name)) _activePanel = name.GetString() ?? "preview";
                    break;
                case "topViewChanged":
                    if (payload.TryGetProperty("name", out var topView)) _topView = topView.GetString() ?? "library";
                    _selectedScreenshotId = null;
                    if (_topView is "pending" or "trash") _selectedPersonId = null;
                    await SendStateAsync("preview");
                    break;
                case "selectPerson":
                    _selectedPersonId = ReadGuid(payload, "id");
                    _selectedScreenshotId = null;
                    _topView = "library";
                    await SendStateAsync("preview");
                    break;
                case "selectScreenshot":
                    _selectedScreenshotId = ReadGuid(payload, "id");
                    await SendStateAsync("preview");
                    break;
                case "selectGlobalScreenshot":
                    SelectGlobalScreenshot(ReadGuid(payload, "id"));
                    await SendStateAsync("preview");
                    break;
                case "clearScreenshotSelection":
                    _selectedScreenshotId = null;
                    await SendStateAsync("preview");
                    break;
                case "managePeople":
                    await SendStateAsync();
                    break;
                case "openSettings":
                    _topView = "settings";
                    await SendStateAsync("preview");
                    break;
                case "createGroup":
                    CreateGroup(payload);
                    await SendStateAsync();
                    break;
                case "updateGroup":
                    UpdateGroup(payload);
                    await SendStateAsync();
                    break;
                case "deleteGroup":
                    DeleteGroup(ReadGuid(payload, "id"));
                    await SendStateAsync();
                    break;
                case "createMember":
                    CreateMember(payload);
                    await SendStateAsync();
                    break;
                case "updateMember":
                    UpdateMember(payload);
                    await SendStateAsync();
                    break;
                case "deleteMember":
                    DeleteMember(ReadGuid(payload, "id"));
                    await SendStateAsync();
                    break;
                case "moveMember":
                    MoveMember(payload);
                    await SendStateAsync();
                    break;
                case "moveScreenshots":
                    MoveScreenshots(payload);
                    await SendStateAsync("preview");
                    break;
                case "saveHotKeySettings":
                    SaveHotKeySettings(payload);
                    await InvokeWebAsync("showError", "快捷键已保存并生效。");
                    await SendStateAsync();
                    break;
                case "saveLayoutSettings":
                    SaveLayoutSettings(payload);
                    await SendStateAsync();
                    break;
                case "resetLayoutSettings":
                    ResetLayoutSettings();
                    await SendStateAsync();
                    break;
                case "saveThemeSettings":
                    SaveThemeSettings(payload);
                    await SendStateAsync();
                    break;
                case "saveScreenshotSort":
                    SaveScreenshotSort(payload);
                    await SendStateAsync();
                    break;
                case "saveViewPreferences":
                    SaveViewPreferences(payload);
                    break;
                case "setOcrEngine":
                    await SetOcrEngineAsync(payload);
                    break;
                case "uninstallPaddleOcr":
                    await UninstallPaddleOcrAsync();
                    break;
                case "openPaddleOcrGuide":
                    Process.Start(new ProcessStartInfo("https://github.com/Niannya/QuoteVault#ocr") { UseShellExecute = true });
                    break;
                case "createBackup":
                    await CreateBackupAsync();
                    break;
                case "restoreBackup":
                    if (await RestoreBackupAsync()) await SendStateAsync();
                    break;
                case "batchAction":
                    BatchAction(payload);
                    await SendStateAsync();
                    break;
                case "chooseImage":
                    await ChooseImageForDraftAsync(ReadOptionalOcrEngine(payload), ReadGuid(payload, "libraryId"));
                    break;
                case "prepareClipboard":
                    await PrepareClipboardDraftAsync(ReadOptionalOcrEngine(payload));
                    break;
                case "prepareDroppedImage":
                    await PrepareDroppedDraftAsync(payload, ReadOptionalOcrEngine(payload));
                    break;
                case "prepareDroppedImages":
                    await PrepareDroppedBatchAsync(payload, ReadOptionalOcrEngine(payload), ReadGuid(payload, "libraryId"));
                    break;
                case "cancelDraft":
                    _draft = null;
                    break;
                case "commitDraft":
                    await CommitDraftAsync(payload.GetProperty("pending").GetBoolean(), ReadGuid(payload, "libraryId"),
                        ReadStringList(payload, "tags"), ReadText(payload, "searchText"));
                    break;
                case "resolveDuplicate":
                    await ResolveDuplicateAsync(payload.GetProperty("action").GetString());
                    break;
                case "copyImage":
                    CopyImage(ReadGuid(payload, "id"));
                    break;
                case "showFile":
                    ShowFile(ReadGuid(payload, "id"));
                    break;
                case "moveToTrash":
                    MoveToTrash(ReadGuid(payload, "id"));
                    await SendStateAsync("preview");
                    break;
                case "restoreFromTrash":
                    RestoreFromTrash(ReadGuid(payload, "id"));
                    await SendStateAsync("preview");
                    break;
                case "permanentDelete":
                    PermanentlyDelete(ReadGuid(payload, "id"));
                    await SendStateAsync("preview");
                    break;
                case "saveEdit":
                    SaveEdit(payload);
                    await SendStateAsync("preview");
                    break;
                case "rerunOcr":
                    await RerunOcrAsync(ReadGuid(payload, "id"), ReadOptionalOcrEngine(payload));
                    break;
                case "windowAction":
                    HandleWindowAction(payload.GetProperty("action").GetString());
                    break;
            }
        }
        catch (Exception ex)
        {
            await SetWebBusyAsync(false, string.Empty);
            await ShowWebErrorAsync(ex.Message);
        }
    }

    private async Task SendStateAsync(string? panel = null)
    {
        if (!_webReady || _webView.CoreWebView2 is null) return;
        if (panel is not null) _activePanel = panel;
        NormalizeSelection();
        var state = new
        {
            people = _store.State.People.Select(x => new
            {
                id = x.Id,
                displayName = x.DisplayName,
                categoryIds = x.CategoryIds
            }),
            categories = _store.State.Categories.Select(x => new
            {
                id = x.Id,
                parentId = x.ParentId,
                name = x.Name
            }),
            screenshots = _store.State.Screenshots.Select(x => new
            {
                id = x.Id,
                originalFileName = x.OriginalFileName,
                importedAt = x.ImportedAt,
                deletedAt = x.DeletedAt,
                needsReview = x.NeedsReview,
                confidence = x.OcrConfidence,
                ocrEngine = x.OcrEngine,
                ocrEngineKey = x.OcrEngineKey,
                libraryId = x.LibraryId,
                searchText = x.SearchText,
                tags = x.Tags,
                imageUrl = $"https://images.quotevault.local/{Uri.EscapeDataString(x.StoredFileName)}",
                thumbnailUrl = File.Exists(_store.GetThumbnailFile(x))
                    ? $"https://thumbs.quotevault.local/{Uri.EscapeDataString(Path.GetFileNameWithoutExtension(x.StoredFileName) + ".jpg")}"
                    : $"https://images.quotevault.local/{Uri.EscapeDataString(x.StoredFileName)}"
            }),
            selectedPersonId = _selectedPersonId,
            selectedScreenshotId = _selectedScreenshotId,
            topView = _topView,
            activePanel = _activePanel,
            settings = new
            {
                hotKeyCtrl = _store.State.Settings.HotKeyCtrl,
                hotKeyAlt = _store.State.Settings.HotKeyAlt,
                hotKeyShift = _store.State.Settings.HotKeyShift,
                hotKey = _store.State.Settings.HotKey.ToString(),
                ocrEngine = _store.State.Settings.OcrEngine,
                paddleAvailable = _paddleOcr.IsFullyInstalled,
                theme = _store.State.Settings.Theme,
                sidebarWidth = _store.State.Settings.SidebarWidth,
                workbenchWidth = _store.State.Settings.WorkbenchWidth,
                screenshotSort = _store.State.Settings.ScreenshotSort,
                viewMode = _store.State.Settings.ViewMode,
                collapsedTreeNodes = _store.State.Settings.CollapsedTreeNodes
            },
            appVersion = Application.ProductVersion
        };
        await InvokeWebAsync("setState", state);
    }

    private async Task InvokeWebAsync(string method, object? value = null)
    {
        if (_webView.CoreWebView2 is null) return;
        var argument = value is null ? string.Empty : JsonSerializer.Serialize(value, _json);
        await _webView.CoreWebView2.ExecuteScriptAsync($"window.quoteVault?.{method}({argument})");
    }

    private Task ShowWebErrorAsync(string message) => InvokeWebAsync("showError", message);
    private Task SetWebBusyAsync(bool busy, string text) => InvokeWebAsync("setBusy", new object[] { busy, text });

    private async Task WarmThumbnailCacheAsync()
    {
        try
        {
            var created = await Task.Run(_store.EnsureMissingThumbnails);
            if (created > 0 && !IsDisposed && _webReady) await SendStateAsync();
        }
        catch
        {
            // 缩略图缓存失败时继续使用原图，不打断用户操作。
        }
    }

    private Task<OcrOutput> RecognizeAsync(string imagePath, string? engineOverride = null,
        CancellationToken cancellationToken = default)
    {
        return (engineOverride ?? _store.State.Settings.OcrEngine) switch
        {
            "PaddleOcrV6" when _paddleOcr.IsFullyInstalled => _paddleOcr.RecognizeAsync(imagePath, cancellationToken),
            "PaddleOcrV6" => throw new InvalidOperationException("PaddleOCR 尚未安装，请先在设置中完成安装。"),
            _ => Task.FromResult(new OcrOutput(string.Empty, 0, [string.Empty], [], "未使用 OCR"))
        };
    }

    private async Task ChooseImageForDraftAsync(string? ocrEngine, Guid? libraryId)
    {
        using var dialog = new OpenFileDialog
        {
            Title = "选择聊天截图",
            Filter = "图片|*.png;*.jpg;*.jpeg;*.bmp;*.gif|所有文件|*.*",
            Multiselect = true
        };
        if (dialog.ShowDialog(this) != DialogResult.OK) return;
        if (dialog.FileNames.Length == 1)
        {
            await PrepareDraftAsync(await File.ReadAllBytesAsync(dialog.FileName), Path.GetFileName(dialog.FileName),
                Path.GetExtension(dialog.FileName), ocrEngine);
            return;
        }
        var files = new List<IncomingImage>();
        foreach (var file in dialog.FileNames)
            files.Add(new IncomingImage(await File.ReadAllBytesAsync(file), Path.GetFileName(file), Path.GetExtension(file)));
        await ImportBatchToPendingAsync(files, ocrEngine, libraryId);
    }

    private async Task PrepareClipboardDraftAsync(string? ocrEngine)
    {
        if (!Clipboard.ContainsImage())
        {
            await ShowWebErrorAsync("剪贴板中没有图片。");
            return;
        }
        using var image = Clipboard.GetImage();
        if (image is null) return;
        using var stream = new MemoryStream();
        image.Save(stream, ImageFormat.Png);
        await PrepareDraftAsync(stream.ToArray(), $"剪贴板-{DateTime.Now:yyyyMMdd-HHmmss}.png", ".png", ocrEngine);
    }

    private async Task PrepareDroppedDraftAsync(JsonElement payload, string? ocrEngine)
    {
        var name = payload.GetProperty("name").GetString() ?? "拖入图片.png";
        var dataUrl = payload.GetProperty("dataUrl").GetString() ?? throw new InvalidDataException("拖入的图片为空。");
        var comma = dataUrl.IndexOf(',');
        if (comma < 0) throw new InvalidDataException("无法读取拖入的图片。");
        var bytes = Convert.FromBase64String(dataUrl[(comma + 1)..]);
        await PrepareDraftAsync(bytes, name, Path.GetExtension(name), ocrEngine);
    }

    private async Task PrepareDroppedBatchAsync(JsonElement payload, string? ocrEngine, Guid? libraryId)
    {
        var files = new List<IncomingImage>();
        foreach (var element in payload.GetProperty("items").EnumerateArray())
        {
            var name = element.GetProperty("name").GetString() ?? "拖入图片.png";
            var dataUrl = element.GetProperty("dataUrl").GetString() ?? string.Empty;
            var comma = dataUrl.IndexOf(',');
            if (comma < 0) continue;
            files.Add(new IncomingImage(Convert.FromBase64String(dataUrl[(comma + 1)..]), name, Path.GetExtension(name)));
        }
        await ImportBatchToPendingAsync(files, ocrEngine, libraryId);
    }

    private async Task ImportBatchToPendingAsync(IReadOnlyList<IncomingImage> files, string? ocrEngine, Guid? libraryId)
    {
        if (files.Count == 0) return;
        await SetWebBusyAsync(true, $"正在导入 {files.Count} 张截图…");
        var imported = 0;
        var skippedDuplicates = 0;
        for (var index = 0; index < files.Count; index++)
        {
            var file = files[index];
            await SetWebBusyAsync(true, $"正在导入第 {index + 1}/{files.Count} 张截图…");
            ValidateImage(file.Bytes);
            var duplicate = _store.FindDuplicate(AppStore.ComputeSha256(file.Bytes));
            if (duplicate is not null)
            {
                skippedDuplicates++;
                continue;
            }

            var extension = NormalizeExtension(file.Extension);
            var item = _store.AddImage(file.Bytes, file.Name, extension, false);
            item.NeedsReview = true;
            if (libraryId.HasValue && _store.State.People.Any(x => x.Id == libraryId.Value))
            {
                item.LibraryId = libraryId;
                item.PersonIds = [libraryId.Value];
            }
            try
            {
                var output = await RecognizeAsync(_store.GetImageFile(item), ocrEngine);
                item.OcrRawText = output.RawText;
                item.OcrConfidence = output.Confidence;
                item.OcrEngine = output.Engine;
                item.OcrEngineKey = ocrEngine ?? _store.State.Settings.OcrEngine;
                item.SearchText = SearchTextFromOcr(output);
            }
            catch
            {
                // OCR 失败不丢失图片，留在待处理供用户手动编辑。
            }
            _store.Save();
            _selectedScreenshotId = item.Id;
            imported++;
        }
        _draft = null;
        _topView = "pending";
        _selectedPersonId = null;
        await InvokeWebAsync("clearDraft");
        await SendStateAsync("preview");
        await SetWebBusyAsync(false, string.Empty);
        if (imported > 0) await InvokeWebAsync("showError", $"已导入 {imported} 张截图，可在待处理中继续整理。");
        if (skippedDuplicates > 0) await InvokeWebAsync("showError", $"已跳过 {skippedDuplicates} 张重复图片。");
    }

    private async Task PrepareDraftAsync(byte[] bytes, string name, string extension, string? ocrEngine = null)
    {
        ValidateImage(bytes);
        extension = NormalizeExtension(extension);
        var temp = Path.Combine(Path.GetTempPath(), $"QuoteVault-{Guid.NewGuid():N}{extension}");
        try
        {
            var engineKey = ocrEngine ?? _store.State.Settings.OcrEngine;
            await SetWebBusyAsync(true, engineKey == "None" ? "正在读取截图…" : "正在识别截图…");
            await File.WriteAllBytesAsync(temp, bytes);
            var output = await RecognizeAsync(temp, engineKey);
            _draft = new ImportDraft(bytes, name, extension, output, engineKey);
            var dataUrl = $"data:{MimeForExtension(extension)};base64,{Convert.ToBase64String(bytes)}";
            await InvokeWebAsync("setDraft", new
            {
                name,
                dataUrl,
                confidence = output.Confidence,
                ocrEngine = output.Engine,
                ocrEngineKey = engineKey,
                searchText = SearchTextFromOcr(output)
            });
        }
        finally
        {
            if (File.Exists(temp)) File.Delete(temp);
        }
    }

    private async Task CommitDraftAsync(bool pending, Guid? libraryId, IReadOnlyList<string> tags,
        string searchText, bool bypassDuplicateCheck = false)
    {
        if (_draft is null) return;
        var hash = AppStore.ComputeSha256(_draft.Bytes);
        var duplicate = _store.FindDuplicate(hash);
        if (duplicate is not null && !bypassDuplicateCheck)
        {
            _pendingDuplicateCommit = new PendingDuplicateCommit(pending, libraryId, tags.ToList(), searchText,
                duplicate.Id);
            await InvokeWebAsync("showDuplicate", new { duplicate.OriginalFileName });
            return;
        }

        var item = _store.AddImage(_draft.Bytes, _draft.Name, _draft.Extension, false);
        item.OcrRawText = _draft.Ocr.RawText;
        item.OcrConfidence = _draft.Ocr.Confidence;
        item.OcrEngine = _draft.Ocr.Engine;
        item.OcrEngineKey = _draft.OcrEngineKey;
        item.SearchText = NormalizeSearchText(searchText);
        item.NeedsReview = pending;
        item.Tags = NormalizeTags(tags);
        if (libraryId is Guid id && _store.State.People.Any(x => x.Id == id))
        {
            item.LibraryId = id;
            item.PersonIds = [id];
        }
        _store.Save();

        _selectedScreenshotId = item.Id;
        _selectedPersonId = item.NeedsReview ? null : item.LibraryId ?? _selectedPersonId;
        _topView = item.NeedsReview ? "pending" : "library";
        _draft = null;
        await InvokeWebAsync("clearDraft");
        await SendStateAsync("preview");
    }

    private async Task ResolveDuplicateAsync(string? action)
    {
        var pending = _pendingDuplicateCommit;
        _pendingDuplicateCommit = null;
        if (pending is null) return;
        if (action == "import")
        {
            await CommitDraftAsync(pending.Pending, pending.LibraryId, pending.Tags, pending.SearchText, true);
            return;
        }
        if (action == "view")
        {
            var duplicate = _store.State.Screenshots.FirstOrDefault(x => x.Id == pending.DuplicateId);
            if (duplicate is not null)
            {
                if (duplicate.DeletedAt.HasValue)
                {
                    _selectedScreenshotId = duplicate.Id;
                    _selectedPersonId = null;
                    _topView = "trash";
                }
                else SelectGlobalScreenshot(duplicate.Id);
                _draft = null;
                await InvokeWebAsync("clearDraft");
                await SendStateAsync("preview");
            }
            return;
        }
        _draft = null;
        await InvokeWebAsync("clearDraft");
    }

    private void SaveEdit(JsonElement payload)
    {
        var id = ReadGuid(payload, "id") ?? throw new InvalidDataException("没有选择截图。");
        var item = _store.State.Screenshots.FirstOrDefault(x => x.Id == id) ?? throw new FileNotFoundException("截图不存在。");
        item.SearchText = NormalizeSearchText(ReadText(payload, "searchText"));
        item.Tags = NormalizeTags(ReadStringList(payload, "tags"));
        var libraryId = ReadGuid(payload, "libraryId") ?? item.LibraryId ?? _selectedPersonId;
        if (_topView == "pending" && (!libraryId.HasValue || !_store.State.People.Any(x => x.Id == libraryId.Value)))
            throw new InvalidOperationException("请选择要存放截图的图库。");
        if (libraryId.HasValue && _store.State.People.Any(x => x.Id == libraryId.Value))
        {
            item.LibraryId = libraryId;
            item.PersonIds = [libraryId.Value];
            _selectedPersonId = libraryId;
        }
        item.NeedsReview = false;
        if (_topView == "pending") _topView = "library";
        _store.Save();
    }

    private async Task RerunOcrAsync(Guid? id, string? ocrEngine = null)
    {
        var item = _store.State.Screenshots.FirstOrDefault(x => x.Id == id) ?? throw new FileNotFoundException("截图不存在。");
        var engineKey = ocrEngine ?? _store.State.Settings.OcrEngine;
        await SetWebBusyAsync(true, engineKey == "None" ? "正在清除当前截图的识别文本…" : "正在重新识别…");
        var output = await RecognizeAsync(_store.GetImageFile(item), engineKey);
        item.OcrRawText = output.RawText;
        item.OcrConfidence = output.Confidence;
        item.OcrEngine = output.Engine;
        item.OcrEngineKey = engineKey;
        item.SearchText = SearchTextFromOcr(output);
        _store.Save();
        await SendStateAsync();
        await SetWebBusyAsync(false, string.Empty);
    }

    private void CopyImage(Guid? id)
    {
        var item = _store.State.Screenshots.FirstOrDefault(x => x.Id == id) ?? throw new FileNotFoundException("截图不存在。");
        if (item.DeletedAt.HasValue || item.NeedsReview)
            throw new InvalidOperationException("只有已整理图库中的截图可以复制到剪贴板。");
        using var stream = new MemoryStream(File.ReadAllBytes(_store.GetImageFile(item)));
        using var image = Image.FromStream(stream);
        Clipboard.SetImage(new Bitmap(image));
    }

    private void ShowFile(Guid? id)
    {
        var item = _store.State.Screenshots.FirstOrDefault(x => x.Id == id) ?? throw new FileNotFoundException("截图不存在。");
        Process.Start(new ProcessStartInfo("explorer.exe", $"/select,\"{_store.GetImageFile(item)}\"") { UseShellExecute = true });
    }

    private void MoveToTrash(Guid? id)
    {
        var item = _store.State.Screenshots.FirstOrDefault(x => x.Id == id) ?? throw new FileNotFoundException("截图不存在。");
        _store.MoveToTrash(item);
        _selectedScreenshotId = null;
    }

    private void RestoreFromTrash(Guid? id)
    {
        var item = _store.State.Screenshots.FirstOrDefault(x => x.Id == id) ?? throw new FileNotFoundException("截图不存在。");
        _store.RestoreFromTrash(item, false);
        if (!item.LibraryId.HasValue)
        {
            item.NeedsReview = true;
        }
        _store.Save();
        _selectedScreenshotId = null;
    }

    private void PermanentlyDelete(Guid? id)
    {
        var item = _store.State.Screenshots.FirstOrDefault(x => x.Id == id) ?? throw new FileNotFoundException("截图不存在。");
        _store.PermanentlyDelete(item);
        _selectedScreenshotId = null;
    }

    private void CreateGroup(JsonElement payload)
    {
        var name = payload.GetProperty("name").GetString()?.Trim();
        if (string.IsNullOrWhiteSpace(name)) throw new InvalidDataException("群组名称不能为空。");
        var parentId = ReadGuid(payload, "parentId");
        if (parentId.HasValue && !_store.State.Categories.Any(x => x.Id == parentId)) parentId = null;
        if (_store.State.Categories.Any(x => x.ParentId == parentId && string.Equals(x.Name, name, StringComparison.OrdinalIgnoreCase)))
            throw new InvalidOperationException("同一级中已经存在同名群组。");
        _store.State.Categories.Add(new CategoryItem { Name = name, ParentId = parentId });
        _store.Save();
    }

    private void UpdateGroup(JsonElement payload)
    {
        var id = ReadGuid(payload, "id") ?? throw new InvalidDataException("没有选择群组。");
        var group = _store.State.Categories.FirstOrDefault(x => x.Id == id) ?? throw new InvalidDataException("群组不存在。");
        var name = payload.GetProperty("name").GetString()?.Trim();
        if (string.IsNullOrWhiteSpace(name)) throw new InvalidDataException("群组名称不能为空。");
        if (_store.State.Categories.Any(x => x.Id != group.Id && x.ParentId == group.ParentId &&
                                             string.Equals(x.Name, name, StringComparison.OrdinalIgnoreCase)))
            throw new InvalidOperationException("同一级中已经存在同名群组。");
        group.Name = name;
        _store.Save();
    }

    private void DeleteGroup(Guid? id)
    {
        var group = _store.State.Categories.FirstOrDefault(x => x.Id == id);
        if (group is null) return;
        foreach (var child in _store.State.Categories.Where(x => x.ParentId == group.Id)) child.ParentId = group.ParentId;
        foreach (var member in _store.State.People) member.CategoryIds.Remove(group.Id);
        _store.State.Categories.Remove(group);
        _store.Save();
    }

    private void CreateMember(JsonElement payload)
    {
        var name = payload.GetProperty("name").GetString()?.Trim();
        if (string.IsNullOrWhiteSpace(name)) throw new InvalidDataException("成员名称不能为空。");
        var member = new PersonItem { DisplayName = name, CategoryIds = ReadValidGroupIds(payload) };
        _store.State.People.Add(member);
        _selectedPersonId = member.Id;
        _topView = "library";
        _store.Save();
    }

    private void UpdateMember(JsonElement payload)
    {
        var id = ReadGuid(payload, "id") ?? throw new InvalidDataException("没有选择成员。");
        var member = _store.State.People.FirstOrDefault(x => x.Id == id) ?? throw new InvalidDataException("成员不存在。");
        var name = payload.GetProperty("name").GetString()?.Trim();
        if (string.IsNullOrWhiteSpace(name)) throw new InvalidDataException("成员名称不能为空。");
        member.DisplayName = name;
        member.CategoryIds = ReadValidGroupIds(payload);
        _store.Save();
    }

    private void DeleteMember(Guid? id)
    {
        var member = _store.State.People.FirstOrDefault(x => x.Id == id);
        if (member is null) return;
        foreach (var screenshot in _store.State.Screenshots)
        {
            if (screenshot.LibraryId != member.Id) continue;
            screenshot.LibraryId = null;
            screenshot.PersonIds.Clear();
            screenshot.NeedsReview = true;
        }
        _store.State.NicknameMappings.RemoveAll(x => x.PersonId == member.Id);
        _store.State.People.Remove(member);
        if (_selectedPersonId == member.Id) _selectedPersonId = null;
        _store.Save();
    }

    private void MoveMember(JsonElement payload)
    {
        var memberId = ReadGuid(payload, "memberId") ?? throw new InvalidDataException("没有选择成员。");
        var targetGroupId = ReadGuid(payload, "targetGroupId") ?? throw new InvalidDataException("没有选择目标群组。");
        var sourceGroupId = ReadGuid(payload, "sourceGroupId");
        var member = _store.State.People.FirstOrDefault(x => x.Id == memberId) ??
                     throw new InvalidDataException("成员不存在。");
        if (!_store.State.Categories.Any(x => x.Id == targetGroupId)) throw new InvalidDataException("目标群组不存在。");
        if (sourceGroupId.HasValue && sourceGroupId != targetGroupId) member.CategoryIds.Remove(sourceGroupId.Value);
        if (!member.CategoryIds.Contains(targetGroupId)) member.CategoryIds.Add(targetGroupId);
        _store.Save();
    }

    private void MoveScreenshots(JsonElement payload)
    {
        var targetMemberId = ReadGuid(payload, "targetMemberId") ?? throw new InvalidDataException("没有选择目标图库。");
        if (!_store.State.People.Any(x => x.Id == targetMemberId)) throw new InvalidDataException("目标成员不存在。");
        var ids = ReadStringList(payload, "ids").Select(x => Guid.TryParse(x, out var id) ? id : Guid.Empty)
            .Where(x => x != Guid.Empty).ToHashSet();
        foreach (var item in _store.State.Screenshots.Where(x => ids.Contains(x.Id) && !x.DeletedAt.HasValue))
        {
            item.LibraryId = targetMemberId;
            item.PersonIds = [targetMemberId];
            item.NeedsReview = false;
        }
        _selectedPersonId = targetMemberId;
        _selectedScreenshotId = ids.Count == 1 ? ids.First() : null;
        _topView = "library";
        _store.Save();
    }

    private void SelectGlobalScreenshot(Guid? id)
    {
        var item = _store.State.Screenshots.FirstOrDefault(x => x.Id == id && !x.DeletedAt.HasValue) ??
                   throw new FileNotFoundException("截图不存在。");
        _selectedScreenshotId = item.Id;
        _selectedPersonId = item.LibraryId;
        _topView = item.NeedsReview ? "pending" : "library";
    }

    private List<Guid> ReadValidGroupIds(JsonElement payload) =>
        ReadStringList(payload, "groupIds")
            .Select(x => Guid.TryParse(x, out var id) ? id : Guid.Empty)
            .Where(id => id != Guid.Empty && _store.State.Categories.Any(x => x.Id == id))
            .Distinct().ToList();

    private static string SearchTextFromOcr(OcrOutput output) => NormalizeSearchText(
        string.Join(Environment.NewLine, output.Lines.Where(x => !string.IsNullOrWhiteSpace(x))));

    private void SaveHotKeySettings(JsonElement payload)
    {
        var keyText = payload.GetProperty("hotKey").GetString();
        if (!Enum.TryParse<Keys>(keyText, true, out var key) ||
            !(key is >= Keys.A and <= Keys.Z || key is >= Keys.D0 and <= Keys.D9 || key is >= Keys.F1 and <= Keys.F12))
            throw new InvalidDataException("快捷键只支持字母、数字或 F1–F12。");
        var settings = _store.State.Settings;
        var previous = (settings.HotKeyCtrl, settings.HotKeyAlt, settings.HotKeyShift, settings.HotKey);
        settings.HotKeyCtrl = payload.GetProperty("hotKeyCtrl").GetBoolean();
        settings.HotKeyAlt = payload.GetProperty("hotKeyAlt").GetBoolean();
        settings.HotKeyShift = payload.GetProperty("hotKeyShift").GetBoolean();
        if (!settings.HotKeyCtrl && !settings.HotKeyAlt && !settings.HotKeyShift)
        {
            (settings.HotKeyCtrl, settings.HotKeyAlt, settings.HotKeyShift, settings.HotKey) = previous;
            throw new InvalidDataException("快捷键至少需要 Ctrl、Alt 或 Shift 中的一项。");
        }
        settings.HotKey = key;
        if (!RegisterConfiguredHotKey())
        {
            (settings.HotKeyCtrl, settings.HotKeyAlt, settings.HotKeyShift, settings.HotKey) = previous;
            RegisterConfiguredHotKey();
            throw new InvalidOperationException("快捷键注册失败，可能已被其他程序占用。原快捷键保持不变。");
        }
        _hotKeyRegistrationWarning = null;
        _store.Save();
    }

    private async Task SetOcrEngineAsync(JsonElement payload)
    {
        var engine = ReadOcrEngine(payload);
        if (engine == "PaddleOcrV6" && !_paddleOcr.IsFullyInstalled)
            throw new InvalidOperationException("PaddleOCR 尚未安装。选择安装后才能启用该识别引擎。");
        var target = payload.TryGetProperty("target", out var targetValue) ? targetValue.GetString() : "settings";
        if (target == "settings") SaveOcrEngine(engine);
        await CompleteOcrEngineChangeAsync(payload, engine);
    }

    private void SaveLayoutSettings(JsonElement payload)
    {
        var settings = _store.State.Settings;
        if (payload.TryGetProperty("sidebarWidth", out var sidebarWidth) && sidebarWidth.TryGetInt32(out var sidebar))
            settings.SidebarWidth = Math.Clamp(sidebar, 170, 420);
        if (payload.TryGetProperty("workbenchWidth", out var workbenchWidth) && workbenchWidth.TryGetInt32(out var workbench))
            settings.WorkbenchWidth = Math.Clamp(workbench, 360, 800);
        _store.Save();
    }

    private void ResetLayoutSettings()
    {
        _store.State.Settings.SidebarWidth = AppSettings.DefaultSidebarWidth;
        _store.State.Settings.WorkbenchWidth = AppSettings.DefaultWorkbenchWidth;
        _store.Save();
    }

    private void SaveThemeSettings(JsonElement payload)
    {
        _store.State.Settings.Theme = payload.TryGetProperty("theme", out var value) && value.GetString() == "light"
            ? "light"
            : "dark";
        _store.Save();
    }

    private void SaveScreenshotSort(JsonElement payload)
    {
        var value = payload.TryGetProperty("value", out var property) ? property.GetString() : null;
        _store.State.Settings.ScreenshotSort = value is "oldest" or "nameAsc" or "nameDesc" ? value : "newest";
        _store.Save();
    }

    private void SaveViewPreferences(JsonElement payload)
    {
        var settings = _store.State.Settings;
        if (payload.TryGetProperty("viewMode", out var mode))
            settings.ViewMode = mode.GetString() == "list" ? "list" : "grid";
        if (payload.TryGetProperty("collapsedTreeNodes", out var nodes) && nodes.ValueKind == JsonValueKind.Array)
            settings.CollapsedTreeNodes = nodes.EnumerateArray().Where(x => x.ValueKind == JsonValueKind.String)
                .Select(x => x.GetString() ?? string.Empty)
                .Where(x => x == "__ungrouped__" || Guid.TryParse(x, out _)).Distinct().ToList();
        _store.Save();
    }

    private void SaveOcrEngine(string engine)
    {
        _store.State.Settings.OcrEngine = engine;
        _store.State.Settings.HasExplicitOcrChoice = true;
        _store.Save();
    }

    private static string ReadOcrEngine(JsonElement payload) =>
        payload.TryGetProperty("engine", out var engine) && engine.GetString() == "PaddleOcrV6"
            ? engine.GetString()!
            : "None";

    private async Task CompleteOcrEngineChangeAsync(JsonElement payload, string engine)
    {
        var target = payload.TryGetProperty("target", out var targetValue) ? targetValue.GetString() : null;
        if (target == "draft" && _draft is not null)
        {
            var draft = _draft;
            await PrepareDraftAsync(draft.Bytes, draft.Name, draft.Extension, engine);
            return;
        }
        if (target == "edit")
        {
            await RerunOcrAsync(ReadGuid(payload, "id"), engine);
            return;
        }
        await SendStateAsync();
    }

    private async Task UninstallPaddleOcrAsync()
    {
        await SetWebBusyAsync(true, "正在删除 PaddleOCR…");
        try
        {
            await _paddleOcr.UninstallAsync();
            if (_store.State.Settings.OcrEngine == "PaddleOcrV6") SaveOcrEngine("None");
            await SendStateAsync();
            await InvokeWebAsync("showNotice", new { title = "PaddleOCR 已删除", message = "运行环境和识别模型已从本机移除。" });
        }
        finally
        {
            await SetWebBusyAsync(false, string.Empty);
        }
    }

    private async Task CreateBackupAsync()
    {
        using var dialog = new SaveFileDialog
        {
            Title = "导出 QuoteVault 完整备份",
            Filter = "QuoteVault 备份|*.zip",
            FileName = $"QuoteVault-backup-{DateTime.Now:yyyyMMdd-HHmmss}.zip"
        };
        if (dialog.ShowDialog(this) != DialogResult.OK) return;
        await SetWebBusyAsync(true, "正在创建完整备份…");
        try
        {
            await Task.Run(() => _store.CreateBackup(dialog.FileName));
            await InvokeWebAsync("showError", "备份已创建。");
        }
        finally
        {
            await SetWebBusyAsync(false, string.Empty);
        }
    }

    private async Task<bool> RestoreBackupAsync()
    {
        using var dialog = new OpenFileDialog { Title = "选择 QuoteVault 备份", Filter = "QuoteVault 备份|*.zip" };
        if (dialog.ShowDialog(this) != DialogResult.OK) return false;
        var confirmed = MessageBox.Show(this,
            "恢复备份将替换当前图库。QuoteVault 会先自动创建一份恢复前备份。\n\n确定继续吗？",
            "恢复完整备份", MessageBoxButtons.OKCancel, MessageBoxIcon.Warning) == DialogResult.OK;
        if (!confirmed) return false;
        await SetWebBusyAsync(true, "正在验证并恢复备份…");
        try
        {
            await Task.Run(() => _store.RestoreBackup(dialog.FileName));
            _selectedPersonId = null;
            _selectedScreenshotId = null;
            _topView = "library";
            _activePanel = "preview";
            await InvokeWebAsync("showError", "备份恢复完成。");
            return true;
        }
        finally
        {
            await SetWebBusyAsync(false, string.Empty);
        }
    }

    private void BatchAction(JsonElement payload)
    {
        var ids = ReadStringList(payload, "ids")
            .Select(x => Guid.TryParse(x, out var id) ? id : Guid.Empty).Where(x => x != Guid.Empty).ToHashSet();
        var action = payload.GetProperty("action").GetString();
        var tags = action == "addTags" ? NormalizeTags(ReadStringList(payload, "tags")) : [];
        var selected = _store.State.Screenshots.Where(x => ids.Contains(x.Id)).ToList();
        if (action == "deleteForever")
        {
            _store.PermanentlyDeleteMany(selected);
            _selectedScreenshotId = null;
            return;
        }
        foreach (var item in selected)
        {
            if (action == "trash") _store.MoveToTrash(item, false);
            else if (action == "pending")
            {
                item.DeletedAt = null;
                item.NeedsReview = true;
            }
            else if (action == "restore")
            {
                _store.RestoreFromTrash(item, false);
                if (!item.LibraryId.HasValue) item.NeedsReview = true;
            }
            else if (action == "addTags") item.Tags = NormalizeTags(item.Tags.Concat(tags));
        }
        _store.Save();
        _selectedScreenshotId = null;
    }

    private void NormalizeSelection()
    {
        if (_selectedScreenshotId is not Guid id) return;
        var item = _store.State.Screenshots.FirstOrDefault(x => x.Id == id);
        var valid = item is not null && (_topView switch
        {
            "trash" => item.DeletedAt.HasValue,
            "pending" => !item.DeletedAt.HasValue && item.NeedsReview,
            "library" => _selectedPersonId.HasValue && !item.DeletedAt.HasValue && !item.NeedsReview &&
                         item.LibraryId == _selectedPersonId.Value,
            _ => false
        });
        if (!valid) _selectedScreenshotId = null;
    }

    private async Task QuickImportClipboardAsync()
    {
        if (!Clipboard.ContainsImage()) return;
        using var image = Clipboard.GetImage();
        if (image is null) return;
        using var stream = new MemoryStream();
        image.Save(stream, ImageFormat.Png);
        var bytes = stream.ToArray();
        var item = _store.AddImage(bytes, $"剪贴板-{DateTime.Now:yyyyMMdd-HHmmss}.png", ".png", false);
        try
        {
            var output = await RecognizeAsync(_store.GetImageFile(item));
            item.OcrRawText = output.RawText;
            item.OcrConfidence = output.Confidence;
            item.OcrEngine = output.Engine;
            item.OcrEngineKey = _store.State.Settings.OcrEngine;
            item.SearchText = SearchTextFromOcr(output);
        }
        catch (Exception ex)
        {
            await ShowWebErrorAsync($"截图已加入待处理，但 OCR 失败：{ex.Message}");
        }
        finally
        {
            item.NeedsReview = true;
            _store.Save();
        }
        _selectedScreenshotId = item.Id;
        _selectedPersonId = null;
        _topView = "pending";
        await SendStateAsync("preview");
    }

    private bool RegisterConfiguredHotKey()
    {
        UnregisterConfiguredHotKey();
        var settings = _store.State.Settings;
        uint modifiers = 0;
        if (settings.HotKeyAlt) modifiers |= 0x0001;
        if (settings.HotKeyCtrl) modifiers |= 0x0002;
        if (settings.HotKeyShift) modifiers |= 0x0004;
        _hotKeyRegistered = RegisterHotKey(Handle, HotKeyId, modifiers | 0x4000, (uint)settings.HotKey);
        return _hotKeyRegistered;
    }

    private string DescribeConfiguredHotKey()
    {
        var settings = _store.State.Settings;
        var parts = new List<string>();
        if (settings.HotKeyCtrl) parts.Add("Ctrl");
        if (settings.HotKeyAlt) parts.Add("Alt");
        if (settings.HotKeyShift) parts.Add("Shift");
        parts.Add(settings.HotKey is >= Keys.D0 and <= Keys.D9
            ? ((int)settings.HotKey - (int)Keys.D0).ToString()
            : settings.HotKey.ToString());
        return string.Join("+", parts);
    }

    private void UnregisterConfiguredHotKey()
    {
        if (!_hotKeyRegistered) return;
        UnregisterHotKey(Handle, HotKeyId);
        _hotKeyRegistered = false;
    }

    private void HandleWindowAction(string? action)
    {
        switch (action)
        {
            case "minimize": WindowState = FormWindowState.Minimized; break;
            case "maximize":
                if (WindowState == FormWindowState.Maximized) WindowState = FormWindowState.Normal;
                else
                {
                    var screen = Screen.FromHandle(Handle);
                    var area = screen.WorkingArea;
                    if (area.Bottom >= screen.Bounds.Bottom) area.Height = Math.Max(1, area.Height - 2);
                    MaximizedBounds = area;
                    WindowState = FormWindowState.Maximized;
                }
                break;
            case "close": Close(); break;
            case "drag":
                if (WindowState == FormWindowState.Maximized) WindowState = FormWindowState.Normal;
                ReleaseCapture();
                SendMessage(Handle, WmNcLButtonDown, HtCaption, 0);
                break;
        }
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WmHotKey && m.WParam.ToInt32() == HotKeyId)
        {
            BeginInvoke(async () => await QuickImportClipboardAsync());
            return;
        }
        if (m.Msg == WmNcHitTest && WindowState == FormWindowState.Normal)
        {
            base.WndProc(ref m);
            var point = PointToClient(Cursor.Position);
            var left = point.X <= ResizeBorder;
            var right = point.X >= ClientSize.Width - ResizeBorder;
            var top = point.Y <= ResizeBorder;
            var bottom = point.Y >= ClientSize.Height - ResizeBorder;
            if (left && top) m.Result = (IntPtr)13;
            else if (right && top) m.Result = (IntPtr)14;
            else if (left && bottom) m.Result = (IntPtr)16;
            else if (right && bottom) m.Result = (IntPtr)17;
            else if (left) m.Result = (IntPtr)10;
            else if (right) m.Result = (IntPtr)11;
            else if (top) m.Result = (IntPtr)12;
            else if (bottom) m.Result = (IntPtr)15;
            return;
        }
        base.WndProc(ref m);
    }

    private static Guid? ReadGuid(JsonElement element, string property)
    {
        if (element.ValueKind == JsonValueKind.Undefined || !element.TryGetProperty(property, out var value)) return null;
        return value.ValueKind == JsonValueKind.String && Guid.TryParse(value.GetString(), out var parsed) ? parsed : null;
    }

    private static List<string> ReadStringList(JsonElement element, string property)
    {
        if (element.ValueKind == JsonValueKind.Undefined || !element.TryGetProperty(property, out var value) || value.ValueKind != JsonValueKind.Array)
            return [];
        return value.EnumerateArray().Where(x => x.ValueKind == JsonValueKind.String)
            .Select(x => x.GetString() ?? string.Empty).ToList();
    }

    private static string ReadText(JsonElement element, string property) =>
        element.ValueKind != JsonValueKind.Undefined && element.TryGetProperty(property, out var value) &&
        value.ValueKind == JsonValueKind.String ? value.GetString() ?? string.Empty : string.Empty;

    private static string? ReadOptionalOcrEngine(JsonElement payload)
    {
        if (payload.ValueKind == JsonValueKind.Undefined || !payload.TryGetProperty("engine", out var value)) return null;
        return value.GetString() is "PaddleOcrV6" or "None" ? value.GetString() : null;
    }

    private static string NormalizeSearchText(string? value) =>
        string.Join(Environment.NewLine, (value ?? string.Empty).Replace("\r\n", "\n").Replace('\r', '\n')
            .Split('\n').Select(x => x.TrimEnd())).Trim();

    private static List<string> NormalizeTags(IEnumerable<string> values) => values
        .SelectMany(x => x.Split([',', '，', ';', '；'], StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries))
        .Where(x => x.Length <= 40).Distinct(StringComparer.OrdinalIgnoreCase).Take(30).ToList();

    private static void ValidateImage(byte[] bytes)
    {
        using var stream = new MemoryStream(bytes);
        using var _ = Image.FromStream(stream, true, true);
    }

    private static string NormalizeExtension(string extension)
    {
        var value = extension.ToLowerInvariant();
        return value is ".png" or ".jpg" or ".jpeg" or ".bmp" or ".gif" ? value : ".png";
    }

    private static string MimeForExtension(string extension) => extension.ToLowerInvariant() switch
    {
        ".jpg" or ".jpeg" => "image/jpeg",
        ".bmp" => "image/bmp",
        ".gif" => "image/gif",
        _ => "image/png"
    };

    [DllImport("user32.dll", SetLastError = true)] private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool UnregisterHotKey(IntPtr hWnd, int id);
    [DllImport("user32.dll")] private static extern bool ReleaseCapture();
    [DllImport("user32.dll")] private static extern IntPtr SendMessage(IntPtr hWnd, int msg, int wParam, int lParam);
    [DllImport("dwmapi.dll")] private static extern int DwmSetWindowAttribute(IntPtr hWnd, int attribute, ref int value, int size);

    private sealed record ImportDraft(byte[] Bytes, string Name, string Extension, OcrOutput Ocr, string OcrEngineKey);
    private sealed record IncomingImage(byte[] Bytes, string Name, string Extension);
    private sealed record PendingDuplicateCommit(bool Pending, Guid? LibraryId, List<string> Tags,
        string SearchText, Guid DuplicateId);
}
