using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;

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
    public string DataFilePath { get; }
    public AppState State { get; private set; }

    public AppStore(string? rootPath = null)
    {
        RootPath = rootPath ?? Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "QuoteVault");
        ImagePath = Path.Combine(RootPath, "images");
        DataFilePath = Path.Combine(RootPath, "data.json");
        Directory.CreateDirectory(ImagePath);
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
        catch
        {
            var broken = DataFilePath + $".broken-{DateTime.Now:yyyyMMdd-HHmmss}";
            File.Copy(DataFilePath, broken, true);
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

    public static string ComputeSha256(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes));

    public ScreenshotItem? FindDuplicate(string hash) =>
        State.Screenshots.FirstOrDefault(x => string.Equals(x.Sha256, hash, StringComparison.OrdinalIgnoreCase));

    public ScreenshotItem AddImage(byte[] bytes, string originalName, string extension)
    {
        extension = NormalizeExtension(extension);
        var item = new ScreenshotItem
        {
            StoredFileName = $"{Guid.NewGuid():N}{extension}",
            OriginalFileName = string.IsNullOrWhiteSpace(originalName) ? "剪贴板图片.png" : originalName,
            Sha256 = ComputeSha256(bytes)
        };
        File.WriteAllBytes(GetImageFile(item), bytes);
        State.Screenshots.Add(item);
        Save();
        return item;
    }

    public void MoveToTrash(ScreenshotItem item)
    {
        item.DeletedAt = DateTimeOffset.Now;
        Save();
    }

    public void RestoreFromTrash(ScreenshotItem item)
    {
        item.DeletedAt = null;
        Save();
    }

    public void PermanentlyDelete(ScreenshotItem item)
    {
        var file = GetImageFile(item);
        if (File.Exists(file)) File.Delete(file);
        State.Screenshots.Remove(item);
        Save();
    }

    public void CreateBackup(string destinationZip)
    {
        Save();
        var temp = destinationZip + ".tmp";
        if (File.Exists(temp)) File.Delete(temp);
        using (var file = File.Create(temp))
        using (var archive = new ZipArchive(file, ZipArchiveMode.Create))
        {
            archive.CreateEntryFromFile(DataFilePath, "data.json", CompressionLevel.Optimal);
            foreach (var image in Directory.EnumerateFiles(ImagePath))
                archive.CreateEntryFromFile(image, $"images/{Path.GetFileName(image)}", CompressionLevel.Optimal);
        }
        File.Move(temp, destinationZip, true);
    }

    public void RestoreBackup(string sourceZip)
    {
        using var archive = ZipFile.OpenRead(sourceZip);
        if (archive.GetEntry("data.json") is null)
            throw new InvalidDataException("备份中没有 data.json。\n请选择由 QuoteVault 创建的备份文件。");

        var safetyDirectory = Path.Combine(RootPath, "backups");
        Directory.CreateDirectory(safetyDirectory);
        var safety = Path.Combine(safetyDirectory,
            $"QuoteVault-恢复前备份-{DateTime.Now:yyyyMMdd-HHmmss}.zip");
        CreateBackup(safety);

        var extract = Path.Combine(Path.GetTempPath(), "QuoteVaultRestore-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(extract);
        try
        {
            ZipFile.ExtractToDirectory(sourceZip, extract);
            var extractedState = Path.Combine(extract, "data.json");
            var parsed = JsonSerializer.Deserialize<AppState>(File.ReadAllText(extractedState), _jsonOptions)
                         ?? throw new InvalidDataException("备份数据无法读取。");
            NormalizeState(parsed);

            Directory.CreateDirectory(ImagePath);
            var extractedImages = Path.Combine(extract, "images");
            foreach (var screenshot in parsed.Screenshots)
            {
                var fileName = ValidateStoredFileName(screenshot.StoredFileName);
                if (!File.Exists(Path.Combine(extractedImages, fileName)))
                    throw new InvalidDataException($"备份缺少截图文件：{fileName}");
            }
            foreach (var current in Directory.EnumerateFiles(ImagePath)) File.Delete(current);
            if (Directory.Exists(extractedImages))
            {
                foreach (var source in Directory.EnumerateFiles(extractedImages))
                    File.Copy(source, Path.Combine(ImagePath, Path.GetFileName(source)), true);
            }
            State = parsed;
            Save();
        }
        finally
        {
            try
            {
                if (Directory.Exists(extract)) Directory.Delete(extract, true);
            }
            catch
            {
                // 临时目录清理失败不应把已经完成的恢复报告为失败。
            }
        }
    }

    private static void NormalizeState(AppState state)
    {
        state.Categories ??= [];
        state.People ??= [];
        state.NicknameMappings ??= [];
        state.Screenshots ??= [];
        state.Settings ??= new AppSettings();
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
            screenshot.OcrEngine ??= string.Empty;
            screenshot.DetectedNicknames ??= [];
            screenshot.IgnoredNicknames ??= [];
            screenshot.PersonIds ??= [];
            screenshot.Messages ??= [];
            screenshot.Keywords ??= [];
            foreach (var message in screenshot.Messages) message.Text ??= string.Empty;
        }
        state.Settings.OcrEngine = string.IsNullOrWhiteSpace(state.Settings.OcrEngine)
            ? "PaddleOcrV6"
            : state.Settings.OcrEngine;
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
