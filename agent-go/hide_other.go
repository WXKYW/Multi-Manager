//go:build !windows
// +build !windows

package main

import "os/exec"

// hideWindow 非 Windows 平台不需要特殊处理
func hideWindow(cmd *exec.Cmd) {
	// 非 Windows 系统无需隐藏窗口
}

// HideConsoleWindow 非 Windows 平台不需要特殊处理
func HideConsoleWindow() {
	// 非 Windows 系统无需隐藏窗口
}
