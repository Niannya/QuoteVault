param(
    [switch]$DownloadModels
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Write-ProgressMarker([int]$Value, [string]$Text) {
    Write-Output "QUOTEVault_PROGRESS:${Value}:${Text}"
}

$runtime = Join-Path $env:LOCALAPPDATA 'QuoteVault\paddle-runtime'
$python = Join-Path $runtime 'Scripts\python.exe'
$sourcePython = Get-Command py -ErrorAction SilentlyContinue
Write-ProgressMarker 5 '正在检查 Python 运行环境…'

if (-not (Test-Path -LiteralPath $python)) {
    Write-ProgressMarker 10 '正在创建独立运行环境…'
    if ($sourcePython) {
        & py -3.10 -m venv $runtime
        if ($LASTEXITCODE -ne 0) { throw 'Python 3.10 is required to install PaddleOCR.' }
    } else {
        throw 'Python 3.10 is required to install PaddleOCR.'
    }
}

Write-ProgressMarker 20 '正在准备安装工具…'
& $python -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) { throw 'Failed to update pip.' }
Write-ProgressMarker 35 '正在安装 PaddlePaddle…'
& $python -m pip install paddlepaddle==3.2.0 -i https://www.paddlepaddle.org.cn/packages/stable/cpu/
if ($LASTEXITCODE -ne 0) { throw 'Failed to install paddlepaddle.' }
Write-ProgressMarker 60 '正在安装 PaddleOCR…'
& $python -m pip install paddleocr==3.7.0
if ($LASTEXITCODE -ne 0) { throw 'Failed to install paddleocr.' }

if ($DownloadModels) {
    Write-ProgressMarker 78 '正在下载中文识别模型…'
    $worker = Join-Path $PSScriptRoot 'paddle_worker.py'
    if (-not (Test-Path -LiteralPath $worker)) {
        throw "PaddleOCR worker not found: $worker"
    }
    $env:PADDLE_PDX_CACHE_HOME = Join-Path $env:LOCALAPPDATA 'QuoteVault\paddle-models'
    $env:PADDLE_PDX_MODEL_SOURCE = 'BOS'
    & $python -u $worker --install-models
    if ($LASTEXITCODE -ne 0) { throw 'PaddleOCR model download failed.' }
}

Write-ProgressMarker 100 '安装完成'
Write-Host "PaddleOCR runtime installed at: $runtime"
if ($DownloadModels) {
    Write-Host "PaddleOCR models installed at: $env:PADDLE_PDX_CACHE_HOME"
} else {
    Write-Host 'Models will be downloaded when PaddleOCR is used for the first time.'
}
