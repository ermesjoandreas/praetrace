use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager, RunEvent, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// The one line the sidecar prints for us to parse; the rest of its stdout is
/// prose for a human.
const PORT_LINE_PREFIX: &str = "codemap-port=";

/// How long the webview will wait for the sidecar to finish its boot scan.
const READY_TIMEOUT: Duration = Duration::from_secs(60);

/// Enough to be useful in a menu, short enough to stay a menu.
const MAX_RECENTS: usize = 10;

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

/// A native folder picker. Returns null when the user cancels.
#[tauri::command]
async fn pick_project(app: AppHandle) -> Option<String> {
    let (send, receive) = tokio::sync::oneshot::channel();

    app.dialog()
        .file()
        .set_title("Open project")
        .pick_folder(move |picked| {
            let path = picked
                .and_then(|file| file.into_path().ok())
                .map(|path| path.to_string_lossy().to_string());
            let _ = send.send(path);
        });

    receive.await.ok().flatten()
}

// --- recent projects -----------------------------------------------------
//
// A plain JSON file, deliberately. Item 6 introduces SQLite for window state and
// per-project settings, designed around session history; a list of paths is not
// a reason to improvise that schema early.

fn recents_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("recent-projects.json"))
}

fn read_recents(app: &AppHandle) -> Vec<String> {
    let Ok(path) = recents_path(app) else {
        return Vec::new();
    };
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    serde_json::from_str::<Vec<String>>(&raw).unwrap_or_default()
}

#[tauri::command]
fn recent_projects(app: AppHandle) -> Vec<String> {
    // Directories that have since been deleted or moved are not offered.
    read_recents(&app)
        .into_iter()
        .filter(|path| PathBuf::from(path).is_dir())
        .collect()
}

#[tauri::command]
fn remember_project(app: AppHandle, path: String) -> Vec<String> {
    let mut recents = read_recents(&app);
    recents.retain(|existing| existing != &path);
    recents.insert(0, path);
    recents.truncate(MAX_RECENTS);

    if let Ok(file) = recents_path(&app) {
        if let Ok(encoded) = serde_json::to_string_pretty(&recents) {
            let _ = std::fs::write(file, encoded);
        }
    }
    recents
}

// --- sidecar -------------------------------------------------------------

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

/// The project to open on launch. The picker replaces it from then on.
fn initial_project_root(app: &AppHandle) -> PathBuf {
    if let Ok(explicit) = std::env::var("CODEMAP_PROJECT") {
        return PathBuf::from(explicit);
    }
    if let Some(recent) = read_recents(app).into_iter().find(|p| PathBuf::from(p).is_dir()) {
        return PathBuf::from(recent);
    }
    if cfg!(debug_assertions) {
        return PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    }

    // Nothing opened yet. An empty directory keeps the server on one code path
    // and lets the window offer the picker — pointing it at $HOME would set a
    // parser pool loose on the entire filesystem.
    let placeholder = app
        .path()
        .app_config_dir()
        .map(|dir| dir.join("no-project"))
        .unwrap_or_else(|_| std::env::temp_dir().join("codemap-no-project"));
    let _ = std::fs::create_dir_all(&placeholder);
    placeholder
}

fn spawn_server(app: &AppHandle) -> Result<(), String> {
    let entry = server_entry(app)?;
    let root = initial_project_root(app);

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
                    let text = String::from_utf8_lossy(&bytes);
                    for line in text.lines() {
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
        .plugin(tauri_plugin_dialog::init())
        .manage(Server::default())
        .invoke_handler(tauri::generate_handler![
            get_server_port,
            pick_project,
            recent_projects,
            remember_project
        ])
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
