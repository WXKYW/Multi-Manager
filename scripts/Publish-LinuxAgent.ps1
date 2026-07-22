[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$SourcePath,

    [ValidateSet("amd64", "arm64")]
    [string]$Architecture = "amd64"
)

$ErrorActionPreference = "Stop"

function Get-Sha256Hex {
    param([Parameter(Mandatory = $true)][string]$Path)

    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$SourcePath = [System.IO.Path]::GetFullPath($SourcePath)
if (!(Test-Path -LiteralPath $SourcePath -PathType Leaf)) {
    throw "Linux Agent release binary was not found: $SourcePath"
}

$sourceInfo = Get-Item -LiteralPath $SourcePath
if ($sourceInfo.Length -lt 1MB) {
    throw "Linux Agent release binary is unexpectedly small: $($sourceInfo.Length) bytes"
}

$stream = [System.IO.File]::OpenRead($SourcePath)
try {
    $magic = New-Object byte[] 4
    if ($stream.Read($magic, 0, $magic.Length) -ne $magic.Length -or
        $magic[0] -ne 0x7f -or $magic[1] -ne 0x45 -or $magic[2] -ne 0x4c -or $magic[3] -ne 0x46) {
        throw "Source file is not an ELF executable: $SourcePath"
    }
} finally {
    $stream.Dispose()
}

$targetDirectory = Join-Path $repoRoot "public\agent"
$target = Join-Path $targetDirectory "agent-linux-$Architecture"
$checksumTarget = "$target.sha256"
New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null

$temporaryTarget = "$target.download"
$temporaryChecksum = "$checksumTarget.download"
try {
    Copy-Item -LiteralPath $SourcePath -Destination $temporaryTarget -Force
    $sourceHash = Get-Sha256Hex -Path $SourcePath
    $targetHash = Get-Sha256Hex -Path $temporaryTarget
    if ($targetHash -ne $sourceHash) {
        throw "Published Linux Agent binary hash mismatch"
    }
    [System.IO.File]::WriteAllText($temporaryChecksum, "$sourceHash`n", [System.Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporaryTarget -Destination $target -Force
    Move-Item -LiteralPath $temporaryChecksum -Destination $checksumTarget -Force
} finally {
    Remove-Item -LiteralPath $temporaryTarget, $temporaryChecksum -Force -ErrorAction SilentlyContinue
}

Write-Host "Published Linux $Architecture Agent -> $target"
Write-Host "SHA256: $sourceHash"
