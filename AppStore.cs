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
            var json = File.ReadAllText(DataFilePath);
            using var document = JsonDocument.Parse(json);
            var sourceVersion = ReadSchemaVersion(document.RootElement);
            ValidateSchemaVersion(sourceVersion);
            var state = JsonSerializer.Deserialize<AppState>(json, _jsonOptions) ?? new AppState();
            NormalizeState(state, sourceVersion);

            if (sourceVersion < AppState.CurrentSchemaVersion)
                UpgradeStoredState(state, sourceVersion);

            return state;
        }
        catch (DataVersionException)
        {
            // 版本不兼容或迁移失败时绝不能把现有索引当作“损坏文件”移走，
            // 也不能用空索引继续运行后在退出时覆盖用户数据。
            throw;
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
            WriteState(State);
        }
    }

    private void WriteState(AppState state)
    {
        Directory.CreateDirectory(RootPath);
        var temp = DataFilePath + ".tmp";
        File.WriteAllText(temp, JsonSerializer.Serialize(state, _jsonOptions));
        File.Move(temp, DataFilePath, true);
    }

    private static int ReadSchemaVersion(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Object) return 0;
        foreach (var property in root.EnumerateObject())
        {
            if (string.Equals(property.Name, nameof(AppState.SchemaVersion), StringComparison.OrdinalIgnoreCase) &&
                property.Value.TryGetInt32(out var version))
                return version;
        }
        return 0;
    }

    private static void ValidateSchemaVersion(int version)
    {
        if (version < AppState.MinimumSupportedSchemaVersion)
            throw new DataVersionException(
                $"当前索引版本为 {version}，此版本只直接支持 0.4.x 及之后的数据。请先使用 QuoteVault 0.4.7 打开旧图库并保存一次，再升级。");
        if (version > AppState.CurrentSchemaVersion)
            throw new DataVersionException(
                $"当前索引版本为 {version}，高于本程序支持的版本 {AppState.CurrentSchemaVersion}。请使用更新版本的 QuoteVault 打开此图库。");
    }

    private void UpgradeStoredState(AppState state, int sourceVersion)
    {
        try
        {
            var backupDirectory = Path.Combine(RootPath, "backups");
            Directory.CreateDirectory(backupDirectory);
            var backup = Path.Combine(backupDirectory,
                $"data-schema-{sourceVersion}-before-{AppState.CurrentSchemaVersion}-{DateTime.Now:yyyyMMdd-HHmmss-fff}.json");
            File.Copy(DataFilePath, backup, false);
            WriteState(state);
        }
        catch (Exception ex)
        {
            throw new DataVersionException("索引升级失败。原 data.json 未被当作损坏文件处理，请先备份数据后再重试。", ex);
        }
    }

    public string GetImageFile(ScreenshotItem item) => Path.Combine(ImagePath, ValidateStoredFileName(item.StoredFileName));
    public string GetThumbnailFile(ScreenshotItem item) =>
        Path.Combine(ThumbnailPath, Path.GetFileNameWithoutExtension(ValidateStoredFileName(item.StoredFileName)) + ".v2.jpg");

    public string GetLegacyThumbnailFile(ScreenshotItem item) =>
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
        var legacyThumbnail = GetLegacyThumbnailFile(item);
        State.Screenshots.Remove(item);
        if (save) Save();
        TryDeleteFile(file);
        TryDeleteFile(thumbnail);
        TryDeleteFile(legacyThumbnail);
    }

    public void PermanentlyDeleteMany(IEnumerable<ScreenshotItem> items)
    {
        var selected = items.Distinct().ToList();
        var files = selected.Select(GetImageFile).ToList();
        var thumbnails = selected.Select(GetThumbnailFile).ToList();
        var legacyThumbnails = selected.Select(GetLegacyThumbnailFile).ToList();
        foreach (var item in selected) State.Screenshots.Remove(item);
        Save();
        foreach (var file in files) TryDeleteFile(file);
        foreach (var thumbnail in thumbnails) TryDeleteFile(thumbnail);
        foreach (var thumbnail in legacyThumbnails) TryDeleteFile(thumbnail);
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
                var stagedJson = File.ReadAllText(stagedData);
                using var stagedDocument = JsonDocument.Parse(stagedJson);
                var stagedVersion = ReadSchemaVersion(stagedDocument.RootElement);
                ValidateSchemaVersion(stagedVersion);
                var parsed = JsonSerializer.Deserialize<AppState>(stagedJson, _jsonOptions)
                             ?? throw new InvalidDataException("备份数据无法读取。");
                NormalizeState(parsed, stagedVersion);
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

        // 新版高质量缩略图全部生成后，再清理 0.5.x 的旧缓存，避免升级首屏直接加载数百张原图。
        foreach (var legacy in Directory.EnumerateFiles(ThumbnailPath, "*.jpg")
                     .Where(path => !path.EndsWith(".v2.jpg", StringComparison.OrdinalIgnoreCase)))
            TryDeleteFile(legacy);
        return created;
    }

    private bool TryCreateThumbnail(ScreenshotItem item, string sourcePath)
    {
        try
        {
            if (!File.Exists(sourcePath)) return false;
            using var source = Image.FromFile(sourcePath);
            const int maxWidth = 960;
            const int maxHeight = 640;
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
                var jpeg = ImageCodecInfo.GetImageEncoders().First(x => x.FormatID == ImageFormat.Jpeg.Guid);
                using var parameters = new EncoderParameters(1);
                parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 92L);
                thumbnail.Save(temp, jpeg, parameters);
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

    private static void NormalizeState(AppState state, int sourceVersion)
    {
        state.Categories ??= [];
        state.People ??= [];
        state.Screenshots ??= [];
        state.Settings ??= new AppSettings();

        state.Settings.OcrEngine = state.Settings.OcrEngine == "PaddleOcrV6" ? "PaddleOcrV6" : "None";
        state.Settings.Theme = state.Settings.Theme == "light" ? "light" : "dark";
        // 0.5.12 将默认全局收录快捷键从 Ctrl+Alt+Q 调整为 Ctrl+Alt+V。
        // 只迁移旧版本中恰好仍使用旧默认组合的设置，其他自定义快捷键保持不变。
        if (sourceVersion < 6 && state.Settings.HotKeyCtrl && state.Settings.HotKeyAlt &&
            !state.Settings.HotKeyShift && state.Settings.HotKey == Keys.Q)
            state.Settings.HotKey = Keys.V;
        state.Settings.SidebarWidth = Math.Clamp(state.Settings.SidebarWidth, 170, 420);
        state.Settings.WorkbenchWidth = Math.Clamp(state.Settings.WorkbenchWidth, 260, 360);
        state.Settings.ScreenshotSort = state.Settings.ScreenshotSort is "newest" or "oldest" or "nameAsc" or "nameDesc"
            ? state.Settings.ScreenshotSort
            : "newest";
        state.Settings.GridDensity = Math.Clamp(state.Settings.GridDensity, 0, 2);
        state.Settings.CollapsedTreeNodes ??= [];
        state.Settings.CollapsedTreeNodes = state.Settings.CollapsedTreeNodes
            .Where(x => x == "__ungrouped__" || Guid.TryParse(x, out _)).Distinct().ToList();
        state.Settings.WindowWidth = Math.Clamp(state.Settings.WindowWidth, 1120, 7680);
        state.Settings.WindowHeight = Math.Clamp(state.Settings.WindowHeight, 720, 4320);

        var categoryIds = state.Categories.Select(x => x.Id).ToHashSet();
        foreach (var category in state.Categories)
        {
            category.Name ??= "未命名群组";
            if (category.ParentId == category.Id ||
                category.ParentId.HasValue && !categoryIds.Contains(category.ParentId.Value))
                category.ParentId = null;
        }

        foreach (var person in state.People)
        {
            person.DisplayName ??= "未命名成员";
            person.QqNumber ??= string.Empty;
            person.Note ??= string.Empty;
            person.AvatarDataUrl ??= string.Empty;
            if (!person.AvatarDataUrl.StartsWith("data:image/png;base64,", StringComparison.OrdinalIgnoreCase))
                person.AvatarDataUrl = string.Empty;
            person.CategoryIds ??= [];
            person.CategoryIds = person.CategoryIds.Where(categoryIds.Contains).Distinct().ToList();
        }

        var libraryIds = state.People.Select(x => x.Id).ToHashSet();
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
            screenshot.Tags ??= [];
            screenshot.Tags = screenshot.Tags
                .Select(x => x?.Trim() ?? string.Empty)
                .Where(x => x.Length > 0)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();

            screenshot.LibraryIds ??= [];
            if (screenshot.LegacyLibraryId.HasValue && libraryIds.Contains(screenshot.LegacyLibraryId.Value) &&
                !screenshot.LibraryIds.Contains(screenshot.LegacyLibraryId.Value))
                screenshot.LibraryIds.Add(screenshot.LegacyLibraryId.Value);
            screenshot.LegacyLibraryId = null;
            screenshot.LibraryIds = screenshot.LibraryIds.Where(libraryIds.Contains).Distinct().ToList();
            if (!screenshot.DeletedAt.HasValue && !screenshot.NeedsReview && screenshot.LibraryIds.Count == 0)
                screenshot.NeedsReview = true;
        }

        state.SchemaVersion = AppState.CurrentSchemaVersion;
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

internal sealed class DataVersionException : Exception
{
    public DataVersionException(string message) : base(message) { }

    public DataVersionException(string message, Exception innerException) : base(message, innerException) { }
}
