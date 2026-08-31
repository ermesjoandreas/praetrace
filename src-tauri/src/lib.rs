use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager, RunEvent, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// The one line the sidecar prints for us to parse; the rest of its stdout is
/// prose for a human.
const PORT_LINE_PREFIX: &str = "codemap-port=";

/// How long the webview will wait for the sidecar to finish its boot scan.
const READY_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Default)]
struct Server {
    port: Mutex<Option<u16>>,
    child: Mutex<Option<CommandChild>>,
}

/// The webview asks for the port rather than assuming one: the OS assigns it, so
/// nothing in the app may hard-code it.
#[tauri::command]
async fn get_server_port(server: State<'_, Server>) -> Result<u16, String> {
    let deadline = std::time::Instant::now() + READY_TIMEOUT;

    loop {
        if let Some(port) = *server.port.lock().map_err(|error| error.to_string())? {
            return Ok(port);
        }
        if std::time::Instant::now() >= deadline {
            return Err("the codemap server did not report a port in time".into());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Where the server's JavaScript lives.
///
/// Development runs the repository's own build so `npm run build` is picked up
/// without repackaging; a bundled app runs the copy in its resources.
fn server_entry(app: &AppHandle) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist/server/main.js"))
    } else {
        app.path()
            .resource_dir()
            .map(|dir| dir.join("app/dist/server/main.js"))
            .map_err(|error| error.to_string())
    }
}

/// Temporary. Item 3 replaces this with a native folder picker and a
/// recent-projects list; until then development graphs the repository itself.
fn initial_project_root() -> PathBuf {
    if let Ok(explicit) = std::env::var("CODEMAP_PROJECT") {
        return PathBuf::from(explicit);
    }
    if cfg!(debug_assertions) {
        return PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn spawn_server(app: &AppHandle) -> Result<(), String> {
    let entry = server_entry(app)?;
    let root = initial_project_root();

    let (mut events, child) = app
        .shell()
        .sidecar("node")
        .map_err(|error| error.to_string())?
        .args([
            entry.to_string_lossy().to_string(),
            root.to_string_lossy().to_string(),
            // The OS picks the port: a desktop app cannot assume one is free.
            "--port=0".to_string(),
            // Our stdin pipe is the sidecar's parent-death signal. If this
            // process is killed outright, the pipe closes and the server exits
            // instead of orphaning with a port and a worker pool.
            "--exit-on-stdin-close".to_string(),
        ])
        .spawn()
        .map_err(|error| error.to_string())?;

    let server = app.state::<Server>();
    *server.child.lock().map_err(|error| error.to_string())? = Some(child);

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    for line in line.lines() {
                        if let Some(port) = line.trim().strip_prefix(PORT_LINE_PREFIX) {
                            match port.parse::<u16>() {
                                Ok(port) => {
                                    log::info!("codemap server listening on {port}");
                                    if let Ok(mut slot) = app.state::<Server>().port.lock() {
                                        *slot = Some(port);
                                    }
                                }
                                Err(_) => log::error!("unparseable port line: {line}"),
                            }
                        }
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    log::warn!("codemap server: {}", String::from_utf8_lossy(&bytes).trim());
                }
                CommandEvent::Terminated(status) => {
                    log::error!("codemap server exited: {status:?}");
                    if let Ok(mut slot) = app.state::<Server>().port.lock() {
                        *slot = None;
                    }
                }
                _ => {}
            }
        }
    });

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(Server::default())
        .invoke_handler(tauri::generate_handler![get_server_port])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            spawn_server(app.handle())?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Killing the child explicitly on exit, rather than relying on the
            // pipe closing, so a clean quit never leaves a Node process behind.
            if let RunEvent::Exit = event {
                if let Ok(mut child) = app.state::<Server>().child.lock() {
                    if let Some(child) = child.take() {
                        let _ = child.kill();
                    }
                }
            }
        });
}
