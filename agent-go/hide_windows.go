//go:build windows
// +build windows

package main

import (
	"os/exec"
	"syscall"
)

// hideWindow 在 Windows 上隐藏子进程控制台窗口
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow: true,
	}
}
