#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

const HOST: &str = "127.0.0.1";
const PORT: u16 = 3737;
const BACKEND_WAIT_TIMEOUT: Duration = Duration::from_secs(15);
const SIDECAR_FILE: &str = "s3-backend-x86_64-pc-windows-msvc.exe";

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

fn find_sidecar_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join(SIDECAR_FILE));
            candidates.push(dir.join("..").join(SIDECAR_FILE));
        }
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join(SIDECAR_FILE));
    }

    candidates.push(PathBuf::from("src-tauri").join("bin").join(SIDECAR_FILE));

    for path in candidates {
        if path.exists() {
            return Ok(path);
        }
    }

    Err(format!("Could not locate sidecar binary '{SIDECAR_FILE}'"))
}

fn main() {
    tauri::Builder::default()
        .manage(BackendState::default())
        .setup(|app| {
            let backend_addr: SocketAddr = format!("{}:{}", HOST, PORT)
                .parse()
                .map_err(|e| format!("Invalid backend address: {e}"))?;

            let sidecar_path = find_sidecar_path(app.handle())?;

            let mut child = Command::new(sidecar_path)
                .env("S3_BROWSER_NO_OPEN", "1")
                .env("S3_BROWSER_HOST", HOST)
                .env("S3_BROWSER_PORT", PORT.to_string())
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
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
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| match event {
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
