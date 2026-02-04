export const schemaSql = `
CREATE TABLE IF NOT EXISTS macros (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  base_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT
);

CREATE TABLE IF NOT EXISTS macro_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  macro_id INTEGER NOT NULL,
  order_index INTEGER NOT NULL,
  action_type TEXT NOT NULL,
  locators TEXT,
  value TEXT,
  timeouts TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (macro_id) REFERENCES macros(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  macro_id INTEGER NOT NULL,
  env_name TEXT NOT NULL,
  browser TEXT NOT NULL,
  headless INTEGER NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  status TEXT,
  summary TEXT,
  FOREIGN KEY (macro_id) REFERENCES macros(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS run_step_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  step_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  error_message TEXT,
  used_locator TEXT,
  screenshot_path TEXT,
  artifact_refs TEXT,
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE,
  FOREIGN KEY (step_id) REFERENCES macro_steps(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  storage_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);
`;
