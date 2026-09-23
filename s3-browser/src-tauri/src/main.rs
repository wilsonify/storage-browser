#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::OpenOptions;
use std::io::Write;
use std::net::{SocketAddr, TcpStream};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

const HOST: &str = "127.0.0.1";
const PORT: u16 = 3737;
const BACKEND_WAIT_TIMEOUT: Duration = Duration::from_secs(15);
const SIDECAR_FILE_INSTALL: &str = "s3-backend.exe";
const SIDECAR_FILE_DEV: &str = "s3-backend-x86_64-pc-windows-msvc.exe";
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Default)]
struct BackendState {
    child: Mutex<Option<Child>>,
}

fn stop_backend(app: &tauri::AppHandle) {
    let state = app.state::<BackendState>();
    let mut guard = state.child.lock().unwrap();
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn wait_for_backend(addr: SocketAddr, timeout: Duration) -> Result<(), String> {
    let start = Instant::now();

    while start.elapsed() < timeout {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(200));
    }

    Err(format!("Timed out waiting for backend at {addr}"))
}

fn write_startup_error(message: &str) {
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        let log_path = PathBuf::from(local_app_data)
            .join("S3 Browser")
            .join("startup-error.log");

        if let Some(parent) = log_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }

        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(log_path) {
            let _ = writeln!(file, "{}", message);
        }
    }
}

fn find_sidecar_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join(SIDECAR_FILE_INSTALL));
            candidates.push(dir.join(SIDECAR_FILE_DEV));
            candidates.push(dir.join("..").join(SIDECAR_FILE_INSTALL));
            candidates.push(dir.join("..").join(SIDECAR_FILE_DEV));
        }
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join(SIDECAR_FILE_INSTALL));
        candidates.push(resource_dir.join(SIDECAR_FILE_DEV));
    }

    candidates.push(PathBuf::from("src-tauri").join("bin").join(SIDECAR_FILE_INSTALL));
    candidates.push(PathBuf::from("src-tauri").join("bin").join(SIDECAR_FILE_DEV));

    for path in candidates {
        if path.exists() {
            return Ok(path);
        }
    }

    Err(format!(
        "Could not locate sidecar binary '{}' or '{}'",
        SIDECAR_FILE_INSTALL, SIDECAR_FILE_DEV
    ))
}

fn main() {
    let app_result = tauri::Builder::default()
        .manage(BackendState::default())
        .setup(|app| {
            let backend_addr: SocketAddr = format!("{}:{}", HOST, PORT)
                .parse()
                .map_err(|e| format!("Invalid backend address: {e}"))?;

            let sidecar_path = find_sidecar_path(app.handle())?;

            let mut backend_cmd = Command::new(sidecar_path);
            backend_cmd
                .env("S3_BROWSER_NO_OPEN", "1")
                .env("S3_BROWSER_HOST", HOST)
                .env("S3_BROWSER_PORT", PORT.to_string())
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());

            #[cfg(target_os = "windows")]
            {
                backend_cmd.creation_flags(CREATE_NO_WINDOW);
            }

            let mut child = backend_cmd
                .spawn()
                .map_err(|e| format!("Failed to start backend sidecar: {e}"))?;

            if let Some(mut out) = child.stdout.take() {
                std::thread::spawn(move || {
                    use std::io::Read;
                    let mut buf = String::new();
                    let _ = out.read_to_string(&mut buf);
                    if !buf.trim().is_empty() {
                        println!("[backend] {buf}");
                    }
                });
            }

            if let Some(mut err) = child.stderr.take() {
                std::thread::spawn(move || {
                    use std::io::Read;
                    let mut buf = String::new();
                    let _ = err.read_to_string(&mut buf);
                    if !buf.trim().is_empty() {
                        eprintln!("[backend] {buf}");
                    }
                });
            }

            {
                let state = app.state::<BackendState>();
                let mut guard = state.child.lock().unwrap();
                *guard = Some(child);
            }

            wait_for_backend(backend_addr, BACKEND_WAIT_TIMEOUT)?;

            WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External(format!("http://{}:{}", HOST, PORT).parse()?),
            )
            .title("S3 Browser")
            .inner_size(1320.0, 860.0)
            .min_inner_size(900.0, 620.0)
            .build()
            .map_err(|e| format!("Failed to create main window: {e}"))?;

            Ok(())
        })
        .build(tauri::generate_context!());

    let app = match app_result {
        Ok(app) => app,
        Err(err) => {
            write_startup_error(&format!("Failed to build Tauri app: {err}"));
            eprintln!("Failed to build Tauri app: {err}");
            return;
        }
    };

    app.run(|app, event| match event {
        tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
            stop_backend(app);
        }
        tauri::RunEvent::WindowEvent {
            event: tauri::WindowEvent::Destroyed,
            ..
        } => {
            stop_backend(app);
        }
        _ => {}
    });
}
