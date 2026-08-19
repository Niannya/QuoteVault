namespace QuoteVault;

static class Program
{
    [STAThread]
    static int Main(string[] args)
    {
        Console.OutputEncoding = System.Text.Encoding.UTF8;
        Console.InputEncoding = System.Text.Encoding.UTF8;
        if (args.Contains("--self-test", StringComparer.OrdinalIgnoreCase))
            return SelfTest.Run();
        if (args.Length == 2 && args[0].Equals("--paddle-ocr-test", StringComparison.OrdinalIgnoreCase))
            return SelfTest.RunPaddleOcr(args[1]);
        if (args.Contains("--layout-test", StringComparer.OrdinalIgnoreCase))
        {
            ApplicationConfiguration.Initialize();
            return SelfTest.RunLayout();
        }

        try
        {
            ApplicationConfiguration.Initialize();
            var dataRoot = Environment.GetEnvironmentVariable("QUOTEVault_DataRoot");
            Application.Run(string.IsNullOrWhiteSpace(dataRoot)
                ? new MainForm()
                : new MainForm(new AppStore(dataRoot)));
            return 0;
        }
        catch (DataVersionException ex)
        {
            MessageBox.Show(ex.Message, "QuoteVault 数据版本不兼容", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return 2;
        }
        catch (Exception ex)
        {
            var root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "QuoteVault");
            Directory.CreateDirectory(root);
            File.WriteAllText(Path.Combine(root, "crash.log"), ex.ToString());
            MessageBox.Show(ex.Message, "QuoteVault 启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
