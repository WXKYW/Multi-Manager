//go:build !windows

package main

import (
	"log"
	"os"
	"os/exec"
	"syscall"

	opty "github.com/creack/pty"
)

type UnixPty struct {
	tty *os.File
	cmd *exec.Cmd
}

func (p *UnixPty) Read(b []byte) (int, error) {
	return p.tty.Read(b)
}

func (p *UnixPty) Write(b []byte) (int, error) {
	return p.tty.Write(b)
}

func (p *UnixPty) Close() error {
	if err := p.tty.Close(); err != nil {
		return err
	}
	// 杀掉子进程
	if p.cmd.Process != nil {
		pgid, err := syscall.Getpgid(p.cmd.Process.Pid)
		if err == nil {
			syscall.Kill(-pgid, syscall.SIGKILL)
		}
		p.cmd.Process.Kill()
	}
	return p.cmd.Wait()
}

func (p *UnixPty) Resize(cols, rows uint32) error {
	return opty.Setsize(p.tty, &opty.Winsize{
		Cols: uint16(cols),
		Rows: uint16(rows),
	})
}

func StartPTY(cols, rows uint32) (IPty, error) {
	var shellPath string
	shells := []string{"zsh", "fish", "bash", "sh"}
	for _, sh := range shells {
		path, err := exec.LookPath(sh)
		if err == nil && path != "" {
			shellPath = path
			break
		}
	}

	if shellPath == "" {
		shellPath = "/bin/sh"
	}

	log.Printf("[PTY] 启动 Unix 终端: %s, 尺寸: %dx%d", shellPath, cols, rows)

	cmd := exec.Command(shellPath)
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")
	
	tty, err := opty.StartWithSize(cmd, &opty.Winsize{
		Cols: uint16(cols),
		Rows: uint16(rows),
	})
	if err != nil {
		return nil, err
	}

	return &UnixPty{tty: tty, cmd: cmd}, nil
}
