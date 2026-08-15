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
        return new OcrOutput(raw, confidence, messages, nicknames, "Tesseract 5");
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
        var currentMessage = new List<string>();

        void FlushMessage()
        {
            if (currentMessage.Count == 0) return;
            messages.Add(string.Join(Environment.NewLine, currentMessage).Trim());
            currentMessage.Clear();
        }

        for (var index = 0; index < lines.Count; index++)
        {
            var value = lines[index].Trim();
            var prefix = SpeakerPrefixRegex().Match(value);
            if (prefix.Success)
            {
                FlushMessage();
                AddIfPlausible(nicknames, prefix.Groups["name"].Value);
                var separator = value.IndexOfAny([':', '：']);
                if (separator >= 0 && separator + 1 < value.Length)
                    currentMessage.Add(value[(separator + 1)..].Trim());
                continue;
            }

            // 只有带 @/#/&、等级或身份标识的强特征行才推断为昵称。
            // 普通短句不再按奇偶行猜测，避免把换行后的消息误判成新昵称。
            if (index + 1 < lines.Count && LooksLikeNicknameHeader(value))
            {
                FlushMessage();
                AddIfPlausible(nicknames, value);
                continue;
            }
            currentMessage.Add(value);
        }
        FlushMessage();
        if (messages.Count == 0 && lines.Any(x => !string.IsNullOrWhiteSpace(x)))
            messages.Add(string.Join(Environment.NewLine, lines.Where(x => !string.IsNullOrWhiteSpace(x))).Trim());
        return (messages, nicknames.Take(12).ToArray());
    }

    public static IReadOnlyList<string> ExtractNicknameCandidates(IReadOnlyList<string> lines) =>
        SplitChatLines(lines).Nicknames;

    private static bool IsPlausibleNicknameLine(string value) =>
        value.Length is >= 1 and <= 24 &&
        !SentenceEndingRegex().IsMatch(value) &&
        !SystemMessageRegex().IsMatch(value) &&
        value.Any(char.IsLetterOrDigit);

    private static bool LooksLikeNicknameHeader(string value) =>
        IsPlausibleNicknameLine(value) && NicknameHeaderRegex().IsMatch(value);

    private static void AddIfPlausible(HashSet<string> values, string value)
    {
        value = value.Trim(' ', '\t', ':', '：', '&', '@', '#', '·', '•', '|');
        if (value.Length is >= 1 and <= 24) values.Add(value);
    }

    private static string NormalizeText(string text) =>
        text.Replace("\r\n", "\n").Replace('\r', '\n').Trim();

    [GeneratedRegex(@"^(?<name>[^:：]{1,24})\s*[:：]\s*.+$")]
    private static partial Regex SpeakerPrefixRegex();

    [GeneratedRegex(@"^\s*[@&#＆]|\bLV\s*\d+|(?:群主|管理员|王者|等级)\s*$", RegexOptions.IgnoreCase)]
    private static partial Regex NicknameHeaderRegex();

    [GeneratedRegex(@"[。！？?!；;，,]$")]
    private static partial Regex SentenceEndingRegex();

    [GeneratedRegex(@"(撤回|加入群聊|退出群聊|系统消息|以上为新消息|时间|上午|下午)", RegexOptions.IgnoreCase)]
    private static partial Regex SystemMessageRegex();
}
