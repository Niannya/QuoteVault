using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;

namespace QuoteVault;

public sealed class AppStore
{
    private readonly object _gate = new();
    private readonly JsonSerializerOptions _jsonOptions = new()
    {
        WriteIndented = true,
        PropertyNameCaseInsensitive = true,
        Converters = { new JsonStringEnumConverter() }
    };

    public string RootPath { get; }
    public string ImagePath { get; }
    public string ThumbnailPath { get; }
    public string DataFilePath { get; }
    public AppState State { get; private set; }
    public string? LoadWarning { get; private set; }

    public AppStore(string? rootPath = null)
    {
        RootPath = rootPath ?? Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "QuoteVault");
        ImagePath = Path.Combine(RootPath, "images");
        ThumbnailPath = Path.Combine(RootPath, "thumbnails");
        DataFilePath = Path.Combine(RootPath, "data.json");
        Directory.CreateDirectory(ImagePath);
        Directory.CreateDirectory(ThumbnailPath);
        State = Load();
    }

    private AppState Load()
    {
        if (!File.Exists(DataFilePath)) return new AppState();
        try
        {
            var state = JsonSerializer.Deserialize<AppState>(File.ReadAllText(DataFilePath), _jsonOptions)
                        ?? new AppState();
            NormalizeState(state);
            return state;
        }
        catch (Exception ex)
        {
            var broken = DataFilePath + $".broken-{DateTime.Now:yyyyMMdd-HHmmss}";
            try
            {
                File.Move(DataFilePath, broken, true);
            }
            catch
            {
                File.Copy(DataFilePath, broken, true);
                TryDeleteFile(DataFilePath);
            }
            LoadWarning = $"索引文件无法读取，QuoteVault 已使用空索引启动。原文件已保留在：\n{broken}\n\n错误：{ex.Message}";
            return new AppState();
        }
    }

    public void Save()
    {
        lock (_gate)
        {
            Directory.CreateDirectory(RootPath);
            var temp = DataFilePath + ".tmp";
            File.WriteAllText(temp, JsonSerializer.Serialize(State, _jsonOptions));
            File.Move(temp, DataFilePath, true);
        }
    }

    public string GetImageFile(ScreenshotItem item) => Path.Combine(ImagePath, ValidateStoredFileName(item.StoredFileName));
    public string GetThumbnailFile(ScreenshotItem item) =>
        Path.Combine(ThumbnailPath, Path.GetFileNameWithoutExtension(ValidateStoredFileName(item.StoredFileName)) + ".jpg");

    public static string ComputeSha256(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes));

    public ScreenshotItem? FindDuplicate(string hash) =>
        State.Screenshots.FirstOrDefault(x => string.Equals(x.Sha256, hash, StringComparison.OrdinalIgnoreCase));

    public ScreenshotItem AddImage(byte[] bytes, string originalName, string extension, bool save = true)
    {
        extension = NormalizeExtension(extension);
        var item = new ScreenshotItem
        {
            StoredFileName = $"{Guid.NewGuid():N}{extension}",
            OriginalFileName = string.IsNullOrWhiteSpace(originalName) ? "剪贴板图片.png" : originalName,
            Sha256 = ComputeSha256(bytes)
        };
        var imageFile = GetImageFile(item);
        File.WriteAllBytes(imageFile, bytes);
        TryCreateThumbnail(item, imageFile);
        State.Screenshots.Add(item);
        if (save) Save();
        return item;
    }

    public void MoveToTrash(ScreenshotItem item, bool save = true)
    {
        item.DeletedAt = DateTimeOffset.Now;
        if (save) Save();
    }

    public void RestoreFromTrash(ScreenshotItem item, bool save = true)
    {
        item.DeletedAt = null;
        if (save) Save();
    }

    public void PermanentlyDelete(ScreenshotItem item, bool save = true)
    {
        var file = GetImageFile(item);
        var thumbnail = GetThumbnailFile(item);
        State.Screenshots.Remove(item);
        if (save) Save();
        TryDeleteFile(file);
        TryDeleteFile(thumbnail);
    }

    public void PermanentlyDeleteMany(IEnumerable<ScreenshotItem> items)
    {
        var selected = items.Distinct().ToList();
        var files = selected.Select(GetImageFile).ToList();
        var thumbnails = selected.Select(GetThumbnailFile).ToList();
        foreach (var item in selected) State.Screenshots.Remove(item);
        Save();
        foreach (var file in files) TryDeleteFile(file);
        foreach (var thumbnail in thumbnails) TryDeleteFile(thumbnail);
    }

    public void CreateBackup(string destinationZip)
    {
        lock (_gate)
        {
            Save();
            var temp = destinationZip + $".tmp-{Guid.NewGuid():N}";
            try
            {
                using (var file = File.Create(temp))
                using (var archive = new ZipArchive(file, ZipArchiveMode.Create))
                {
                    archive.CreateEntryFromFile(DataFilePath, "data.json", CompressionLevel.Optimal);
                    foreach (var image in Directory.EnumerateFiles(ImagePath))
                        archive.CreateEntryFromFile(image, $"images/{Path.GetFileName(image)}", CompressionLevel.Optimal);
                }
                File.Move(temp, destinationZip, true);
            }
            finally
            {
                if (File.Exists(temp)) File.Delete(temp);
            }
        }
    }

    public void RestoreBackup(string sourceZip)
    {
        lock (_gate)
        {
            using (var archive = ZipFile.OpenRead(sourceZip))
            {
                ValidateBackupEntries(archive);
            }

            var stage = Path.Combine(RootPath, ".restore-stage-" + Guid.NewGuid().ToString("N"));
            var oldImages = Path.Combine(RootPath, ".restore-old-images-" + Guid.NewGuid().ToString("N"));
            var failedImages = Path.Combine(RootPath, ".restore-failed-images-" + Guid.NewGuid().ToString("N"));
            var oldData = Path.Combine(RootPath, ".restore-old-data-" + Guid.NewGuid().ToString("N") + ".json");
            Directory.CreateDirectory(stage);
            var oldImagesMoved = false;
            var newImagesMoved = false;
            var oldDataMoved = false;
            var newDataMoved = false;
            var previousState = State;
            try
            {
                ZipFile.ExtractToDirectory(sourceZip, stage);
                var stagedData = Path.Combine(stage, "data.json");
                var stagedImages = Path.Combine(stage, "images");
                Directory.CreateDirectory(stagedImages);
                var parsed = JsonSerializer.Deserialize<AppState>(File.ReadAllText(stagedData), _jsonOptions)
                             ?? throw new InvalidDataException("备份数据无法读取。");
                NormalizeState(parsed);
                foreach (var screenshot in parsed.Screenshots)
                {
                    var fileName = ValidateStoredFileName(screenshot.StoredFileName);
                    var image = Path.Combine(stagedImages, fileName);
                    if (!File.Exists(image)) throw new InvalidDataException($"备份缺少截图文件：{fileName}");
                    if (!string.IsNullOrWhiteSpace(screenshot.Sha256) &&
                        !string.Equals(screenshot.Sha256, ComputeFileSha256(image), StringComparison.OrdinalIgnoreCase))
                        throw new InvalidDataException($"备份中的截图校验失败：{fileName}");
                }
                File.WriteAllText(stagedData, JsonSerializer.Serialize(parsed, _jsonOptions));

                var safetyDirectory = Path.Combine(RootPath, "backups");
                Directory.CreateDirectory(safetyDirectory);
                CreateBackup(Path.Combine(safetyDirectory,
                    $"QuoteVault-恢复前备份-{DateTime.Now:yyyyMMdd-HHmmss}.zip"));

                if (Directory.Exists(ImagePath))
                {
                    Directory.Move(ImagePath, oldImages);
                    oldImagesMoved = true;
                }
                Directory.Move(stagedImages, ImagePath);
                newImagesMoved = true;
                if (File.Exists(DataFilePath))
                {
                    File.Move(DataFilePath, oldData);
                    oldDataMoved = true;
                }
                File.Move(stagedData, DataFilePath);
                newDataMoved = true;
                State = parsed;
                TryDeleteDirectory(ThumbnailPath);
                Directory.CreateDirectory(ThumbnailPath);
                EnsureMissingThumbnails();

                TryDeleteDirectory(oldImages);
                TryDeleteFile(oldData);
            }
            catch
            {
                State = previousState;
                if (oldDataMoved && File.Exists(oldData)) File.Move(oldData, DataFilePath, true);
                else if (newDataMoved && File.Exists(DataFilePath)) File.Delete(DataFilePath);
                if (oldImagesMoved && Directory.Exists(oldImages))
                {
                    if (newImagesMoved && Directory.Exists(ImagePath)) Directory.Move(ImagePath, failedImages);
                    Directory.Move(oldImages, ImagePath);
                }
                else if (newImagesMoved) TryDeleteDirectory(ImagePath);
                throw;
            }
            finally
            {
                TryDeleteDirectory(stage);
                TryDeleteDirectory(oldImages);
                TryDeleteDirectory(failedImages);
                TryDeleteFile(oldData);
            }
        }
    }

    private static void ValidateBackupEntries(ZipArchive archive)
    {
        if (archive.GetEntry("data.json") is null)
            throw new InvalidDataException("备份中没有 data.json。\n请选择由 QuoteVault 创建的备份文件。");
        foreach (var entry in archive.Entries.Where(x => !string.IsNullOrEmpty(x.Name)))
        {
            if (entry.FullName == "data.json") continue;
            if (!entry.FullName.StartsWith("images/", StringComparison.Ordinal) ||
                entry.FullName["images/".Length..].Contains('/') ||
                entry.FullName.Contains('\\'))
                throw new InvalidDataException($"备份中包含无法识别的文件：{entry.FullName}");
            ValidateStoredFileName(entry.Name);
        }
    }

    private static string ComputeFileSha256(string path)
    {
        using var stream = File.OpenRead(path);
        return Convert.ToHexString(SHA256.HashData(stream));
    }

    public int EnsureMissingThumbnails()
    {
        var created = 0;
        foreach (var item in State.Screenshots.ToList())
        {
            var thumbnail = GetThumbnailFile(item);
            if (File.Exists(thumbnail)) continue;
            if (TryCreateThumbnail(item, GetImageFile(item))) created++;
        }
        return created;
    }

    private bool TryCreateThumbnail(ScreenshotItem item, string sourcePath)
    {
        try
        {
            if (!File.Exists(sourcePath)) return false;
            using var source = Image.FromFile(sourcePath);
            const int maxWidth = 560;
            const int maxHeight = 360;
            var scale = Math.Min(1d, Math.Min((double)maxWidth / source.Width, (double)maxHeight / source.Height));
            var width = Math.Max(1, (int)Math.Round(source.Width * scale));
            var height = Math.Max(1, (int)Math.Round(source.Height * scale));
            using var thumbnail = new Bitmap(width, height, PixelFormat.Format24bppRgb);
            using (var graphics = Graphics.FromImage(thumbnail))
            {
                graphics.Clear(Color.FromArgb(16, 17, 15));
                graphics.CompositingQuality = CompositingQuality.HighQuality;
                graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
                graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
                graphics.DrawImage(source, 0, 0, width, height);
            }
            Directory.CreateDirectory(ThumbnailPath);
            var destination = GetThumbnailFile(item);
            var temp = destination + $".tmp-{Guid.NewGuid():N}";
            try
            {
                thumbnail.Save(temp, ImageFormat.Jpeg);
                File.Move(temp, destination, true);
            }
            finally
            {
                TryDeleteFile(temp);
            }
            return true;
        }
        catch
        {
            // 缩略图只是缓存；生成失败时界面会退回原图，不影响收录。
            return false;
        }
    }

    private static void TryDeleteDirectory(string path)
    {
        try
        {
            if (Directory.Exists(path)) Directory.Delete(path, true);
        }
        catch
        {
            // 清理旧目录失败不应破坏已经完成的恢复或掩盖原始异常。
        }
    }

    private static void TryDeleteFile(string path)
    {
        try
        {
            if (File.Exists(path)) File.Delete(path);
        }
        catch
        {
            // 与目录清理相同，残留文件可在下次维护时清理。
        }
    }

    private static void NormalizeState(AppState state)
    {
        var migrateLegacyScreenshots = state.SchemaVersion < 2;
        var migrateOldDefaultHotKey = state.SchemaVersion < 3;
        state.Categories ??= [];
        state.People ??= [];
        state.NicknameMappings ??= [];
        state.Screenshots ??= [];
        state.Settings ??= new AppSettings();
        if (migrateOldDefaultHotKey && state.Settings.HotKeyCtrl && state.Settings.HotKeyAlt &&
            !state.Settings.HotKeyShift && state.Settings.HotKey == Keys.F8)
            state.Settings.HotKey = Keys.Q;
        state.Settings.OcrEngine = state.Settings.OcrEngine == "PaddleOcrV6" ? "PaddleOcrV6" : "None";
        state.Settings.Theme = state.Settings.Theme == "light" ? "light" : "dark";
        state.Settings.SidebarWidth = Math.Clamp(state.Settings.SidebarWidth, 170, 420);
        state.Settings.WorkbenchWidth = Math.Clamp(state.Settings.WorkbenchWidth, 360, 800);
        state.Settings.ScreenshotSort = state.Settings.ScreenshotSort is "newest" or "oldest" or "nameAsc" or "nameDesc"
            ? state.Settings.ScreenshotSort
            : "newest";
        state.Settings.ViewMode = state.Settings.ViewMode == "list" ? "list" : "grid";
        state.Settings.CollapsedTreeNodes ??= [];
        state.Settings.CollapsedTreeNodes = state.Settings.CollapsedTreeNodes
            .Where(x => x == "__ungrouped__" || Guid.TryParse(x, out _)).Distinct().ToList();
        state.Settings.WindowWidth = Math.Clamp(state.Settings.WindowWidth, 1120, 7680);
        state.Settings.WindowHeight = Math.Clamp(state.Settings.WindowHeight, 720, 4320);
        foreach (var category in state.Categories) category.Name ??= "未命名群组";
        foreach (var person in state.People)
        {
            person.DisplayName ??= "未命名成员";
            person.CategoryIds ??= [];
        }
        foreach (var screenshot in state.Screenshots)
        {
            ValidateStoredFileName(screenshot.StoredFileName);
            screenshot.OriginalFileName ??= screenshot.StoredFileName;
            screenshot.OcrRawText ??= string.Empty;
            screenshot.SearchText ??= string.Empty;
            screenshot.OcrEngine ??= string.Empty;
            screenshot.OcrEngineKey = screenshot.OcrEngineKey == "PaddleOcrV6" ||
                                      screenshot.OcrEngine.Contains("Paddle", StringComparison.OrdinalIgnoreCase)
                ? "PaddleOcrV6"
                : "None";
            screenshot.DetectedNicknames ??= [];
            screenshot.IgnoredNicknames ??= [];
            screenshot.PersonIds ??= [];
            screenshot.Messages ??= [];
            screenshot.Keywords ??= [];
            screenshot.Tags ??= [];
            foreach (var message in screenshot.Messages)
            {
                message.Text ??= string.Empty;
                message.DetectedNickname = string.IsNullOrWhiteSpace(message.DetectedNickname)
                    ? null
                    : message.DetectedNickname.Trim();
            }

            // 0.3.x 将图库和消息发言人都保存在 PersonIds 中。升级后只取第一个有效图库，
            // 旧消息与昵称仍保留在 JSON 中，确保升级不会丢失用户数据。
            if (!screenshot.LibraryId.HasValue || !state.People.Any(x => x.Id == screenshot.LibraryId.Value))
                screenshot.LibraryId = migrateLegacyScreenshots &&
                                       screenshot.PersonIds.FirstOrDefault(id => state.People.Any(x => x.Id == id)) is var id && id != Guid.Empty
                    ? id : null;
            if (migrateLegacyScreenshots && string.IsNullOrWhiteSpace(screenshot.SearchText))
                screenshot.SearchText = string.Join(Environment.NewLine,
                    screenshot.Messages.OrderBy(x => x.SortOrder).Select(x => x.Text)
                        .Where(x => !string.IsNullOrWhiteSpace(x))).Trim();
            if (migrateLegacyScreenshots && screenshot.Tags.Count == 0 && screenshot.Keywords.Count > 0)
                screenshot.Tags = screenshot.Keywords.ToList();
            screenshot.PersonIds = screenshot.LibraryId.HasValue ? [screenshot.LibraryId.Value] : [];
            if (!screenshot.DeletedAt.HasValue && !screenshot.NeedsReview && !screenshot.LibraryId.HasValue)
                screenshot.NeedsReview = true;
        }
        state.SchemaVersion = 4;
        if (!state.Settings.HasExplicitOcrChoice)
        {
            state.Settings.OcrEngine = "None";
            state.Settings.HasExplicitOcrChoice = true;
        }
        else if (string.IsNullOrWhiteSpace(state.Settings.OcrEngine))
        {
            state.Settings.OcrEngine = "None";
        }
    }

    private static string ValidateStoredFileName(string? fileName)
    {
        if (string.IsNullOrWhiteSpace(fileName) ||
            !string.Equals(fileName, Path.GetFileName(fileName), StringComparison.Ordinal) ||
            fileName.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
            throw new InvalidDataException("截图索引包含无效的存储文件名。");
        return fileName;
    }

    private static string NormalizeExtension(string extension)
    {
        if (string.IsNullOrWhiteSpace(extension)) return ".png";
        if (!extension.StartsWith('.')) extension = "." + extension;
        var safe = extension.ToLowerInvariant();
        return safe is ".png" or ".jpg" or ".jpeg" or ".bmp" or ".gif" ? safe : ".png";
    }
}
