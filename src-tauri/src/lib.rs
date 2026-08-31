mod store;

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, RunEvent, State, WebviewWindow, WindowEvent,
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

use store::{Store, WindowState};

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

/// The window's last known geometry, tracked in memory and written once on exit.
/// Persisting on every resize event would be a database write per frame of a drag.
#[derive(Default)]
struct Geometry(Mutex<Option<WindowState>>);

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

#[tauri::command]
fn recent_projects(store: State<Store>) -> Vec<String> {
    // Hidden, never deleted. `is_dir()` is false for an unmounted volume, a
    // path we lack permission to stat, or a cloud placeholder — none of which
    // mean the project is gone, and a row carries settings that are not
    // recoverable once dropped. The list is capped, so stale rows cost nothing.
    store
        .recent_projects(MAX_RECENTS)
        .into_iter()
        .filter(|path| PathBuf::from(path).is_dir())
        .collect()
}

#[tauri::command]
fn remember_project(store: State<Store>, path: String) -> Vec<String> {
    store.remember_project(&path);
    store.recent_projects(MAX_RECENTS)
}

#[tauri::command]
fn project_settings(store: State<Store>, path: String) -> serde_json::Value {
    serde_json::from_str(&store.project_settings(&path)).unwrap_or_else(|_| serde_json::json!({}))
}

#[tauri::command]
fn set_project_settings(store: State<Store>, path: String, settings: serde_json::Value) {
    store.set_project_settings(&path, &settings.to_string());
}

/// Editor deep links. The scheme is allowlisted rather than trusted: the webview
/// hands this a string, and "open whatever you are given" is how a page turns
/// into a way to launch things.
#[tauri::command]
fn open_in_editor(app: AppHandle, url: String) -> Result<(), String> {
    const ALLOWED: [&str; 2] = ["vscode://", "cursor://"];
    if !ALLOWED.iter().any(|scheme| url.starts_with(scheme)) {
        return Err(format!("refusing to open {url}"));
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| error.to_string())
}

// --- window state --------------------------------------------------------

/// A saved position can point at a monitor that is no longer attached, which
/// would restore the window somewhere the user cannot reach it.
fn position_is_visible(window: &WebviewWindow, x: i32, y: i32) -> bool {
    let Ok(monitors) = window.available_monitors() else {
        return false;
    };
    monitors.iter().any(|monitor| {
        let origin = monitor.position();
        let size = monitor.size();
        x >= origin.x
            && y >= origin.y
            && x < origin.x + size.width as i32
            && y < origin.y + size.height as i32
    })
}

fn apply_window_state(window: &WebviewWindow, state: WindowState) {
    // Logical, not physical: the same window moved between a Retina and an
    // external display would otherwise double or halve on every launch.
    let _ = window.set_size(LogicalSize::new(state.width, state.height));

    if let (Some(x), Some(y)) = (state.x, state.y) {
        if position_is_visible(window, x, y) {
            let _ = window.set_position(LogicalPosition::new(x, y));
        }
    }
    if state.maximized {
        let _ = window.maximize();
    }
    log::info!(
        "restored window {}x{} at {:?},{:?} (maximized: {})",
        state.width,
        state.height,
        state.x,
        state.y,
        state.maximized
    );
}

fn record_geometry(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Ok(size) = window.inner_size() else {
        return;
    };
    let scale = window.scale_factor().unwrap_or(1.0);
    let logical = size.to_logical::<f64>(scale);
    let position = window
        .outer_position()
        .ok()
        .map(|p| p.to_logical::<f64>(scale));

    let maximized = window.is_maximized().unwrap_or(false);

    // Bound first: the State guard must outlive the borrow of what it holds.
    let geometry = app.state::<Geometry>();
    let Ok(mut slot) = geometry.0.lock() else {
        return;
    };

    if maximized {
        // Maximizing fires a Resized carrying the maximized frame. Recording it
        // would destroy the size the user un-maximizes back to, so only the flag
        // is taken and the last un-maximized geometry is left alone.
        match slot.as_mut() {
            Some(existing) => existing.maximized = true,
            None => {
                *slot = Some(WindowState {
                    width: logical.width.round() as u32,
                    height: logical.height.round() as u32,
                    x: position.map(|p| p.x.round() as i32),
                    y: position.map(|p| p.y.round() as i32),
                    maximized: true,
                })
            }
        }
        return;
    }

    *slot = Some(WindowState {
        width: logical.width.round() as u32,
        height: logical.height.round() as u32,
        x: position.map(|p| p.x.round() as i32),
        y: position.map(|p| p.y.round() as i32),
        maximized: false,
    });
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
    if let Some(recent) = app
        .state::<Store>()
        .recent_projects(MAX_RECENTS)
        .into_iter()
        .find(|path| PathBuf::from(path).is_dir())
    {
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

    // Launching into a project counts as using it. Without this only an
    // explicit switch moved a project up the list, so the order drifted away
    // from what "recent" means.
    app.state::<Store>().remember_project(&root.to_string_lossy());

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
        .plugin(tauri_plugin_opener::init())
        .manage(Server::default())
        .manage(Geometry::default())
        .invoke_handler(tauri::generate_handler![
            get_server_port,
            pick_project,
            recent_projects,
            remember_project,
            project_settings,
            set_project_settings,
            open_in_editor
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let directory = app.path().app_config_dir()?;
            app.manage(Store::open(&directory)?);

            if let Some(window) = app.get_webview_window("main") {
                if let Some(saved) = app.state::<Store>().window_state() {
                    apply_window_state(&window, saved);
                }

                // Recorded once up front, not only on the first move or resize:
                // a window that is never touched would otherwise have nothing to
                // save on quit, and its size would silently never persist.
                record_geometry(app.handle());

                let handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if matches!(event, WindowEvent::Resized(_) | WindowEvent::Moved(_)) {
                        record_geometry(&handle);
                    }
                });
            }

            spawn_server(app.handle())?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Ok(slot) = app.state::<Geometry>().0.lock() {
                    if let Some(state) = *slot {
                        app.state::<Store>().save_window_state(state);
                    }
                }
                // Killing the child explicitly, rather than relying on the pipe
                // closing, so a clean quit never leaves a Node process behind.
                if let Ok(mut child) = app.state::<Server>().child.lock() {
                    if let Some(child) = child.take() {
                        let _ = child.kill();
                    }
                }
            }
        });
}
