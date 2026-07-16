[CmdletBinding()]
param(
    [string]$SourcePath = ""
)

$ErrorActionPreference = "Stop"

function Get-Sha256Hex {
    param([Parameter(Mandatory = $true)][string]$Path)

    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $sha256 = [System.Security.Cryptography.SHA256]::Create()
        try {
            return ([System.BitConverter]::ToString($sha256.ComputeHash($stream))).Replace("-", "")
        } finally {
            $sha256.Dispose()
        }
    } finally {
        $stream.Dispose()
    }
}

$repoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($SourcePath)) {
    $SourcePath = Join-Path $repoRoot "agent-rust\target\release\api-monitor-agent.exe"
}
$SourcePath = [System.IO.Path]::GetFullPath($SourcePath)

if (!(Test-Path -LiteralPath $SourcePath -PathType Leaf)) {
    throw "Windows Agent release binary was not found: $SourcePath. Run 'cargo build --manifest-path agent-rust/Cargo.toml --release' first."
}

$versionOutput = (& $SourcePath --version 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $versionOutput -notmatch '^api-monitor-agent\s+\S+$') {
    throw "Source binary did not report a valid Agent version: $versionOutput"
}

$targets = @(
    (Join-Path $repoRoot "public\agent\agent-windows-amd64.exe"),
    (Join-Path $repoRoot "public\agent\am-agent-win.exe"),
    (Join-Path $repoRoot "public\downloads\agent-windows-latest.exe")
)

$sourceHash = Get-Sha256Hex -Path $SourcePath

foreach ($target in $targets) {
    $targetDirectory = Split-Path -Parent $target
    New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null

    $temporaryTarget = "$target.download"
    Copy-Item -LiteralPath $SourcePath -Destination $temporaryTarget -Force
    Move-Item -LiteralPath $temporaryTarget -Destination $target -Force

    $targetHash = Get-Sha256Hex -Path $target
    if ($targetHash -ne $sourceHash) {
        throw "Published binary hash mismatch: $target"
    }

    Write-Host "Published $versionOutput -> $target"
}

Write-Host "SHA256: $sourceHash"
