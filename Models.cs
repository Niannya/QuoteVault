using System.Text.Json.Serialization;

namespace QuoteVault;

public sealed class AppState
{
    public int SchemaVersion { get; set; } = 2;
    public List<CategoryItem> Categories { get; set; } = [];
    public List<PersonItem> People { get; set; } = [];
    public List<NicknameMapping> NicknameMappings { get; set; } = [];
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
    public string DisplayName { get; set; } = "新成员";
    public List<Guid> CategoryIds { get; set; } = [];
}

public sealed class NicknameMapping
{
    public string Nickname { get; set; } = string.Empty;
    public Guid PersonId { get; set; }
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
    public string OcrRawText { get; set; } = string.Empty;
    public string SearchText { get; set; } = string.Empty;
    public float OcrConfidence { get; set; }
    public string OcrEngine { get; set; } = string.Empty;
    public string OcrEngineKey { get; set; } = "None";
    public Guid? LibraryId { get; set; }
    public List<string> Tags { get; set; } = [];

    // 以下字段只用于兼容旧版数据。新版不再建立截图、消息和成员之间的语义关联。
    public List<string> DetectedNicknames { get; set; } = [];
    public List<string> IgnoredNicknames { get; set; } = [];
    public List<Guid> PersonIds { get; set; } = [];
    public List<MessageItem> Messages { get; set; } = [];
    public List<string> Keywords { get; set; } = [];

    [JsonIgnore]
    public string CorrectedText => SearchText;
}

public sealed class MessageItem
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public int SortOrder { get; set; }
    public Guid? PersonId { get; set; }
    public string? DetectedNickname { get; set; }
    public string Text { get; set; } = string.Empty;
}

public sealed class AppSettings
{
    public bool HotKeyCtrl { get; set; } = true;
    public bool HotKeyAlt { get; set; } = true;
    public bool HotKeyShift { get; set; }
    public Keys HotKey { get; set; } = Keys.F8;
    public string OcrEngine { get; set; } = "None";
    public bool HasExplicitOcrChoice { get; set; }
}

public sealed record OcrOutput(string RawText, float Confidence, IReadOnlyList<string> Lines,
    IReadOnlyList<string> NicknameCandidates, string Engine = "Tesseract",
    IReadOnlyList<string?>? SpeakerNicknames = null);
