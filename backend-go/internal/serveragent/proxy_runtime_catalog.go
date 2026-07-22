package serveragent

// Managed proxy runtime releases are deliberately pinned. Updating them is a
// reviewed application release, never a runtime lookup of GitHub's `latest`.
type proxyRuntimeRelease struct {
	Runtime     string
	Version     string
	AMD64URL    string
	AMD64SHA256 string
	ARM64URL    string
	ARM64SHA256 string
	AssetFormat string
}

var managedProxyRuntimeCatalog = map[string]proxyRuntimeRelease{
	"sing-box": {
		Runtime: "sing-box", Version: "1.13.14-am1",
		AMD64URL: "https://github.com/iwvw/API-Monitor/releases/download/managed-runtime-v1.13.14/sing-box-1.13.14-linux-amd64", AMD64SHA256: "094568655c7324de08bbeb108df886950f76b4dc164e1e5bc08e64219f1af727",
		ARM64URL: "https://github.com/iwvw/API-Monitor/releases/download/managed-runtime-v1.13.14/sing-box-1.13.14-linux-arm64", ARM64SHA256: "fd19a07696593307c14133ae0ebed2e089523424b3f2ab2ea74aa206661f7131",
		AssetFormat: "binary",
	},
}

func managedProxyRuntime(runtime string) (proxyRuntimeRelease, bool) {
	// The internal data plane is intentionally uniform. sing-box supports both
	// VLESS REALITY/XTLS Vision and Hysteria2, avoiding two independent core
	// installation and security-update paths.
	if runtime == "xray" || runtime == "singbox" {
		runtime = "sing-box"
	}
	release, ok := managedProxyRuntimeCatalog[runtime]
	return release, ok
}
