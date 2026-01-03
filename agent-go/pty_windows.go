//go:build windows

package main

import (
	"log"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/UserExistsError/conpty"
)

type WindowsPty struct {
	tty *conpty.ConPty
}

func (p *WindowsPty) Read(b []byte) (int, error) {
	return p.tty.Read(b)
}

func (p *WindowsPty) Write(b []byte) (int, error) {
	return p.tty.Write(b)
}

func (p *WindowsPty) Close() error {
	return p.tty.Close()
}

func (p *WindowsPty) Resize(cols, rows uint32) error {
	return p.tty.Resize(int(cols), int(rows))
}

func StartPTY(cols, rows uint32) (IPty, error) {
	shellPath, err := exec.LookPath("powershell.exe")
	if err != nil || shellPath == "" {
		shellPath = "cmd.exe"
	}

	// 使用可执行文件所在目录作为工作目录
	exePath, _ := os.Executable()
	workDir := filepath.Dir(exePath)

	log.Printf("[PTY] 启动 Windows 终端: %s, 尺寸: %dx%d, 工作目录: %s", shellPath, cols, rows, workDir)

	tty, err := conpty.Start(shellPath, 
		conpty.ConPtyWorkDir(workDir),
	)
	if err != nil {
		return nil, err
	}

	// 初始化尺寸
	tty.Resize(int(cols), int(rows))

	return &WindowsPty{tty: tty}, nil
}
