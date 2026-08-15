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
    private readonly OcrService _tesseractOcr = new();
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
            _webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
            _webView.CoreWebView2.Settings.AreDevToolsEnabled = false;
            _webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
            _webView.CoreWebView2.WebMessageReceived += OnWebMessageReceived;
            _webView.Source = new Uri("https://app.quotevault.local/index.html");
            RegisterConfiguredHotKey();
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
                    await SendStateAsync();
                    break;
                case "setOcrEngine":
                    await SetOcrEngineAsync(payload);
                    break;
                case "installPaddleOcr":
                    await InstallPaddleOcrAsync(payload);
                    break;
                case "createBackup":
                    CreateBackup();
                    break;
                case "restoreBackup":
                    RestoreBackup();
                    await SendStateAsync();
                    break;
                case "batchAction":
                    BatchAction(payload);
                    await SendStateAsync();
                    break;
                case "chooseImage":
                    await ChooseImageForDraftAsync();
                    break;
                case "prepareClipboard":
                    await PrepareClipboardDraftAsync();
                    break;
                case "prepareDroppedImage":
                    await PrepareDroppedDraftAsync(payload);
                    break;
                case "prepareDroppedImages":
                    await PrepareDroppedBatchAsync(payload);
                    break;
                case "cancelDraft":
                    _draft = null;
                    break;
                case "commitDraft":
                    await CommitDraftAsync(payload.GetProperty("pending").GetBoolean(), ReadGuid(payload, "personId"),
                        ReadStringList(payload, "keywords"), ReadMessages(payload));
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
                    await RerunOcrAsync(ReadGuid(payload, "id"));
                    break;
                case "finishPending":
                    FinishPending(ReadGuid(payload, "id"));
                    await SendStateAsync("preview");
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
                detectedNicknames = x.DetectedNicknames,
                personIds = x.PersonIds,
                messages = x.Messages.OrderBy(m => m.SortOrder).Select(m => new
                {
                    id = m.Id,
                    sortOrder = m.SortOrder,
                    personId = m.PersonId,
                    detectedNickname = m.DetectedNickname,
                    text = m.Text
                }),
                keywords = x.Keywords,
                imageUrl = $"https://images.quotevault.local/{Uri.EscapeDataString(x.StoredFileName)}"
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
                paddleAvailable = _paddleOcr.IsFullyInstalled
            }
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

    private Task<OcrOutput> RecognizeAsync(string imagePath, CancellationToken cancellationToken = default)
    {
        return _store.State.Settings.OcrEngine switch
        {
            "PaddleOcrV6" when _paddleOcr.IsFullyInstalled => _paddleOcr.RecognizeAsync(imagePath, cancellationToken),
            "PaddleOcrV6" => throw new InvalidOperationException("PaddleOCR 尚未安装，请先在设置中完成安装。"),
            "Tesseract" => _tesseractOcr.RecognizeAsync(imagePath, cancellationToken),
            _ => Task.FromResult(new OcrOutput(string.Empty, 0, [string.Empty], [], "未使用 OCR"))
        };
    }

    private async Task ChooseImageForDraftAsync()
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
            await PrepareDraftAsync(await File.ReadAllBytesAsync(dialog.FileName), Path.GetFileName(dialog.FileName), Path.GetExtension(dialog.FileName));
            return;
        }
        var files = new List<IncomingImage>();
        foreach (var file in dialog.FileNames)
            files.Add(new IncomingImage(await File.ReadAllBytesAsync(file), Path.GetFileName(file), Path.GetExtension(file)));
        await ImportBatchToPendingAsync(files);
    }

    private async Task PrepareClipboardDraftAsync()
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
        await PrepareDraftAsync(stream.ToArray(), $"剪贴板-{DateTime.Now:yyyyMMdd-HHmmss}.png", ".png");
    }

    private async Task PrepareDroppedDraftAsync(JsonElement payload)
    {
        var name = payload.GetProperty("name").GetString() ?? "拖入图片.png";
        var dataUrl = payload.GetProperty("dataUrl").GetString() ?? throw new InvalidDataException("拖入的图片为空。");
        var comma = dataUrl.IndexOf(',');
        if (comma < 0) throw new InvalidDataException("无法读取拖入的图片。");
        var bytes = Convert.FromBase64String(dataUrl[(comma + 1)..]);
        await PrepareDraftAsync(bytes, name, Path.GetExtension(name));
    }

    private async Task PrepareDroppedBatchAsync(JsonElement payload)
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
        await ImportBatchToPendingAsync(files);
    }

    private async Task ImportBatchToPendingAsync(IReadOnlyList<IncomingImage> files)
    {
        if (files.Count == 0) return;
        await SetWebBusyAsync(true, $"正在导入 {files.Count} 张截图…");
        var imported = 0;
        var skippedDuplicates = 0;
        foreach (var file in files)
        {
            ValidateImage(file.Bytes);
            var duplicate = _store.FindDuplicate(AppStore.ComputeSha256(file.Bytes));
            if (duplicate is not null)
            {
                skippedDuplicates++;
                continue;
            }

            var extension = NormalizeExtension(file.Extension);
            var item = _store.AddImage(file.Bytes, file.Name, extension);
            item.NeedsReview = true;
            try
            {
                var output = await RecognizeAsync(_store.GetImageFile(item));
                item.OcrRawText = output.RawText;
                item.OcrConfidence = output.Confidence;
                item.OcrEngine = output.Engine;
                item.DetectedNicknames = output.NicknameCandidates.ToList();
                item.Messages = CreateMessagesFromOcr(output);
                AddMessagePeople(item);
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
        await InvokeWebAsync("clearDraft");
        await SendStateAsync(imported > 0 ? "pending" : "preview");
        if (skippedDuplicates > 0) await InvokeWebAsync("showError", $"已跳过 {skippedDuplicates} 张重复图片。");
    }

    private async Task PrepareDraftAsync(byte[] bytes, string name, string extension)
    {
        ValidateImage(bytes);
        extension = NormalizeExtension(extension);
        var temp = Path.Combine(Path.GetTempPath(), $"QuoteVault-{Guid.NewGuid():N}{extension}");
        try
        {
            await SetWebBusyAsync(true, _store.State.Settings.OcrEngine == "None" ? "正在读取截图…" : "正在识别截图…");
            await File.WriteAllBytesAsync(temp, bytes);
            var output = await RecognizeAsync(temp);
            _draft = new ImportDraft(bytes, name, extension, output);
            _topView = "library";
            _activePanel = "add";
            var dataUrl = $"data:{MimeForExtension(extension)};base64,{Convert.ToBase64String(bytes)}";
            await InvokeWebAsync("setDraft", new
            {
                name,
                dataUrl,
                confidence = output.Confidence,
                ocrEngine = output.Engine,
                messages = output.Lines.Select((line, index) =>
                {
                    var detectedNickname = output.SpeakerNicknames?.ElementAtOrDefault(index);
                    var personId = ResolveNickname(detectedNickname);
                    return new { sortOrder = index, text = line, personId, detectedNickname };
                })
            });
        }
        finally
        {
            if (File.Exists(temp)) File.Delete(temp);
        }
    }

    private async Task CommitDraftAsync(bool pending, Guid? personId, IReadOnlyList<string> keywords,
        IReadOnlyList<MessageItem> editedMessages, bool bypassDuplicateCheck = false)
    {
        if (_draft is null) return;
        var hash = AppStore.ComputeSha256(_draft.Bytes);
        var duplicate = _store.FindDuplicate(hash);
        if (duplicate is not null && !bypassDuplicateCheck)
        {
            _pendingDuplicateCommit = new PendingDuplicateCommit(pending, personId, keywords.ToList(),
                editedMessages.Select(CloneMessage).ToList(), duplicate.Id);
            await InvokeWebAsync("showDuplicate", new { duplicate.OriginalFileName });
            return;
        }

        var item = _store.AddImage(_draft.Bytes, _draft.Name, _draft.Extension);
        item.OcrRawText = _draft.Ocr.RawText;
        item.OcrConfidence = _draft.Ocr.Confidence;
        item.OcrEngine = _draft.Ocr.Engine;
        item.DetectedNicknames = _draft.Ocr.NicknameCandidates.ToList();
        item.Messages = editedMessages.Count > 0
            ? editedMessages.Select(CloneMessage).Where(x => !string.IsNullOrWhiteSpace(x.Text)).ToList()
            : CreateMessagesFromOcr(_draft.Ocr);
        item.NeedsReview = pending;
        item.Keywords = NormalizeKeywords(keywords);
        if (personId is Guid id && _store.State.People.Any(x => x.Id == id)) item.PersonIds.Add(id);
        foreach (var speakerId in item.Messages.Select(x => x.PersonId).OfType<Guid>()
                     .Where(id => _store.State.People.Any(person => person.Id == id)))
            if (!item.PersonIds.Contains(speakerId)) item.PersonIds.Add(speakerId);
        _store.Save();

        _selectedScreenshotId = item.Id;
        _selectedPersonId = personId ?? _selectedPersonId;
        _draft = null;
        await InvokeWebAsync("clearDraft");
        await SendStateAsync(item.NeedsReview ? "pending" : "preview");
    }

    private async Task ResolveDuplicateAsync(string? action)
    {
        var pending = _pendingDuplicateCommit;
        _pendingDuplicateCommit = null;
        if (pending is null) return;
        if (action == "import")
        {
            await CommitDraftAsync(pending.Pending, pending.PersonId, pending.Keywords, pending.Messages, true);
            return;
        }
        if (action == "view")
        {
            var duplicate = _store.State.Screenshots.FirstOrDefault(x => x.Id == pending.DuplicateId);
            if (duplicate is not null)
            {
                _selectedScreenshotId = duplicate.Id;
                _draft = null;
                await InvokeWebAsync("clearDraft");
                await SendStateAsync(duplicate.NeedsReview ? "pending" : "preview");
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
        var messages = new List<MessageItem>();
        foreach (var element in payload.GetProperty("messages").EnumerateArray())
        {
            messages.Add(new MessageItem
            {
                Id = ReadGuid(element, "id") ?? Guid.NewGuid(),
                SortOrder = element.GetProperty("sortOrder").GetInt32(),
                PersonId = ReadGuid(element, "personId"),
                Text = element.GetProperty("text").GetString()?.Trim() ?? string.Empty
            });
        }
        item.Messages = messages.Where(x => !string.IsNullOrWhiteSpace(x.Text)).OrderBy(x => x.SortOrder).ToList();
        item.PersonIds = payload.GetProperty("personIds").EnumerateArray()
            .Select(x => Guid.TryParse(x.GetString(), out var parsed) ? parsed : Guid.Empty)
            .Where(x => x != Guid.Empty && _store.State.People.Any(p => p.Id == x)).Distinct().ToList();
        if (_selectedPersonId is Guid current && !item.PersonIds.Contains(current)) item.PersonIds.Add(current);
        if (_topView == "pending" && item.PersonIds.Count == 0)
            throw new InvalidOperationException("完成待处理截图前，请至少为一条消息选择发言人。");
        item.Keywords = NormalizeKeywords(ReadStringList(payload, "keywords"));
        item.NeedsReview = false;
        _store.Save();
    }

    private async Task RerunOcrAsync(Guid? id)
    {
        var item = _store.State.Screenshots.FirstOrDefault(x => x.Id == id) ?? throw new FileNotFoundException("截图不存在。");
        await SetWebBusyAsync(true, _store.State.Settings.OcrEngine == "None" ? "正在关闭当前截图的 OCR…" : "正在重新识别…");
        var output = await RecognizeAsync(_store.GetImageFile(item));
        item.OcrRawText = output.RawText;
        item.OcrConfidence = output.Confidence;
        item.OcrEngine = output.Engine;
        item.DetectedNicknames = output.NicknameCandidates.ToList();
        item.Messages = CreateMessagesFromOcr(output);
        AddMessagePeople(item);
        _store.Save();
        await SendStateAsync("edit");
    }

    private void FinishPending(Guid? id)
    {
        var item = _store.State.Screenshots.FirstOrDefault(x => x.Id == id) ?? throw new FileNotFoundException("截图不存在。");
        if (item.PersonIds.Count == 0 && _selectedPersonId is Guid personId) item.PersonIds.Add(personId);
        if (item.PersonIds.Count == 0)
            throw new InvalidOperationException("请先在“编辑”中为截图关联至少一位成员。");
        item.NeedsReview = false;
        _store.Save();
        _selectedScreenshotId = _store.State.Screenshots
            .Where(x => !x.DeletedAt.HasValue && x.NeedsReview && x.Id != item.Id)
            .OrderByDescending(x => x.ImportedAt).Select(x => (Guid?)x.Id).FirstOrDefault();
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
        _store.RestoreFromTrash(item);
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
            screenshot.PersonIds.Remove(member.Id);
            foreach (var message in screenshot.Messages.Where(x => x.PersonId == member.Id)) message.PersonId = null;
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
        var sourceMemberId = ReadGuid(payload, "sourceMemberId");
        if (!_store.State.People.Any(x => x.Id == targetMemberId)) throw new InvalidDataException("目标成员不存在。");
        var ids = ReadStringList(payload, "ids").Select(x => Guid.TryParse(x, out var id) ? id : Guid.Empty)
            .Where(x => x != Guid.Empty).ToHashSet();
        foreach (var item in _store.State.Screenshots.Where(x => ids.Contains(x.Id) && !x.DeletedAt.HasValue))
        {
            if (sourceMemberId.HasValue && sourceMemberId != targetMemberId) item.PersonIds.Remove(sourceMemberId.Value);
            if (!item.PersonIds.Contains(targetMemberId)) item.PersonIds.Add(targetMemberId);
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
        _selectedPersonId = item.PersonIds.FirstOrDefault() is var personId && personId != Guid.Empty ? personId : null;
        _topView = item.NeedsReview ? "pending" : "library";
    }

    private List<Guid> ReadValidGroupIds(JsonElement payload) =>
        ReadStringList(payload, "groupIds")
            .Select(x => Guid.TryParse(x, out var id) ? id : Guid.Empty)
            .Where(id => id != Guid.Empty && _store.State.Categories.Any(x => x.Id == id))
            .Distinct().ToList();

    private List<MessageItem> CreateMessagesFromOcr(OcrOutput output) =>
        output.Lines.Select((line, index) => new MessageItem
        {
            SortOrder = index,
            Text = line,
            PersonId = ResolveNickname(output.SpeakerNicknames?.ElementAtOrDefault(index)),
            DetectedNickname = output.SpeakerNicknames?.ElementAtOrDefault(index)
        }).ToList();

    private Guid? ResolveNickname(string? nickname)
    {
        if (string.IsNullOrWhiteSpace(nickname)) return null;
        var mapping = _store.State.NicknameMappings.FirstOrDefault(x =>
            string.Equals(x.Nickname, nickname, StringComparison.OrdinalIgnoreCase));
        if (mapping is not null && _store.State.People.Any(x => x.Id == mapping.PersonId)) return mapping.PersonId;
        return _store.State.People.FirstOrDefault(x =>
            string.Equals(x.DisplayName, nickname, StringComparison.OrdinalIgnoreCase))?.Id;
    }

    private void AddMessagePeople(ScreenshotItem item)
    {
        foreach (var personId in item.Messages.Select(x => x.PersonId).OfType<Guid>().Distinct())
            if (!item.PersonIds.Contains(personId)) item.PersonIds.Add(personId);
    }

    private void SaveHotKeySettings(JsonElement payload)
    {
        var keyText = payload.GetProperty("hotKey").GetString();
        if (!Enum.TryParse<Keys>(keyText, true, out var key) ||
            !(key is >= Keys.A and <= Keys.Z || key is >= Keys.F1 and <= Keys.F12)) key = Keys.F8;
        _store.State.Settings.HotKeyCtrl = payload.GetProperty("hotKeyCtrl").GetBoolean();
        _store.State.Settings.HotKeyAlt = payload.GetProperty("hotKeyAlt").GetBoolean();
        _store.State.Settings.HotKeyShift = payload.GetProperty("hotKeyShift").GetBoolean();
        _store.State.Settings.HotKey = key;
        _store.Save();
        RegisterConfiguredHotKey();
    }

    private async Task SetOcrEngineAsync(JsonElement payload)
    {
        var engine = ReadOcrEngine(payload);
        if (engine == "PaddleOcrV6" && !_paddleOcr.IsFullyInstalled)
            throw new InvalidOperationException("PaddleOCR 尚未安装。选择安装后才能启用该识别引擎。");
        SaveOcrEngine(engine);
        await CompleteOcrEngineChangeAsync(payload);
    }

    private void SaveOcrEngine(string engine)
    {
        _store.State.Settings.OcrEngine = engine;
        _store.State.Settings.HasExplicitOcrChoice = true;
        _store.Save();
    }

    private static string ReadOcrEngine(JsonElement payload) =>
        payload.TryGetProperty("engine", out var engine) && engine.GetString() is "PaddleOcrV6" or "Tesseract"
            ? engine.GetString()!
            : "None";

    private async Task CompleteOcrEngineChangeAsync(JsonElement payload)
    {
        var target = payload.TryGetProperty("target", out var targetValue) ? targetValue.GetString() : null;
        if (target == "draft" && _draft is not null)
        {
            var draft = _draft;
            await SendStateAsync();
            await PrepareDraftAsync(draft.Bytes, draft.Name, draft.Extension);
            return;
        }
        if (target == "edit")
        {
            await RerunOcrAsync(ReadGuid(payload, "id"));
            return;
        }
        await SendStateAsync();
    }

    private async Task InstallPaddleOcrAsync(JsonElement payload)
    {
        await SetWebBusyAsync(true, "正在安装 PaddleOCR 运行环境与模型，这可能需要几分钟…");
        var scriptPath = Path.Combine(AppContext.BaseDirectory, "paddleocr", "setup-runtime.ps1");
        if (!File.Exists(scriptPath)) throw new FileNotFoundException("找不到 PaddleOCR 安装脚本。", scriptPath);

        var startInfo = new ProcessStartInfo("powershell.exe")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = System.Text.Encoding.UTF8,
            StandardErrorEncoding = System.Text.Encoding.UTF8
        };
        startInfo.ArgumentList.Add("-NoProfile");
        startInfo.ArgumentList.Add("-ExecutionPolicy");
        startInfo.ArgumentList.Add("Bypass");
        startInfo.ArgumentList.Add("-File");
        startInfo.ArgumentList.Add(scriptPath);
        startInfo.ArgumentList.Add("-DownloadModels");

        using var process = Process.Start(startInfo) ?? throw new InvalidOperationException("无法启动 PaddleOCR 安装程序。");
        var outputTask = process.StandardOutput.ReadToEndAsync();
        var errorTask = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        var output = await outputTask;
        var error = await errorTask;
        if (process.ExitCode != 0)
            throw new InvalidOperationException("PaddleOCR 安装失败。\n" +
                                                (string.IsNullOrWhiteSpace(error) ? output : error).Trim());
        if (!_paddleOcr.IsFullyInstalled)
            throw new InvalidOperationException("安装程序已结束，但 PaddleOCR 运行环境或模型不完整。");

        SaveOcrEngine("PaddleOcrV6");
        await CompleteOcrEngineChangeAsync(payload);
        await ShowWebErrorAsync("PaddleOCR 已安装并启用。");
    }

    private void CreateBackup()
    {
        using var dialog = new SaveFileDialog
        {
            Title = "导出 QuoteVault 完整备份",
            Filter = "QuoteVault 备份|*.zip",
            FileName = $"QuoteVault-backup-{DateTime.Now:yyyyMMdd-HHmmss}.zip"
        };
        if (dialog.ShowDialog(this) == DialogResult.OK) _store.CreateBackup(dialog.FileName);
    }

    private void RestoreBackup()
    {
        using var dialog = new OpenFileDialog { Title = "选择 QuoteVault 备份", Filter = "QuoteVault 备份|*.zip" };
        if (dialog.ShowDialog(this) == DialogResult.OK) _store.RestoreBackup(dialog.FileName);
    }

    private void BatchAction(JsonElement payload)
    {
        var ids = ReadStringList(payload, "ids")
            .Select(x => Guid.TryParse(x, out var id) ? id : Guid.Empty).Where(x => x != Guid.Empty).ToHashSet();
        var action = payload.GetProperty("action").GetString();
        foreach (var item in _store.State.Screenshots.Where(x => ids.Contains(x.Id)).ToList())
        {
            if (action == "trash") _store.MoveToTrash(item);
            else if (action == "pending")
            {
                item.DeletedAt = null;
                item.NeedsReview = true;
            }
            else if (action == "restore") _store.RestoreFromTrash(item);
            else if (action == "deleteForever") _store.PermanentlyDelete(item);
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
                         item.PersonIds.Contains(_selectedPersonId.Value),
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
        var item = _store.AddImage(bytes, $"剪贴板-{DateTime.Now:yyyyMMdd-HHmmss}.png", ".png");
        try
        {
            var output = await RecognizeAsync(_store.GetImageFile(item));
            item.OcrRawText = output.RawText;
            item.OcrConfidence = output.Confidence;
            item.OcrEngine = output.Engine;
            item.DetectedNicknames = output.NicknameCandidates.ToList();
            item.Messages = CreateMessagesFromOcr(output);
            AddMessagePeople(item);
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
        await SendStateAsync("pending");
    }

    private void RegisterConfiguredHotKey()
    {
        UnregisterConfiguredHotKey();
        var settings = _store.State.Settings;
        uint modifiers = 0;
        if (settings.HotKeyAlt) modifiers |= 0x0001;
        if (settings.HotKeyCtrl) modifiers |= 0x0002;
        if (settings.HotKeyShift) modifiers |= 0x0004;
        _hotKeyRegistered = RegisterHotKey(Handle, HotKeyId, modifiers | 0x4000, (uint)settings.HotKey);
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

    private static List<MessageItem> ReadMessages(JsonElement payload)
    {
        if (payload.ValueKind == JsonValueKind.Undefined || !payload.TryGetProperty("messages", out var value) ||
            value.ValueKind != JsonValueKind.Array) return [];
        return value.EnumerateArray().Select((element, index) => new MessageItem
        {
            Id = ReadGuid(element, "id") ?? Guid.NewGuid(),
            SortOrder = index,
            PersonId = ReadGuid(element, "personId"),
            DetectedNickname = element.TryGetProperty("detectedNickname", out var nickname)
                ? nickname.GetString()?.Trim()
                : null,
            Text = element.TryGetProperty("text", out var text) ? text.GetString()?.Trim() ?? string.Empty : string.Empty
        }).Where(x => !string.IsNullOrWhiteSpace(x.Text)).ToList();
    }

    private static MessageItem CloneMessage(MessageItem source) => new()
    {
        Id = source.Id,
        SortOrder = source.SortOrder,
        PersonId = source.PersonId,
        DetectedNickname = source.DetectedNickname,
        Text = source.Text
    };

    private static List<string> NormalizeKeywords(IEnumerable<string> values) => values
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

    private sealed record ImportDraft(byte[] Bytes, string Name, string Extension, OcrOutput Ocr);
    private sealed record IncomingImage(byte[] Bytes, string Name, string Extension);
    private sealed record PendingDuplicateCommit(bool Pending, Guid? PersonId, List<string> Keywords,
        List<MessageItem> Messages, Guid DuplicateId);
}
