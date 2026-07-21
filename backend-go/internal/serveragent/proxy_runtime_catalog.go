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
}

var managedProxyRuntimeCatalog = map[string]proxyRuntimeRelease{
	"sing-box": {
		Runtime: "sing-box", Version: "1.13.14",
		AMD64URL: "https://github.com/SagerNet/sing-box/releases/download/v1.13.14/sing-box-1.13.14-linux-amd64.tar.gz", AMD64SHA256: "f48703461a15476951ac4967cdad339d986f4b8096b4eb3ff0829a500502d697",
		ARM64URL: "https://github.com/SagerNet/sing-box/releases/download/v1.13.14/sing-box-1.13.14-linux-arm64.tar.gz", ARM64SHA256: "4742df6a4314e8ecc41736849fca6d73b8f9e91b6e8b06ee794ff17ba180579e",
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
