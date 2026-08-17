using System.IO.Compression;

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
        try
        {
            var store = new AppStore(root);
            Assert(store.State.Settings.OcrEngine == "None", "新图库默认不启用 OCR");
            Assert(store.State.Settings.Theme == "dark", "新图库默认使用深色主题");
            Assert(store.State.Settings.HotKeyCtrl && store.State.Settings.HotKeyAlt &&
                   store.State.Settings.HotKey == Keys.Q, "新图库使用 Ctrl+Alt+Q 默认快捷键");
            Assert(store.State.Settings.SidebarWidth == AppSettings.DefaultSidebarWidth, "左侧栏使用默认宽度");
            Assert(store.State.Settings.WorkbenchWidth == AppSettings.DefaultWorkbenchWidth, "工作区使用默认宽度");
            store.State.Settings.SidebarWidth = 312;
            store.State.Settings.WorkbenchWidth = 688;
            store.State.Settings.ScreenshotSort = "nameAsc";
            store.State.Settings.ViewMode = "list";
            store.State.Settings.Theme = "light";
            store.State.Settings.CollapsedTreeNodes = ["__ungrouped__"];
            store.State.Settings.HasWindowPlacement = true;
            store.State.Settings.WindowX = 120;
            store.State.Settings.WindowY = 80;
            store.State.Settings.WindowWidth = 1280;
            store.State.Settings.WindowHeight = 800;
            var category = new CategoryItem { Name = "大学" };
            var person = new PersonItem { DisplayName = "小明", CategoryIds = [category.Id] };
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
            // 模拟 0.3.x 数据，验证启动时会迁移成“单一图库 + 可搜索文本 + 标签”。
            screenshot.PersonIds.Add(person.Id);
            screenshot.Messages.Add(new MessageItem
            {
                SortOrder = 0,
                Text = "今晚打游戏吗？"
            });
            screenshot.Keywords.Add("名场面");
            screenshot.NeedsReview = false;
            store.State.Settings.HotKeyCtrl = true;
            store.State.Settings.HotKeyAlt = true;
            store.State.Settings.HotKeyShift = false;
            store.State.Settings.HotKey = Keys.F8;
            store.State.Settings.OcrEngine = "Tesseract";
            store.State.SchemaVersion = 1;
            store.Save();

            var reloaded = new AppStore(root);
            Assert(reloaded.State.People.Count == 1, "群友持久化");
            Assert(reloaded.State.Settings.SidebarWidth == 312 && reloaded.State.Settings.WorkbenchWidth == 688,
                "自定义布局持久化");
            Assert(reloaded.State.Settings.ScreenshotSort == "nameAsc", "截图排序方式持久化");
            Assert(reloaded.State.Settings.ViewMode == "list" &&
                   reloaded.State.Settings.CollapsedTreeNodes.SequenceEqual(["__ungrouped__"]), "视图偏好持久化");
            Assert(reloaded.State.Settings.Theme == "light", "界面主题持久化");
            Assert(reloaded.State.Settings.HasWindowPlacement && reloaded.State.Settings.WindowWidth == 1280,
                "窗口位置持久化");
            Assert(reloaded.State.SchemaVersion == 4, "数据升级到新版结构");
            Assert(reloaded.State.Settings.HotKey == Keys.Q, "旧版默认快捷键迁移为 Ctrl+Alt+Q");
            Assert(reloaded.State.Settings.OcrEngine == "None", "旧版 Tesseract 设置迁移为不使用 OCR");
            Assert(reloaded.State.Screenshots.Single().LibraryId == person.Id, "旧图库关系迁移");
            Assert(reloaded.State.Screenshots.Single().SearchText == "今晚打游戏吗？", "旧消息迁移为可搜索文本");
            Assert(reloaded.State.Screenshots.Single().Tags.SequenceEqual(["名场面"]), "旧关键词迁移为标签");
            Assert(reloaded.FindDuplicate(AppStore.ComputeSha256(image)) is not null, "重复图片检测");
            reloaded.State.Screenshots.Single().SearchText = string.Empty;
            reloaded.Save();
            Assert(new AppStore(root).State.Screenshots.Single().SearchText == string.Empty, "允许清空可搜索文本");

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
