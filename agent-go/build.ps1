# API Monitor Agent 构建脚本 (PowerShell)
$VERSION = "0.1.2"
$OUTPUT_DIR = "dist"
$PUBLIC_DIR = "..\public\agent"

# 清理输出目录
if (Test-Path $OUTPUT_DIR) { Remove-Item $OUTPUT_DIR -Recurse -Force }
New-Item -ItemType Directory -Force -Path $OUTPUT_DIR | Out-Null
New-Item -ItemType Directory -Force -Path $PUBLIC_DIR | Out-Null

Write-Host "=== Building API Monitor Agent v$VERSION ===" -ForegroundColor Cyan

# 设置通用的构建参数
$LDFLAGS = "-s -w -X main.VERSION=$VERSION"

# 1. Windows amd64
Write-Host "Building windows-amd64..."
$env:GOOS = "windows"
$env:GOARCH = "amd64"
go build -ldflags $LDFLAGS -o "$OUTPUT_DIR\agent-windows-amd64.exe"
Copy-Item "$OUTPUT_DIR\agent-windows-amd64.exe" "$PUBLIC_DIR\agent-windows-amd64.exe" -Force
# 兼容旧版脚本的备用名
Copy-Item "$OUTPUT_DIR\agent-windows-amd64.exe" "$PUBLIC_DIR\am-agent-win.exe" -Force

# 2. Linux amd64
Write-Host "Building linux-amd64..."
$env:GOOS = "linux"
$env:GOARCH = "amd64"
go build -ldflags $LDFLAGS -o "$OUTPUT_DIR\agent-linux-amd64"
Copy-Item "$OUTPUT_DIR\agent-linux-amd64" "$PUBLIC_DIR\agent-linux-amd64" -Force

# 3. Linux arm64
Write-Host "Building linux-arm64..."
$env:GOOS = "linux"
$env:GOARCH = "arm64"
go build -ldflags $LDFLAGS -o "$OUTPUT_DIR\agent-linux-arm64"
Copy-Item "$OUTPUT_DIR\agent-linux-arm64" "$PUBLIC_DIR\agent-linux-arm64" -Force

# 4. macOS amd64
Write-Host "Building darwin-amd64..."
$env:GOOS = "darwin"
$env:GOARCH = "amd64"
go build -ldflags $LDFLAGS -o "$OUTPUT_DIR\agent-darwin-amd64"
Copy-Item "$OUTPUT_DIR\agent-darwin-amd64" "$PUBLIC_DIR\agent-darwin-amd64" -Force

# 5. macOS arm64
Write-Host "Building darwin-arm64..."
$env:GOOS = "darwin"
$env:GOARCH = "arm64"
go build -ldflags $LDFLAGS -o "$OUTPUT_DIR\agent-darwin-arm64"
Copy-Item "$OUTPUT_DIR\agent-darwin-arm64" "$PUBLIC_DIR\agent-darwin-arm64" -Force

# 恢复环境变量
$env:GOOS = $null
$env:GOARCH = $null

Write-Host "=== Build Complete ===" -ForegroundColor Green
Write-Host "Output Directory: $OUTPUT_DIR"
Write-Host "Public Directory: $PUBLIC_DIR"
Get-ChildItem $PUBLIC_DIR | Select-Object Name, @{Name="Size(KB)";Expression={[math]::round($_.Length / 1KB, 2)}}
