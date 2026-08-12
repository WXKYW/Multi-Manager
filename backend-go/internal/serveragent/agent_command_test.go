package serveragent

import (
	"encoding/base64"
	"strings"
	"testing"
	"unicode/utf16"
)

func decodeEncodedCommand(command string) (string, bool) {
	idx := strings.LastIndex(command, "-EncodedCommand ")
	if idx < 0 {
		return "", false
	}
	b64 := strings.TrimSpace(command[idx+len("-EncodedCommand "):])
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return "", false
	}
	u16 := make([]uint16, 0, len(raw)/2)
	for i := 0; i+1 < len(raw); i += 2 {
		u16 = append(u16, uint16(raw[i])|uint16(raw[i+1])<<8)
	}
	return string(utf16.Decode(u16)), true
}

func TestNormalizeExecCommandPowerShellWithQuotesAndPipe(t *testing.T) {
	in := `powershell -NoProfile -Command "Get-Process api-monitor-agent | Select-Object Id | Format-List"`
	out := normalizeExecCommand(in)
	script, ok := decodeEncodedCommand(out)
	if !ok {
		t.Fatalf("expected -EncodedCommand form, got: %s", out)
	}
	want := `Get-Process api-monitor-agent | Select-Object Id | Format-List`
	if script != want {
		t.Fatalf("script = %q, want %q", script, want)
	}
	if !strings.HasPrefix(out, "powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ") {
		t.Fatalf("unexpected invocation: %s", out)
	}
}

func TestNormalizeExecCommandPowerShellBareTokens(t *testing.T) {
	in := `powershell -NoProfile -Command Get-Date -Format yyyy-MM-dd`
	out := normalizeExecCommand(in)
	script, ok := decodeEncodedCommand(out)
	if !ok {
		t.Fatalf("expected -EncodedCommand form, got: %s", out)
	}
	if script != `Get-Date -Format yyyy-MM-dd` {
		t.Fatalf("script = %q", script)
	}
}

func TestNormalizeExecCommandChineseScript(t *testing.T) {
	in := `powershell -Command "Write-Host '中文测试' | Out-Host"`
	out := normalizeExecCommand(in)
	script, ok := decodeEncodedCommand(out)
	if !ok {
		t.Fatalf("expected -EncodedCommand form, got: %s", out)
	}
	if script != `Write-Host '中文测试' | Out-Host` {
		t.Fatalf("script = %q", script)
	}
}

func TestNormalizeExecCommandNonPowerShellUnchanged(t *testing.T) {
	cases := []string{
		`echo hello`,
		`dir %TEMP%`,
		`tasklist | findstr api-monitor`,
		`powershell -File C:\x.ps1`, // 无 -Command，保持原样
	}
	for _, in := range cases {
		if out := normalizeExecCommand(in); out != in {
			t.Fatalf("command %q was rewritten to %q", in, out)
		}
	}
}

func TestNormalizeExecCommandPwshShortC(t *testing.T) {
	in := `pwsh -c "Get-Process | Select Id"`
	out := normalizeExecCommand(in)
	script, ok := decodeEncodedCommand(out)
	if !ok {
		t.Fatalf("expected -EncodedCommand form, got: %s", out)
	}
	if script != `Get-Process | Select Id` {
		t.Fatalf("script = %q", script)
	}
}
