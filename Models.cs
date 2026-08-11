using System.Text.Json.Serialization;

namespace QuoteVault;

public sealed class AppState
{
    public int SchemaVersion { get; set; } = 1;
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
    public float OcrConfidence { get; set; }
    public List<string> DetectedNicknames { get; set; } = [];
    public List<string> IgnoredNicknames { get; set; } = [];
    public List<Guid> PersonIds { get; set; } = [];
    public List<MessageItem> Messages { get; set; } = [];
    public List<string> Keywords { get; set; } = [];

    [JsonIgnore]
    public string CorrectedText => string.Join(Environment.NewLine,
        Messages.OrderBy(x => x.SortOrder).Select(x => x.Text).Where(x => !string.IsNullOrWhiteSpace(x)));
}

public sealed class MessageItem
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public int SortOrder { get; set; }
    public Guid? PersonId { get; set; }
    public string Text { get; set; } = string.Empty;
}

public sealed class AppSettings
{
    public bool HotKeyCtrl { get; set; } = true;
    public bool HotKeyAlt { get; set; } = true;
    public bool HotKeyShift { get; set; }
    public Keys HotKey { get; set; } = Keys.F8;
}

public sealed record OcrOutput(string RawText, float Confidence, IReadOnlyList<string> Lines,
    IReadOnlyList<string> NicknameCandidates);
