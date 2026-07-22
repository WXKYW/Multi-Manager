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
		AMD64URL: "https://github.com/iwvw/API-Monitor/releases/download/managed-runtime-v1.13.14/sing-box-1.13.14-linux-amd64", AMD64SHA256: "b1084f055f8aaddf9a6b554791f704fd40d1536c44928977b91ae0d31e8329fb",
		ARM64URL: "https://github.com/iwvw/API-Monitor/releases/download/managed-runtime-v1.13.14/sing-box-1.13.14-linux-arm64", ARM64SHA256: "82a24f1947e1cd6296a053511fbf3e5e8acaf4fa98940550e010692cee700623",
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
