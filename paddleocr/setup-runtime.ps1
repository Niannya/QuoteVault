$ErrorActionPreference = 'Stop'

$runtime = Join-Path $env:LOCALAPPDATA 'QuoteVault\paddle-runtime'
$python = Join-Path $runtime 'Scripts\python.exe'
$sourcePython = Get-Command py -ErrorAction SilentlyContinue

if (-not (Test-Path -LiteralPath $python)) {
    if ($sourcePython) {
        & py -3.10 -m venv $runtime
    } else {
        throw '需要 Python 3.10。请先安装 Python，再重新运行此脚本。'
    }
}

& $python -m pip install --upgrade pip
& $python -m pip install paddlepaddle==3.2.0 -i https://www.paddlepaddle.org.cn/packages/stable/cpu/
& $python -m pip install paddleocr==3.7.0

Write-Host "PaddleOCR 实验运行环境已安装到：$runtime"
Write-Host '首次识别会自动下载 PP-OCRv6 medium 模型。'
