using System.IO.Compression;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace QuoteVault;

internal static class SelfTest
{
    public static int RunLayout()
    {
        var root = Path.Combine(Path.GetTempPath(), "QuoteVaultLayout-" + Guid.NewGuid().ToString("N"));
        using (var form = new MainForm(new AppStore(root)))
        {
            form.Show();
            Application.DoEvents();
            Dump(form, 0);
            form.Close();
            Application.DoEvents();
        }
        DeleteDirectoryWithRetry(root);
        return 0;
    }

    private static void Dump(Control control, int depth)
    {
        var text = control.Text.Replace(Environment.NewLine, " ");
        if (text.Length > 30) text = text[..30];
        Console.WriteLine($"{new string(' ', depth * 2)}{control.GetType().Name} {control.Bounds} Dock={control.Dock} Text={text}");
        foreach (Control child in control.Controls) Dump(child, depth + 1);
    }

    public static int RunPaddleOcr(string imagePath)
    {
        try
        {
            using var service = new PaddleOcrService();
            var result = service.RecognizeAsync(imagePath).GetAwaiter().GetResult();
            Console.WriteLine($"ENGINE={result.Engine}");
            Console.WriteLine($"CONFIDENCE={result.Confidence:P0}");
            Console.WriteLine("RAW TEXT:");
            Console.WriteLine(result.RawText);
            Console.WriteLine("SEARCHABLE TEXT:");
            Console.WriteLine(string.Join(Environment.NewLine, result.Lines));
            return string.IsNullOrWhiteSpace(result.RawText) ? 1 : 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex);
            return 1;
        }
    }

    public static int Run()
    {
        var root = Path.Combine(Path.GetTempPath(), "QuoteVaultSelfTest-" + Guid.NewGuid().ToString("N"));
        var backupRoot = Path.Combine(Path.GetTempPath(), "QuoteVaultBackupTest-" + Guid.NewGuid().ToString("N"));
        var corruptRoot = Path.Combine(Path.GetTempPath(), "QuoteVaultCorruptTest-" + Guid.NewGuid().ToString("N"));
        var unsupportedRoot = Path.Combine(Path.GetTempPath(), "QuoteVaultUnsupportedTest-" + Guid.NewGuid().ToString("N"));
        try
        {
            var store = new AppStore(root);
            Assert(store.State.Settings.OcrEngine == "None", "新图库默认不启用 OCR");
            Assert(store.State.Settings.Theme == "dark", "新图库默认使用深色主题");
            Assert(store.State.Settings.HotKeyCtrl && store.State.Settings.HotKeyAlt &&
                   store.State.Settings.HotKey == Keys.V, "新图库使用 Ctrl+Alt+V 默认快捷键");
            Assert(store.State.Settings.SidebarWidth == AppSettings.DefaultSidebarWidth, "左侧栏使用默认宽度");
            Assert(store.State.Settings.WorkbenchWidth == AppSettings.DefaultWorkbenchWidth, "工作区使用默认宽度");
            Assert(store.State.Settings.GridDensity == 1, "新图库使用默认缩略图密度");
            Assert(!store.State.Settings.SidebarHidden, "新图库默认显示左侧图库");
            Assert(store.State.Settings.WindowWidth == 1280 && store.State.Settings.WindowHeight == 800,
                "新窗口默认使用窗口化尺寸");
            store.State.Settings.SidebarWidth = 312;
            store.State.Settings.WorkbenchWidth = 348;
            store.State.Settings.ScreenshotSort = "nameAsc";
            store.State.Settings.GridDensity = 2;
            store.State.Settings.FavoritesFirst = true;
            store.State.Settings.SidebarHidden = true;
            store.State.Settings.Theme = "light";
            store.State.Settings.CollapsedTreeNodes = ["__ungrouped__"];
            store.State.Settings.HasWindowPlacement = true;
            store.State.Settings.WindowX = 120;
            store.State.Settings.WindowY = 80;
            store.State.Settings.WindowWidth = 1280;
            store.State.Settings.WindowHeight = 800;
            store.State.Settings.WindowMaximized = true;
            var category = new CategoryItem { Name = "大学" };
            var person = new PersonItem { DisplayName = "player-001", QqNumber = "12345678", Note = "大学同学", AvatarDataUrl = "data:image/png;base64,AA==", CategoryIds = [category.Id] };
            store.State.Categories.Add(category);
            store.State.People.Add(person);
            byte[] image;
            using (var bitmap = new Bitmap(12, 8))
            using (var stream = new MemoryStream())
            {
                using (var graphics = Graphics.FromImage(bitmap)) graphics.Clear(Color.DarkSlateBlue);
                bitmap.Save(stream, System.Drawing.Imaging.ImageFormat.Png);
                image = stream.ToArray();
            }
            var screenshot = store.AddImage(image, "test.png", ".png");
            Assert(File.Exists(store.GetThumbnailFile(screenshot)), "导入时生成缩略图缓存");
            screenshot.LegacyLibraryId = person.Id;
            screenshot.SearchText = "今晚打游戏吗？";
            screenshot.Tags = ["名场面"];
            screenshot.IsFavorite = true;
            screenshot.NeedsReview = false;
            store.State.Settings.OcrEngine = "Tesseract";
            store.State.Settings.HotKeyCtrl = true;
            store.State.Settings.HotKeyAlt = true;
            store.State.Settings.HotKeyShift = false;
            store.State.Settings.HotKey = Keys.Q;
            store.State.SchemaVersion = 4;
            store.Save();

            // 模拟 0.4.x 索引里仍残留的早期字段。0.5.0 应保留当前数据，
            // 在升级前备份原索引，并在重写 data.json 时彻底去掉未知旧字段。
            var legacyJson = JsonNode.Parse(File.ReadAllText(store.DataFilePath))!.AsObject();
            legacyJson["NicknameMappings"] = JsonNode.Parse(
                $"[{{\"Nickname\":\"旧昵称\",\"PersonId\":\"{person.Id}\"}}]");
            legacyJson["People"]!.AsArray()[0]!.AsObject()["ExternalId"] = "旧的重复 ID 字段";
            var legacyScreenshot = legacyJson["Screenshots"]!.AsArray()[0]!.AsObject();
            legacyScreenshot["PersonIds"] = JsonNode.Parse($"[\"{person.Id}\"]");
            legacyScreenshot["Messages"] = JsonNode.Parse(
                "[{\"SortOrder\":0,\"Text\":\"旧消息字段\"}]");
            legacyScreenshot["Keywords"] = JsonNode.Parse("[\"旧关键词\"]");
            File.WriteAllText(store.DataFilePath,
                legacyJson.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));

            var reloaded = new AppStore(root);
            Assert(reloaded.State.People.Count == 1, "成员图库持久化");
            Assert(reloaded.State.People.Single().DisplayName == "player-001" &&
                   reloaded.State.People.Single().QqNumber == "12345678" &&
                   reloaded.State.People.Single().Note == "大学同学" &&
                   reloaded.State.People.Single().AvatarDataUrl == "data:image/png;base64,AA==", "成员资料持久化");
            Assert(reloaded.State.Settings.SidebarWidth == 312 && reloaded.State.Settings.WorkbenchWidth == 348,
                "自定义布局持久化");
            Assert(reloaded.State.Settings.ScreenshotSort == "nameAsc", "截图排序方式持久化");
            Assert(reloaded.State.Settings.GridDensity == 2 &&
                   reloaded.State.Settings.CollapsedTreeNodes.SequenceEqual(["__ungrouped__"]) &&
                   reloaded.State.Settings.FavoritesFirst && reloaded.State.Settings.SidebarHidden,
                "网格密度、树状态、收藏优先与侧栏隐藏状态持久化");
            Assert(reloaded.State.Settings.Theme == "light", "界面主题持久化");
            Assert(reloaded.State.Settings.HasWindowPlacement && reloaded.State.Settings.WindowWidth == 1280 &&
                   reloaded.State.Settings.WindowMaximized, "窗口位置与最大化状态持久化");
            Assert(reloaded.State.SchemaVersion == AppState.CurrentSchemaVersion, "0.4.x 索引升级到当前结构");
            Assert(reloaded.State.Settings.OcrEngine == "None", "无效 OCR 设置归一化为不使用 OCR");
            Assert(reloaded.State.Settings.HotKey == Keys.V, "旧默认快捷键迁移为 Ctrl+Alt+V");
            Assert(reloaded.State.Screenshots.Single().LibraryIds.SequenceEqual([person.Id]), "单图库关系迁移为多图库关系");
            Assert(reloaded.State.Screenshots.Single().SearchText == "今晚打游戏吗？", "可搜索文本在升级后保留");
            Assert(reloaded.State.Screenshots.Single().Tags.SequenceEqual(["名场面"]), "标签在升级后保留");
            Assert(reloaded.State.Screenshots.Single().IsFavorite, "收藏状态持久化");
            Assert(Directory.EnumerateFiles(Path.Combine(root, "backups"), "data-schema-4-before-9-*.json").Any(),
                "升级前自动保留索引副本");
            var cleanedJson = File.ReadAllText(reloaded.DataFilePath);
            Assert(!cleanedJson.Contains("NicknameMappings", StringComparison.Ordinal) &&
                   !cleanedJson.Contains("ExternalId", StringComparison.Ordinal) &&
                   !cleanedJson.Contains("PersonIds", StringComparison.Ordinal) &&
                   !cleanedJson.Contains("Messages", StringComparison.Ordinal) &&
                   !cleanedJson.Contains("Keywords", StringComparison.Ordinal) &&
                   !cleanedJson.Contains("\"LibraryId\":", StringComparison.Ordinal),
                "升级后不再写入旧人物、消息和单图库字段");
            Assert(reloaded.FindDuplicate(AppStore.ComputeSha256(image)) is not null, "重复图片检测");
            reloaded.State.Screenshots.Single().SearchText = string.Empty;
            reloaded.Save();
            Assert(new AppStore(root).State.Screenshots.Single().SearchText == string.Empty, "允许清空可搜索文本");

            var secondPerson = new PersonItem { DisplayName = "player-002" };
            reloaded.State.People.Add(secondPerson);
            reloaded.State.Screenshots.Single().LibraryIds.Add(secondPerson.Id);
            reloaded.Save();
            var multiLibraryReloaded = new AppStore(root);
            Assert(multiLibraryReloaded.State.Screenshots.Single().LibraryIds.Count == 2 &&
                   multiLibraryReloaded.State.Screenshots.Single().LibraryIds.Contains(person.Id) &&
                   multiLibraryReloaded.State.Screenshots.Single().LibraryIds.Contains(secondPerson.Id),
                "同一截图可以同时属于多个图库");
            multiLibraryReloaded.State.Screenshots.Single().LibraryIds.Remove(secondPerson.Id);
            Assert(multiLibraryReloaded.State.Screenshots.Single().LibraryIds.SequenceEqual([person.Id]),
                "从一个图库移除截图不会影响其他图库关系");
            multiLibraryReloaded.State.People.RemoveAll(x => x.Id == secondPerson.Id);
            multiLibraryReloaded.Save();
            store = multiLibraryReloaded;

            Directory.CreateDirectory(unsupportedRoot);
            File.WriteAllText(Path.Combine(unsupportedRoot, "data.json"), "{\"SchemaVersion\":3}");
            AssertThrows<DataVersionException>(() => _ = new AppStore(unsupportedRoot),
                "0.3.x 及更早索引会被明确拒绝");
            Assert(File.Exists(Path.Combine(unsupportedRoot, "data.json")) &&
                   !Directory.EnumerateFiles(unsupportedRoot, "data.json.broken-*").Any(),
                "不支持的旧索引保持原位且不会被当作损坏文件");

            Directory.CreateDirectory(backupRoot);
            var backup = Path.Combine(backupRoot, "backup.zip");
            store.CreateBackup(backup);
            Assert(File.Exists(backup), "备份创建");
            store.State.People.Clear();
            store.Save();
            store.RestoreBackup(backup);
            Assert(store.State.People.Count == 1, "备份恢复");
            Assert(File.Exists(store.GetThumbnailFile(store.State.Screenshots.Single())), "恢复后重建缩略图缓存");
            Assert(Directory.EnumerateFiles(Path.Combine(root, "backups"), "*.zip").Any(), "恢复前安全备份");
            var invalidBackup = Path.Combine(backupRoot, "missing-image.zip");
            File.Copy(backup, invalidBackup);
            using (var archive = ZipFile.Open(invalidBackup, ZipArchiveMode.Update))
                archive.Entries.First(x => x.FullName.StartsWith("images/", StringComparison.Ordinal)).Delete();
            var beforeFailedRestore = store.State.People.Single().DisplayName;
            AssertThrows<InvalidDataException>(() => store.RestoreBackup(invalidBackup), "缺少图片的备份会被拒绝");
            Assert(store.State.People.Single().DisplayName == beforeFailedRestore &&
                   File.Exists(store.GetImageFile(store.State.Screenshots.Single())), "无效备份不会改变当前图库");

            Directory.CreateDirectory(corruptRoot);
            File.WriteAllText(Path.Combine(corruptRoot, "data.json"), "{not-json");
            var recovered = new AppStore(corruptRoot);
            Assert(!string.IsNullOrWhiteSpace(recovered.LoadWarning), "索引损坏会产生明确警告");
            Assert(Directory.EnumerateFiles(corruptRoot, "data.json.broken-*").Any(), "损坏索引会保留副本");
            AssertThrows<InvalidDataException>(() =>
                store.GetImageFile(new ScreenshotItem { StoredFileName = "../escape.png" }), "截图文件名路径校验");
            Console.WriteLine("SELF-TEST PASSED");
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("SELF-TEST FAILED: " + ex);
            return 1;
        }
        finally
        {
            DeleteDirectoryWithRetry(root);
            DeleteDirectoryWithRetry(backupRoot);
            DeleteDirectoryWithRetry(corruptRoot);
            DeleteDirectoryWithRetry(unsupportedRoot);
        }
    }

    private static void Assert(bool condition, string name)
    {
        if (!condition) throw new InvalidOperationException("断言失败：" + name);
    }

    private static void AssertThrows<TException>(Action action, string name) where TException : Exception
    {
        try
        {
            action();
        }
        catch (TException)
        {
            return;
        }
        throw new InvalidOperationException("断言失败：" + name);
    }

    private static void DeleteDirectoryWithRetry(string path)
    {
        for (var attempt = 0; attempt < 8 && Directory.Exists(path); attempt++)
        {
            try
            {
                Directory.Delete(path, true);
            }
            catch (IOException) when (attempt < 7)
            {
                Thread.Sleep(150);
            }
            catch (UnauthorizedAccessException) when (attempt < 7)
            {
                Thread.Sleep(150);
            }
        }
    }
}
