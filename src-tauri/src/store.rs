use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};

/// What the desktop shell remembers between launches.
///
/// SQLite rather than a pile of JSON files because the next feature after this
/// phase is session diff (VISION.md, phase 1), which records many rows per
/// project over time and wants to query them by project and by time.
///
/// The schema is shaped for that now, so it arrives without a migration:
/// `project` carries a surrogate `id` from day one purely so a later
/// `session(project_id REFERENCES project(id))` can be added with a foreign key
/// and nothing to back-fill. Storing recents as a bare list of paths — which is
/// all this phase needs — would have forced exactly that rewrite later.
pub struct Store {
    connection: Mutex<Connection>,
}

const SCHEMA_VERSION: i64 = 1;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS project (
  id          INTEGER PRIMARY KEY,
  path        TEXT    NOT NULL UNIQUE,
  last_opened INTEGER NOT NULL,
  -- Read and written whole, for one project at a time, and open-ended in a way
  -- a column per setting is not. Never queried across projects.
  settings    TEXT    NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS project_last_opened ON project (last_opened DESC);

CREATE TABLE IF NOT EXISTS window_state (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  width     INTEGER NOT NULL,
  height    INTEGER NOT NULL,
  x         INTEGER,
  y         INTEGER,
  maximized INTEGER NOT NULL DEFAULT 0
);
";

/// Logical pixels, not physical: the same window moved between a Retina and an
/// external display must come back the same size, not twice or half it.
#[derive(Clone, Copy, Debug, serde::Serialize, serde::Deserialize)]
pub struct WindowState {
    pub width: u32,
    pub height: u32,
    pub x: Option<i32>,
    pub y: Option<i32>,
    pub maximized: bool,
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

impl Store {
    pub fn open(directory: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(directory).map_err(|e| e.to_string())?;
        let connection = Connection::open(directory.join("codemap.db")).map_err(|e| e.to_string())?;

        // WAL so a reader is never blocked by a write, and foreign keys on so the
        // session tables that come later actually enforce their references.
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| e.to_string())?;
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| e.to_string())?;
        connection.execute_batch(SCHEMA).map_err(|e| e.to_string())?;

        let version: Option<i64> = connection
            .query_row("SELECT version FROM schema_version", [], |row| row.get(0))
            .optional()
            .map_err(|e| e.to_string())?;
        if version.is_none() {
            connection
                .execute("INSERT INTO schema_version (version) VALUES (?1)", params![SCHEMA_VERSION])
                .map_err(|e| e.to_string())?;
        }

        let store = Self { connection: Mutex::new(connection) };
        store.import_legacy_recents(directory);
        Ok(store)
    }

    /// Item 3 kept recents in a JSON file. Move them across once, then remove it,
    /// so the two cannot drift apart.
    fn import_legacy_recents(&self, directory: &Path) {
        let legacy: PathBuf = directory.join("recent-projects.json");
        let Ok(raw) = std::fs::read_to_string(&legacy) else {
            return;
        };
        let Ok(paths) = serde_json::from_str::<Vec<String>>(&raw) else {
            return;
        };

        // Distinct, descending timestamps rather than one call per path: a
        // whole import lands inside the same second, and equal timestamps would
        // leave the recency order to whatever SQLite happened to return.
        let base = now();
        for (index, path) in paths.into_iter().enumerate() {
            self.remember_project_at(&path, base - index as i64);
        }
        let _ = std::fs::remove_file(legacy);
    }

    pub fn recent_projects(&self, limit: usize) -> Vec<String> {
        let Ok(connection) = self.connection.lock() else {
            return Vec::new();
        };
        let Ok(mut statement) =
            // id breaks a tie, so two projects opened in the same second still
            // come back in a stable, sensible order rather than an arbitrary one.
            connection.prepare("SELECT path FROM project ORDER BY last_opened DESC, id DESC LIMIT ?1")
        else {
            return Vec::new();
        };
        let rows = statement.query_map(params![limit as i64], |row| row.get::<_, String>(0));
        rows.map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    pub fn remember_project(&self, path: &str) {
        self.remember_project_at(path, now());
    }

    fn remember_project_at(&self, path: &str, when: i64) {
        let Ok(connection) = self.connection.lock() else {
            return;
        };
        // Settings survive a re-open: only last_opened moves.
        let _ = connection.execute(
            "INSERT INTO project (path, last_opened) VALUES (?1, ?2)
             ON CONFLICT(path) DO UPDATE SET last_opened = excluded.last_opened",
            params![path, when],
        );
    }

    pub fn project_settings(&self, path: &str) -> String {
        let Ok(connection) = self.connection.lock() else {
            return "{}".into();
        };
        connection
            .query_row("SELECT settings FROM project WHERE path = ?1", params![path], |row| {
                row.get::<_, String>(0)
            })
            .optional()
            .ok()
            .flatten()
            .unwrap_or_else(|| "{}".into())
    }

    pub fn set_project_settings(&self, path: &str, settings: &str) {
        let Ok(connection) = self.connection.lock() else {
            return;
        };
        let _ = connection.execute(
            "INSERT INTO project (path, last_opened, settings) VALUES (?1, ?2, ?3)
             ON CONFLICT(path) DO UPDATE SET settings = excluded.settings",
            params![path, now(), settings],
        );
    }

    pub fn window_state(&self) -> Option<WindowState> {
        let connection = self.connection.lock().ok()?;
        connection
            .query_row(
                "SELECT width, height, x, y, maximized FROM window_state WHERE id = 1",
                [],
                |row| {
                    Ok(WindowState {
                        width: row.get::<_, i64>(0)? as u32,
                        height: row.get::<_, i64>(1)? as u32,
                        x: row.get::<_, Option<i64>>(2)?.map(|v| v as i32),
                        y: row.get::<_, Option<i64>>(3)?.map(|v| v as i32),
                        maximized: row.get::<_, i64>(4)? != 0,
                    })
                },
            )
            .optional()
            .ok()
            .flatten()
    }

    pub fn save_window_state(&self, state: WindowState) {
        let Ok(connection) = self.connection.lock() else {
            return;
        };
        let _ = connection.execute(
            "INSERT INTO window_state (id, width, height, x, y, maximized)
             VALUES (1, ?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET
               width = excluded.width, height = excluded.height,
               x = excluded.x, y = excluded.y, maximized = excluded.maximized",
            params![
                state.width as i64,
                state.height as i64,
                state.x.map(|v| v as i64),
                state.y.map(|v| v as i64),
                i64::from(state.maximized)
            ],
        );
    }
}
