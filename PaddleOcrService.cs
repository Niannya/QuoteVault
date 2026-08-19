using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace QuoteVault;

public sealed class PaddleOcrService : IDisposable
{
    private const string ResultPrefix = "QUOTEVault_RESULT:";
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly StringBuilder _diagnostics = new();
    private Process? _worker;

    public string PythonPath { get; }
    public string RuntimePath { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "QuoteVault", "paddle-runtime");
    public string WorkerPath { get; } = Path.Combine(AppContext.BaseDirectory, "paddleocr", "paddle_worker.py");
    public string ModelsPath { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "QuoteVault", "paddle-models");
    public bool IsAvailable => File.Exists(PythonPath) && File.Exists(WorkerPath);
    public bool IsFullyInstalled => IsAvailable &&
                                    File.Exists(Path.Combine(ModelsPath, "official_models", "PP-OCRv6_medium_det", "inference.pdiparams")) &&
                                    File.Exists(Path.Combine(ModelsPath, "official_models", "PP-OCRv6_medium_rec", "inference.pdiparams"));

    public PaddleOcrService()
    {
        PythonPath = Environment.GetEnvironmentVariable("QUOTEVault_PaddlePython")
                     ?? Path.Combine(RuntimePath, "Scripts", "python.exe");
    }

    public async Task<OcrOutput> RecognizeAsync(string imagePath, CancellationToken cancellationToken = default)
    {
        if (!IsAvailable)
            throw new InvalidOperationException("PaddleOCR 运行环境尚未安装。请先按 QuoteVault GitHub 页面中的安装指南完成安装。");
        if (!File.Exists(imagePath)) throw new FileNotFoundException("找不到待识别图片。", imagePath);

        await _gate.WaitAsync(cancellationToken);
        try
        {
            EnsureWorker();
            var requestId = Guid.NewGuid().ToString("N");
            var request = JsonSerializer.Serialize(new { id = requestId, imagePath });
            await _worker!.StandardInput.WriteLineAsync(request.AsMemory(), cancellationToken);
            await _worker.StandardInput.FlushAsync(cancellationToken);

            while (true)
            {
                var line = await _worker.StandardOutput.ReadLineAsync(cancellationToken);
                if (line is null)
                    throw new InvalidOperationException("PaddleOCR 工作进程意外退出。" + DiagnosticSuffix());
                if (!line.StartsWith(ResultPrefix, StringComparison.Ordinal)) continue;
                using var document = JsonDocument.Parse(line[ResultPrefix.Length..]);
                var root = document.RootElement;
                if (!string.Equals(root.GetProperty("id").GetString(), requestId, StringComparison.Ordinal)) continue;
                if (!root.GetProperty("ok").GetBoolean())
                    throw new InvalidOperationException(root.GetProperty("error").GetString() + DiagnosticSuffix());
                var output = root.GetProperty("output");
                var messages = output.GetProperty("messages").EnumerateArray()
                    .Select(x => x.GetString() ?? string.Empty).ToArray();
                return new OcrOutput(
                    output.GetProperty("rawText").GetString() ?? string.Empty,
                    output.GetProperty("confidence").GetSingle(),
                    messages,
                    output.GetProperty("engine").GetString() ?? "PaddleOCR v6 medium");
            }
        }
        catch (OperationCanceledException)
        {
            StopWorker();
            throw;
        }
        finally
        {
            _gate.Release();
        }
    }

    private void EnsureWorker()
    {
        if (_worker is { HasExited: false }) return;
        StopWorker();
        _diagnostics.Clear();
        var startInfo = new ProcessStartInfo(PythonPath, $"-u \"{WorkerPath}\"")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardInputEncoding = new UTF8Encoding(false),
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8
        };
        startInfo.Environment["PYTHONUTF8"] = "1";
        startInfo.Environment["PADDLE_PDX_CACHE_HOME"] = ModelsPath;
        startInfo.Environment["PADDLE_PDX_MODEL_SOURCE"] = "BOS";
        _worker = Process.Start(startInfo) ?? throw new InvalidOperationException("无法启动 PaddleOCR 工作进程。");
        _worker.ErrorDataReceived += (_, args) =>
        {
            if (string.IsNullOrWhiteSpace(args.Data)) return;
            lock (_diagnostics)
            {
                if (_diagnostics.Length > 4000) _diagnostics.Remove(0, _diagnostics.Length - 3000);
                _diagnostics.AppendLine(args.Data);
            }
        };
        _worker.BeginErrorReadLine();
    }

    private string DiagnosticSuffix()
    {
        lock (_diagnostics)
        {
            return _diagnostics.Length == 0 ? string.Empty : $"\n\n诊断信息：\n{_diagnostics}";
        }
    }

    private void StopWorker()
    {
        if (_worker is null) return;
        try
        {
            if (!_worker.HasExited) _worker.Kill(true);
        }
        catch
        {
            // 退出时清理失败不影响主程序关闭。
        }
        _worker.Dispose();
        _worker = null;
    }

    public async Task UninstallAsync()
    {
        await _gate.WaitAsync();
        try
        {
            StopWorker();
            await Task.Run(() =>
            {
                DeleteDirectory(RuntimePath);
                DeleteDirectory(ModelsPath);
            });
        }
        finally
        {
            _gate.Release();
        }
    }

    private static void DeleteDirectory(string path)
    {
        if (!Directory.Exists(path)) return;
        foreach (var file in Directory.EnumerateFiles(path, "*", SearchOption.AllDirectories))
            File.SetAttributes(file, FileAttributes.Normal);
        Directory.Delete(path, true);
    }

    public void Dispose()
    {
        StopWorker();
        _gate.Dispose();
    }
}
