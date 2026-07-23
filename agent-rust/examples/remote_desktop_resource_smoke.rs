#[cfg(target_os = "windows")]
fn main() {
    use std::time::Duration;

    use win_native_media::capture::{self, CaptureConfig};
    use win_native_media::encoder::mf_h264::MfH264Encoder;
    use win_native_media::{CaptureTarget, VideoConfig};
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows_sys::Win32::System::ProcessStatus::{
        K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX,
    };
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, GetCurrentProcessId, GetProcessHandleCount,
    };

    fn handle_count() -> u32 {
        let mut count = 0;
        let ok = unsafe { GetProcessHandleCount(GetCurrentProcess(), &mut count) };
        assert_ne!(ok, 0, "GetProcessHandleCount failed");
        count
    }

    fn private_bytes() -> usize {
        let mut counters = PROCESS_MEMORY_COUNTERS_EX::default();
        counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
        let ok = unsafe {
            K32GetProcessMemoryInfo(
                GetCurrentProcess(),
                (&mut counters as *mut PROCESS_MEMORY_COUNTERS_EX)
                    .cast::<PROCESS_MEMORY_COUNTERS>(),
                counters.cb,
            )
        };
        assert_ne!(ok, 0, "K32GetProcessMemoryInfo failed");
        counters.PrivateUsage
    }

    fn thread_count() -> u32 {
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
        assert_ne!(
            snapshot, INVALID_HANDLE_VALUE,
            "CreateToolhelp32Snapshot failed"
        );
        let process_id = unsafe { GetCurrentProcessId() };
        let mut entry = THREADENTRY32 {
            dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
            ..Default::default()
        };
        let mut count = 0;
        let mut has_entry = unsafe { Thread32First(snapshot, &mut entry) } != 0;
        while has_entry {
            if entry.th32OwnerProcessID == process_id {
                count += 1;
            }
            has_entry = unsafe { Thread32Next(snapshot, &mut entry) } != 0;
        }
        let _ = unsafe { CloseHandle(snapshot) };
        count
    }

    let baseline = handle_count();
    let cycles = std::env::var("REMOTE_DESKTOP_SMOKE_CYCLES")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(5);
    let capture_only = std::env::var_os("REMOTE_DESKTOP_SMOKE_CAPTURE_ONLY").is_some();
    let software_only = std::env::var_os("REMOTE_DESKTOP_SMOKE_SOFTWARE").is_some();
    let mut samples = Vec::new();
    let mut private_samples = Vec::new();
    let mut thread_samples = Vec::new();
    for cycle in 0..cycles {
        {
            let (session, frames) = capture::start(
                CaptureConfig {
                    target: CaptureTarget::Monitor(0),
                    capture_cursor: true,
                },
                1,
            )
            .expect("start Windows Graphics Capture");
            let frame = frames
                .recv_timeout(Duration::from_secs(5))
                .expect("receive first GPU frame");
            let config = VideoConfig {
                width: frame.width,
                height: frame.height,
                fps: 30,
                bitrate: 6_000_000,
                keyframe_interval: 60,
            };
            if !capture_only {
                let mut encoder = if software_only {
                    MfH264Encoder::new(session.device(), config)
                } else {
                    MfH264Encoder::new_with(session.device(), config, true)
                        .or_else(|_| MfH264Encoder::new(session.device(), config))
                }
                .expect("create Media Foundation H.264 encoder");
                let mut output = Vec::new();
                encoder
                    .encode(&frame.texture, frame.timestamp, &mut output)
                    .expect("encode GPU frame");
            }
        }
        std::thread::sleep(Duration::from_millis(500));
        let handles = handle_count();
        let private = private_bytes();
        let threads = thread_count();
        samples.push(handles);
        private_samples.push(private);
        thread_samples.push(threads);
        println!(
            "cycle {}: {} handles, {} threads, {:.1} MiB private",
            cycle + 1,
            handles,
            threads,
            private as f64 / 1_048_576.0
        );
    }

    let warm = samples[0];
    let final_count = *samples.last().expect("handle samples");
    let allowed_handle_growth = (cycles as u32).saturating_mul(2).saturating_add(8);
    assert!(
        final_count <= warm.saturating_add(allowed_handle_growth),
        "remote desktop resources grew after warm-up: baseline={baseline}, samples={samples:?}"
    );
    let warm_private = private_samples[0];
    let final_private = *private_samples.last().expect("private memory samples");
    assert!(
        final_private <= warm_private.saturating_add(64 * 1_048_576),
        "remote desktop private memory grew after warm-up: samples={private_samples:?}"
    );
    let warm_threads = thread_samples[0];
    let final_threads = *thread_samples.last().expect("thread samples");
    assert!(
        final_threads <= warm_threads.saturating_add(4),
        "remote desktop threads grew after warm-up: samples={thread_samples:?}"
    );
}

#[cfg(not(target_os = "windows"))]
fn main() {
    eprintln!("remote desktop resource smoke is Windows-only");
}
