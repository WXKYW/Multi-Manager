#!/bin/bash
# API Monitor Agent 构建脚本

VERSION="0.1.2"
OUTPUT_DIR="dist"

# 清理输出目录
rm -rf $OUTPUT_DIR
mkdir -p $OUTPUT_DIR

echo "=== Building API Monitor Agent v${VERSION} ==="

# Linux amd64
echo "Building linux-amd64..."
GOOS=linux GOARCH=amd64 go build -ldflags="-s -w -X main.VERSION=${VERSION}" -o $OUTPUT_DIR/agent-linux-amd64
upx --best $OUTPUT_DIR/agent-linux-amd64 2>/dev/null || true

# Linux arm64
echo "Building linux-arm64..."
GOOS=linux GOARCH=arm64 go build -ldflags="-s -w -X main.VERSION=${VERSION}" -o $OUTPUT_DIR/agent-linux-arm64
upx --best $OUTPUT_DIR/agent-linux-arm64 2>/dev/null || true

# Windows amd64
echo "Building windows-amd64..."
GOOS=windows GOARCH=amd64 go build -ldflags="-s -w -X main.VERSION=${VERSION}" -o $OUTPUT_DIR/agent-windows-amd64.exe

# macOS amd64
echo "Building darwin-amd64..."
GOOS=darwin GOARCH=amd64 go build -ldflags="-s -w -X main.VERSION=${VERSION}" -o $OUTPUT_DIR/agent-darwin-amd64

# macOS arm64 (Apple Silicon)
echo "Building darwin-arm64..."
GOOS=darwin GOARCH=arm64 go build -ldflags="-s -w -X main.VERSION=${VERSION}" -o $OUTPUT_DIR/agent-darwin-arm64

echo "=== Build Complete ==="
ls -lh $OUTPUT_DIR/
