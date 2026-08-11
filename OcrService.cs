using System.Text.RegularExpressions;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using TesseractOCR;
using TesseractOCR.Enums;
using PixImage = TesseractOCR.Pix.Image;

namespace QuoteVault;

public sealed partial class OcrService
{
    private readonly string _tessDataPath = Path.Combine(AppContext.BaseDirectory, "tessdata");

    public Task<OcrOutput> RecognizeAsync(string imagePath, CancellationToken cancellationToken = default) =>
        Task.Run(() => Recognize(imagePath, cancellationToken), cancellationToken);

    private OcrOutput Recognize(string imagePath, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var model = Path.Combine(_tessDataPath, "chi_sim.traineddata");
        if (!File.Exists(model)) throw new FileNotFoundException("缺少简体中文 OCR 模型。", model);

        var prepared = PrepareImage(imagePath, out var isCompact);
        string raw;
        float confidence;
        try
        {
            using var engine = new Engine(_tessDataPath,
                new List<Language> { Language.ChineseSimplified, Language.English }, EngineMode.LstmOnly);
            using var image = PixImage.LoadFromFile(prepared);
            using var page = engine.Process(image, isCompact ? PageSegMode.SparseText : PageSegMode.Auto);
            cancellationToken.ThrowIfCancellationRequested();
            raw = NormalizeText(page.Text);
            confidence = page.MeanConfidence;
        }
        finally
        {
            if (!string.Equals(prepared, imagePath, StringComparison.OrdinalIgnoreCase) && File.Exists(prepared)) File.Delete(prepared);
        }
        var rawLines = raw.Split('\n', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
        var (messages, nicknames) = SplitChatLines(rawLines);
        return new OcrOutput(raw, confidence, messages, nicknames);
    }

    private static string PrepareImage(string imagePath, out bool isCompact)
    {
        using var source = System.Drawing.Image.FromFile(imagePath);
        isCompact = source.Height < 420 || source.Width < 720;
        if (!isCompact) return imagePath;
        var scale = source.Height < 180 || source.Width < 480 ? 3 : 2;
        var output = Path.Combine(Path.GetTempPath(), $"QuoteVault-OCR-{Guid.NewGuid():N}.png");
        using var bitmap = new Bitmap(source.Width * scale, source.Height * scale, PixelFormat.Format24bppRgb);
        using var graphics = Graphics.FromImage(bitmap);
        graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
        graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
        graphics.DrawImage(source, 0, 0, bitmap.Width, bitmap.Height);
        bitmap.Save(output, System.Drawing.Imaging.ImageFormat.Png);
        return output;
    }

    internal static (IReadOnlyList<string> Messages, IReadOnlyList<string> Nicknames)
        SplitChatLines(IReadOnlyList<string> lines)
    {
        var messages = new List<string>();
        var nicknames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        for (var index = 0; index < lines.Count; index++)
        {
            var value = lines[index].Trim();
            var prefix = SpeakerPrefixRegex().Match(value);
            if (prefix.Success)
            {
                AddIfPlausible(nicknames, prefix.Groups["name"].Value);
                var separator = value.IndexOfAny([':', '：']);
                if (separator >= 0 && separator + 1 < value.Length)
                    messages.Add(value[(separator + 1)..].Trim());
                continue;
            }

            // QQ 截图常按“昵称行 → 消息气泡”排列。候选昵称必须紧跟一条消息，
            // 因此最后一条气泡文字不会再被误判成昵称。
            if (index + 1 < lines.Count && index % 2 == 0 && IsPlausibleNicknameLine(value))
            {
                AddIfPlausible(nicknames, value);
                continue;
            }
            messages.Add(value);
        }
        if (messages.Count == 0) messages.AddRange(lines.Where(x => !string.IsNullOrWhiteSpace(x)));
        return (messages, nicknames.Take(12).ToArray());
    }

    public static IReadOnlyList<string> ExtractNicknameCandidates(IReadOnlyList<string> lines) =>
        SplitChatLines(lines).Nicknames;

    private static bool IsPlausibleNicknameLine(string value) =>
        value.Length is >= 1 and <= 24 &&
        !SentenceEndingRegex().IsMatch(value) &&
        !SystemMessageRegex().IsMatch(value) &&
        value.Any(char.IsLetterOrDigit);

    private static void AddIfPlausible(HashSet<string> values, string value)
    {
        value = value.Trim(' ', '\t', ':', '：', '&', '@', '#', '·', '•', '|');
        if (value.Length is >= 1 and <= 24) values.Add(value);
    }

    private static string NormalizeText(string text) =>
        text.Replace("\r\n", "\n").Replace('\r', '\n').Trim();

    [GeneratedRegex(@"^(?<name>[^:：]{1,24})\s*[:：]\s*.+$")]
    private static partial Regex SpeakerPrefixRegex();

    [GeneratedRegex(@"[。！？?!；;，,]$")]
    private static partial Regex SentenceEndingRegex();

    [GeneratedRegex(@"(撤回|加入群聊|退出群聊|系统消息|以上为新消息|时间|上午|下午)", RegexOptions.IgnoreCase)]
    private static partial Regex SystemMessageRegex();
}
