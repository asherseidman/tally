/** Schema version history lives in MIGRATIONS; PRAGMA user_version tracks the applied count. */
export const MIGRATIONS: string[] = [
  /* v1: full schema (later-phase columns included now, logic comes later) */
  `
  CREATE TABLE terms (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    is_current INTEGER NOT NULL DEFAULT 0,
    archived_at TEXT
  );
  CREATE TABLE lists (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    term_id INTEGER REFERENCES terms(id)
  );
  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    notes TEXT,
    term_id INTEGER REFERENCES terms(id),
    course TEXT,
    type TEXT NOT NULL DEFAULT 'other' CHECK (type IN ('homework','project','exam','quiz','reading','attendance','other')),
    due_date TEXT,
    time_assumed INTEGER NOT NULL DEFAULT 0,
    grade_weight REAL,
    estimated_minutes INTEGER,
    estimate_source TEXT CHECK (estimate_source IN ('manual','learned','imported')),
    actual_minutes INTEGER,
    status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','done')),
    completed_at TEXT,
    deleted_at TEXT,
    source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('import','manual')),
    import_key TEXT,
    source_quote TEXT,
    import_snapshot TEXT,
    confidence TEXT CHECK (confidence IN ('low','medium','high')),
    expanded_from_recurring INTEGER NOT NULL DEFAULT 0,
    list_id INTEGER REFERENCES lists(id),
    parent_task_id INTEGER REFERENCES tasks(id),
    recurrence_rule TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX idx_tasks_import_key ON tasks(import_key) WHERE import_key IS NOT NULL;
  CREATE INDEX idx_tasks_term ON tasks(term_id);
  CREATE INDEX idx_tasks_due ON tasks(due_date);
  CREATE TABLE dependencies (
    task_id INTEGER NOT NULL REFERENCES tasks(id),
    blocked_by_task_id INTEGER NOT NULL REFERENCES tasks(id),
    PRIMARY KEY (task_id, blocked_by_task_id),
    CHECK (task_id <> blocked_by_task_id)
  );
  CREATE TABLE grading_breakdown (
    term_id INTEGER NOT NULL REFERENCES terms(id),
    course TEXT NOT NULL,
    category TEXT NOT NULL,
    percent REAL NOT NULL,
    PRIMARY KEY (term_id, course, category)
  );
  CREATE TABLE time_sessions (
    id INTEGER PRIMARY KEY,
    task_id INTEGER NOT NULL REFERENCES tasks(id),
    started_at TEXT NOT NULL,
    ended_at TEXT
  );
  CREATE TABLE scheduled_blocks (
    id INTEGER PRIMARY KEY,
    task_id INTEGER NOT NULL REFERENCES tasks(id),
    start TEXT NOT NULL,
    "end" TEXT NOT NULL,
    google_event_id TEXT
  );
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  INSERT INTO settings(key, value) VALUES
    ('timezone', 'America/Detroit'),
    ('default_due_time', '23:59');
  `,
  /* v2: task size + available_from + optional; 'size' estimate source (CHECK needs a table rebuild); availability windows */
  `
  CREATE TABLE tasks_new (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    notes TEXT,
    term_id INTEGER REFERENCES terms(id),
    course TEXT,
    type TEXT NOT NULL DEFAULT 'other' CHECK (type IN ('homework','project','exam','quiz','reading','attendance','other')),
    due_date TEXT,
    time_assumed INTEGER NOT NULL DEFAULT 0,
    grade_weight REAL,
    estimated_minutes INTEGER,
    estimate_source TEXT CHECK (estimate_source IN ('manual','learned','imported','size')),
    actual_minutes INTEGER,
    status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','done')),
    completed_at TEXT,
    deleted_at TEXT,
    source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('import','manual')),
    import_key TEXT,
    source_quote TEXT,
    import_snapshot TEXT,
    confidence TEXT CHECK (confidence IN ('low','medium','high')),
    expanded_from_recurring INTEGER NOT NULL DEFAULT 0,
    list_id INTEGER REFERENCES lists(id),
    parent_task_id INTEGER REFERENCES tasks(id),
    recurrence_rule TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    size_amount REAL,
    size_unit TEXT CHECK (size_unit IN ('pages','video_minutes','problems','items')),
    available_from TEXT,
    optional INTEGER NOT NULL DEFAULT 0
  );
  INSERT INTO tasks_new(id, title, notes, term_id, course, type, due_date, time_assumed, grade_weight, estimated_minutes, estimate_source,
    actual_minutes, status, completed_at, deleted_at, source, import_key, source_quote, import_snapshot, confidence, expanded_from_recurring,
    list_id, parent_task_id, recurrence_rule, created_at, updated_at)
  SELECT id, title, notes, term_id, course, type, due_date, time_assumed, grade_weight, estimated_minutes, estimate_source,
    actual_minutes, status, completed_at, deleted_at, source, import_key, source_quote, import_snapshot, confidence, expanded_from_recurring,
    list_id, parent_task_id, recurrence_rule, created_at, updated_at FROM tasks;
  DROP TABLE tasks;
  ALTER TABLE tasks_new RENAME TO tasks;
  CREATE UNIQUE INDEX idx_tasks_import_key ON tasks(import_key) WHERE import_key IS NOT NULL;
  CREATE INDEX idx_tasks_term ON tasks(term_id);
  CREATE INDEX idx_tasks_due ON tasks(due_date);
  CREATE TABLE availability_windows (
    id INTEGER PRIMARY KEY,
    date TEXT,
    weekday INTEGER CHECK (weekday BETWEEN 1 AND 7),
    start TEXT NOT NULL,
    "end" TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'free' CHECK (kind IN ('free','blocked')),
    CHECK ((date IS NULL) <> (weekday IS NULL))
  );
  CREATE INDEX idx_avail_date ON availability_windows(date);
  CREATE INDEX idx_avail_weekday ON availability_windows(weekday);
  `,
  /* v3: deadline-only tasks (shown with their due date, never scheduled, never listed under NOT SCHEDULED) */
  `ALTER TABLE tasks ADD COLUMN deadline_only INTEGER NOT NULL DEFAULT 0;`,
  /* v4: change history. Every change made on the user's behalf by a connector (Claude over MCP) is recorded with the rows it touched, so it can be listed and undone. */
  `
  CREATE TABLE change_log (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    actor TEXT NOT NULL,
    tool TEXT NOT NULL,
    summary TEXT NOT NULL,
    details TEXT NOT NULL,
    undone_at TEXT
  );
  `,
  /* v5: the connector's call log (what Claude did, last 50 kept) and its hand-off jobs. A schedule preview is computed BY THE APP (it holds the Google access); an apply waits for the user's approval inside the app. The connector only reads and writes these rows. */
  `
  CREATE TABLE connector_calls (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    tool TEXT NOT NULL,
    ok INTEGER NOT NULL,
    detail TEXT NOT NULL
  );
  CREATE TABLE connector_jobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('preview','apply')),
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT,
    request TEXT NOT NULL,
    result TEXT,
    error TEXT
  );
  CREATE INDEX idx_connector_jobs_kind ON connector_jobs(kind, created_at);
  `,
  /* v6: pinned blocks (a block moved or resized by hand: fixed busy time for other tasks, counted toward its task, never moved by the planner),
     the written block's link to its pin, and two more connector job kinds (free time and conflicts, answered by the app with Google busy time). */
  `
  CREATE TABLE pins (
    id INTEGER PRIMARY KEY,
    task_id INTEGER NOT NULL REFERENCES tasks(id),
    start TEXT NOT NULL,
    "end" TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ("end" > start)
  );
  CREATE INDEX idx_pins_task ON pins(task_id);
  ALTER TABLE scheduled_blocks ADD COLUMN pin_id INTEGER;
  CREATE TABLE connector_jobs_new (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('preview','apply','freetime','conflicts')),
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT,
    request TEXT NOT NULL,
    result TEXT,
    error TEXT
  );
  INSERT INTO connector_jobs_new(id, kind, status, created_at, updated_at, expires_at, request, result, error)
    SELECT id, kind, status, created_at, updated_at, expires_at, request, result, error FROM connector_jobs;
  DROP TABLE connector_jobs;
  ALTER TABLE connector_jobs_new RENAME TO connector_jobs;
  CREATE INDEX idx_connector_jobs_kind ON connector_jobs(kind, created_at);
  `,
  /* v7: phone capture through Apple Reminders. One row per reminder ever imported, keyed by Reminders' own id, so a reminder is never imported twice
     (even if marking it completed failed, or sync was slow). The row is written in the same transaction as the task. */
  `
  CREATE TABLE reminder_imports (
    reminder_id TEXT PRIMARY KEY,
    list_name TEXT NOT NULL,
    task_id INTEGER NOT NULL REFERENCES tasks(id),
    change_id INTEGER,
    title TEXT NOT NULL,
    imported_at TEXT NOT NULL,
    completed_at TEXT,
    complete_error TEXT,
    announced_at TEXT
  );
  CREATE INDEX idx_reminder_imports_at ON reminder_imports(imported_at);
  `,
  /* v8: a fifth size unit, "points" (zyBooks-style assignments: the time depends on how many points they are worth). The CHECK on tasks.size_unit needs a table rebuild. Rows and ids are kept. */
  `
  CREATE TABLE tasks_new (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    notes TEXT,
    term_id INTEGER REFERENCES terms(id),
    course TEXT,
    type TEXT NOT NULL DEFAULT 'other' CHECK (type IN ('homework','project','exam','quiz','reading','attendance','other')),
    due_date TEXT,
    time_assumed INTEGER NOT NULL DEFAULT 0,
    grade_weight REAL,
    estimated_minutes INTEGER,
    estimate_source TEXT CHECK (estimate_source IN ('manual','learned','imported','size')),
    actual_minutes INTEGER,
    status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','done')),
    completed_at TEXT,
    deleted_at TEXT,
    source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('import','manual')),
    import_key TEXT,
    source_quote TEXT,
    import_snapshot TEXT,
    confidence TEXT CHECK (confidence IN ('low','medium','high')),
    expanded_from_recurring INTEGER NOT NULL DEFAULT 0,
    list_id INTEGER REFERENCES lists(id),
    parent_task_id INTEGER REFERENCES tasks(id),
    recurrence_rule TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    size_amount REAL,
    size_unit TEXT CHECK (size_unit IN ('pages','video_minutes','problems','items','points')),
    available_from TEXT,
    optional INTEGER NOT NULL DEFAULT 0,
    deadline_only INTEGER NOT NULL DEFAULT 0
  );
  INSERT INTO tasks_new(id, title, notes, term_id, course, type, due_date, time_assumed, grade_weight, estimated_minutes, estimate_source,
    actual_minutes, status, completed_at, deleted_at, source, import_key, source_quote, import_snapshot, confidence, expanded_from_recurring,
    list_id, parent_task_id, recurrence_rule, created_at, updated_at, size_amount, size_unit, available_from, optional, deadline_only)
  SELECT id, title, notes, term_id, course, type, due_date, time_assumed, grade_weight, estimated_minutes, estimate_source,
    actual_minutes, status, completed_at, deleted_at, source, import_key, source_quote, import_snapshot, confidence, expanded_from_recurring,
    list_id, parent_task_id, recurrence_rule, created_at, updated_at, size_amount, size_unit, available_from, optional, deadline_only FROM tasks;
  DROP TABLE tasks;
  ALTER TABLE tasks_new RENAME TO tasks;
  CREATE UNIQUE INDEX idx_tasks_import_key ON tasks(import_key) WHERE import_key IS NOT NULL;
  CREATE INDEX idx_tasks_term ON tasks(term_id);
  CREATE INDEX idx_tasks_due ON tasks(due_date);
  `,
];
