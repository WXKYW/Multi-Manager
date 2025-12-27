// +build !windows

package main

import "fmt"

// IsRunningAsService 非 Windows 平台始终返回 false
func IsRunningAsService() bool {
	return false
}

// RunAsService 非 Windows 平台不支持服务模式
func RunAsService() {
	fmt.Println("Windows 服务模式仅在 Windows 平台可用")
}

// InstallService 非 Windows 平台不支持
func InstallService() error {
	return fmt.Errorf("Windows 服务模式仅在 Windows 平台可用")
}

// UninstallService 非 Windows 平台不支持
func UninstallService() error {
	return fmt.Errorf("Windows 服务模式仅在 Windows 平台可用")
}

// StartService 非 Windows 平台不支持
func StartService() error {
	return fmt.Errorf("Windows 服务模式仅在 Windows 平台可用")
}

// StopService 非 Windows 平台不支持
func StopService() error {
	return fmt.Errorf("Windows 服务模式仅在 Windows 平台可用")
}
