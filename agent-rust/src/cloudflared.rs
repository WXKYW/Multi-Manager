#[cfg(unix)]
use serde::Deserialize;
#[cfg(unix)]
use std::fs;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
#[cfg(unix)]
use std::path::{Path, PathBuf};
#[cfg(unix)]
use std::process::{Command, Stdio};

#[cfg(unix)]
const CONFIG_ROOT: &str = "/etc/api-monitor/cloudflared";
#[cfg(unix)]
const RUNTIME_ROOT: &str = "/opt/api-monitor/cloudflared/versions";
#[cfg(unix)]
const UNIT_PATH: &str = "/etc/systemd/system/api-monitor-cloudflared.service";

#[cfg(unix)]
#[derive(Debug, Deserialize)]
struct Request {
    operation: String,
    #[serde(default)]
    token: String,
    #[serde(default)]
    version: String,
    #[serde(default)]
    asset_url_amd64: String,
    #[serde(default)]
    asset_sha256_amd64: String,
    #[serde(default)]
    asset_url_arm64: String,
    #[serde(default)]
    asset_sha256_arm64: String,
}

#[cfg(unix)]
pub fn reconcile(raw: &str) -> Result<String, String> {
    let request: Request = serde_json::from_str(raw)
        .map_err(|err| format!("invalid cloudflared desired state: {err}"))?;
    if !Path::new("/run/systemd/system").exists() {
        return Err("Cloudflare Tunnel deployment requires systemd".to_string());
    }
    match request.operation.trim().to_ascii_lowercase().as_str() {
        "install" | "reconcile" => install(&request),
        "remove" | "uninstall" => remove(),
        "status" => status(),
        _ => Err("cloudflared operation must be install, remove, or status".to_string()),
    }
}

#[cfg(unix)]
fn install(request: &Request) -> Result<String, String> {
    if request.token.trim().len() < 32 || request.token.chars().any(char::is_whitespace) {
        return Err("invalid scoped Cloudflare Tunnel token".to_string());
    }
    let binary = ensure_binary(request)?;
    let root = Path::new(CONFIG_ROOT);
    fs::create_dir_all(root)
        .map_err(|err| format!("create cloudflared config directory: {err}"))?;
    fs::set_permissions(root, fs::Permissions::from_mode(0o700))
        .map_err(|err| format!("secure cloudflared config directory: {err}"))?;
    atomic_write(&root.join("token"), request.token.trim().as_bytes(), 0o600)?;

    let unit = format!(
        "[Unit]\nDescription=API Monitor managed Cloudflare Tunnel\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart={} --no-autoupdate tunnel run --token-file {}/token\nRestart=always\nRestartSec=5s\nStartLimitIntervalSec=0\nNoNewPrivileges=true\nPrivateTmp=true\nProtectHome=true\nProtectSystem=strict\nReadOnlyPaths={}\nCapabilityBoundingSet=\nLockPersonality=true\nMemoryDenyWriteExecute=true\nRestrictSUIDSGID=true\n\n[Install]\nWantedBy=multi-user.target\n",
        binary.display(), CONFIG_ROOT, CONFIG_ROOT
    );
    atomic_write(Path::new(UNIT_PATH), unit.as_bytes(), 0o644)?;
    systemctl(&["daemon-reload"])?;
    systemctl(&["enable", "--now", "api-monitor-cloudflared.service"])?;
    systemctl(&["restart", "api-monitor-cloudflared.service"])?;
    systemctl(&["is-active", "--quiet", "api-monitor-cloudflared.service"])?;
    Ok(serde_json::json!({"status":"running","version":request.version}).to_string())
}

#[cfg(unix)]
fn remove() -> Result<String, String> {
    let _ = systemctl(&["disable", "--now", "api-monitor-cloudflared.service"]);
    let _ = fs::remove_file(UNIT_PATH);
    let _ = fs::remove_dir_all(CONFIG_ROOT);
    let _ = fs::remove_dir_all("/opt/api-monitor/cloudflared");
    systemctl(&["daemon-reload"])?;
    let _ = systemctl(&["reset-failed", "api-monitor-cloudflared.service"]);
    Ok(serde_json::json!({"status":"removed"}).to_string())
}

#[cfg(unix)]
fn status() -> Result<String, String> {
    let active = Command::new("systemctl")
        .args(["is-active", "--quiet", "api-monitor-cloudflared.service"])
        .status()
        .is_ok_and(|status| status.success());
    Ok(serde_json::json!({"status": if active { "running" } else { "stopped" }}).to_string())
}

#[cfg(unix)]
fn ensure_binary(request: &Request) -> Result<PathBuf, String> {
    if request.version.trim().is_empty() {
        return Err("cloudflared version is required".to_string());
    }
    let (url, digest) = match std::env::consts::ARCH {
        "x86_64" => (&request.asset_url_amd64, &request.asset_sha256_amd64),
        "aarch64" => (&request.asset_url_arm64, &request.asset_sha256_arm64),
        arch => return Err(format!("unsupported cloudflared architecture: {arch}")),
    };
    if !url.starts_with("https://")
        || digest.len() != 64
        || !digest.bytes().all(|value| value.is_ascii_hexdigit())
    {
        return Err("cloudflared asset must use HTTPS and a SHA-256 digest".to_string());
    }
    let version_dir = PathBuf::from(RUNTIME_ROOT).join(request.version.trim());
    let binary = version_dir.join("cloudflared");
    if binary.is_file()
        && Command::new(&binary)
            .arg("--version")
            .output()
            .is_ok_and(|output| output.status.success())
    {
        return Ok(binary);
    }
    fs::create_dir_all(&version_dir)
        .map_err(|err| format!("create cloudflared runtime directory: {err}"))?;
    let candidate = version_dir.join(".cloudflared.download");
    let _ = fs::remove_file(&candidate);
    run(
        Command::new("curl")
            .args([
                "--fail",
                "--location",
                "--retry",
                "3",
                "--retry-all-errors",
                "--connect-timeout",
                "15",
                "--proto",
                "=https",
                "--tlsv1.2",
                "--output",
            ])
            .arg(&candidate)
            .arg(url),
        "download cloudflared",
    )?;
    let output = Command::new("sha256sum")
        .arg(&candidate)
        .output()
        .map_err(|err| format!("run sha256sum: {err}"))?;
    let actual = String::from_utf8_lossy(&output.stdout)
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    if !output.status.success() || actual != digest.to_ascii_lowercase() {
        let _ = fs::remove_file(&candidate);
        return Err("cloudflared SHA-256 verification failed".to_string());
    }
    fs::set_permissions(&candidate, fs::Permissions::from_mode(0o755))
        .map_err(|err| format!("make cloudflared executable: {err}"))?;
    fs::rename(&candidate, &binary).map_err(|err| format!("activate cloudflared: {err}"))?;
    run(
        Command::new(&binary).arg("--version"),
        "verify cloudflared executable",
    )?;
    Ok(binary)
}

#[cfg(unix)]
fn atomic_write(path: &Path, bytes: &[u8], mode: u32) -> Result<(), String> {
    let temporary = path.with_extension("tmp");
    fs::write(&temporary, bytes).map_err(|err| format!("write {}: {err}", temporary.display()))?;
    fs::set_permissions(&temporary, fs::Permissions::from_mode(mode))
        .map_err(|err| format!("secure {}: {err}", temporary.display()))?;
    fs::rename(&temporary, path).map_err(|err| format!("commit {}: {err}", path.display()))
}

#[cfg(unix)]
fn systemctl(args: &[&str]) -> Result<(), String> {
    run(
        Command::new("systemctl").args(args),
        &format!("systemctl {}", args.join(" ")),
    )
}

#[cfg(unix)]
fn run(command: &mut Command, label: &str) -> Result<(), String> {
    let output = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|err| format!("{label}: {err}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "{label}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

#[cfg(not(unix))]
pub fn reconcile(_raw: &str) -> Result<String, String> {
    Err("Cloudflare Tunnel management is supported on Linux only".to_string())
}
