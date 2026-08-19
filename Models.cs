using System.Text.Json.Serialization;

namespace QuoteVault;

public sealed class AppState
{
    public const int CurrentSchemaVersion = 9;
    public const int MinimumSupportedSchemaVersion = 4;

    public int SchemaVersion { get; set; } = CurrentSchemaVersion;
    public List<CategoryItem> Categories { get; set; } = [];
    public List<PersonItem> People { get; set; } = [];
    public List<ScreenshotItem> Screenshots { get; set; } = [];
    public AppSettings Settings { get; set; } = new();
}

public sealed class CategoryItem
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid? ParentId { get; set; }
    public string Name { get; set; } = "新群组";
}

public sealed class PersonItem
{
    public Guid Id { get; set; } = Guid.NewGuid();
    // UI 中称为“ID”。保留 DisplayName 这个 JSON 字段名，避免无意义地重写现有索引。
    public string DisplayName { get; set; } = "新成员";
    public string QqNumber { get; set; } = string.Empty;
    public string Note { get; set; } = string.Empty;
    public string AvatarDataUrl { get; set; } = string.Empty;
    public List<Guid> CategoryIds { get; set; } = [];
}

public sealed class ScreenshotItem
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public string StoredFileName { get; set; } = string.Empty;
    public string OriginalFileName { get; set; } = string.Empty;
    public string Sha256 { get; set; } = string.Empty;
    public DateTimeOffset ImportedAt { get; set; } = DateTimeOffset.Now;
    public DateTimeOffset? DeletedAt { get; set; }
    public bool NeedsReview { get; set; } = true;
    // 原始 OCR 输出只用于排查识别问题；搜索和人工编辑始终使用 SearchText。
    public string OcrRawText { get; set; } = string.Empty;
    public string SearchText { get; set; } = string.Empty;
    public float OcrConfidence { get; set; }
    public string OcrEngine { get; set; } = string.Empty;
    public string OcrEngineKey { get; set; } = "None";
    public List<Guid> LibraryIds { get; set; } = [];
    public List<string> Tags { get; set; } = [];
    public bool IsFavorite { get; set; }

    // 仅用于把 0.5.x 的单图库关系迁移到 LibraryIds。迁移完成后会清空并停止写入 JSON。
    [JsonPropertyName("LibraryId")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public Guid? LegacyLibraryId { get; set; }
}

public sealed class AppSettings
{
    public const int DefaultSidebarWidth = 230;
    public const int DefaultWorkbenchWidth = 340;
    public const int DefaultWindowWidth = 1280;
    public const int DefaultWindowHeight = 800;

    public bool HotKeyCtrl { get; set; } = true;
    public bool HotKeyAlt { get; set; } = true;
    public bool HotKeyShift { get; set; }
    public Keys HotKey { get; set; } = Keys.V;
    public string OcrEngine { get; set; } = "None";
    public string Theme { get; set; } = "dark";
    public int SidebarWidth { get; set; } = DefaultSidebarWidth;
    public int WorkbenchWidth { get; set; } = DefaultWorkbenchWidth;
    public string ScreenshotSort { get; set; } = "newest";
    public int GridDensity { get; set; } = 1;
    public bool FavoritesFirst { get; set; }
    public bool SidebarHidden { get; set; }
    public List<string> CollapsedTreeNodes { get; set; } = [];
    public bool HasWindowPlacement { get; set; }
    public int WindowX { get; set; }
    public int WindowY { get; set; }
    public int WindowWidth { get; set; } = DefaultWindowWidth;
    public int WindowHeight { get; set; } = DefaultWindowHeight;
    public bool WindowMaximized { get; set; }
}

public sealed record OcrOutput(
    string RawText,
    float Confidence,
    IReadOnlyList<string> Lines,
    string Engine = "未使用 OCR");
