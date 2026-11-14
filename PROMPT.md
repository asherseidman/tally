I'm building a standalone personal to-do and planner app for myself, a college student. It will be an Electron desktop app with its own SQLite database. It is NOT built on top of TickTick or any other task app, and it does NOT call any LLM. There are no LLM API keys anywhere in this project. Claude extracts syllabi separately and gives me JSON files; the app only imports them. The only external service is Google Calendar.

## How we work (important)
- Start in plan mode: read this whole prompt, ask me clarifying questions, and show me a plan for Phase 1 before writing code.
- There are 5 phases. Build ONE phase at a time. At the end of each phase: run the tests, update CLAUDE.md and README.md, commit, then STOP. Give me a short summary of what works, what's flagged or uncertain, and how to try it. Do not begin the next phase until I say "continue."
- At the start of each new phase, briefly re-plan it and flag anything that conflicts with earlier decisions.
- Never build features from a later phase early. Include later-phase schema columns now, but no logic for them.
- Write tests for pure logic (recurrence, date parsing, dedupe/diffing, scheduling, cycle detection, multipliers, priority scoring) BEFORE the implementation.
- Commit after each working milestone with clear messages.
- Keep CLAUDE.md as the source of truth for goals, stack, conventions, and current phase status. It must include a short decision log (what we decided and why), so a fresh session can pick up cold.
- Do not rely on memory for third-party API details (Google OAuth, Calendar API, Electron security, native module rebuilds). Check current docs.
- Provide `seed` and `demo` commands that load fake data (clearly marked as demo, in a separate database file), so I can try every phase without touching real deadlines.

## Stack
Node.js + TypeScript, SQLite via better-sqlite3, zod for validation, vitest (or similar) for tests. Phase 5 adds Electron + React + Vite (or the simplest setup you recommend). Ask me whether imports/ and samples/ are committed to git, since they contain my coursework.

better-sqlite3 is a native module and must work under both plain Node (tests, CLI) and Electron's runtime. Keep the DB layer isolated behind a clean interface, and set up and verify the Electron rebuild step in Phase 1 so Phase 5 doesn't surprise us.

## Multi-term design (applies to everything)
The app must work across many terms, not just my first one. Never hardcode a term, year, semester name, or date anywhere in code or defaults. Terms are data. My first term is Fall 2026 (classes started Aug 31, 2026), but that value may only appear in my data and test fixtures, never in logic.

## Time handling (applies to everything)
- Store all timestamps in UTC, plus an IANA timezone setting (default America/Detroit) that I can change. Interpret natural-language dates and display times in that timezone.
- Items with a date but no stated time get a configurable default time (default 11:59 PM), and are flagged time_assumed = true so the UI can show it.
- Recurrence must be correct across daylight saving changes.
- All "now" logic (scheduler, recurrence, views, backups) uses an injectable clock, so tests never depend on the real date.

## Database schema (create all tables and columns in Phase 1)
terms: id, name (e.g. "Fall 2026"), start_date, end_date, is_current, archived_at (nullable)
tasks: id, title, notes, term_id (nullable; null for non-school tasks), course (nullable), type (homework|project|exam|quiz|reading|attendance|other), due_date (nullable, UTC), time_assumed (boolean), grade_weight (nullable), estimated_minutes (nullable), estimate_source (manual|learned|imported, nullable), actual_minutes (nullable), status (todo|in_progress|done), completed_at (nullable), deleted_at (nullable), source (import|manual), import_key (nullable, immutable), source_quote (nullable), list_id (nullable), parent_task_id (nullable), recurrence_rule (nullable), created_at, updated_at
lists: id, name, term_id (nullable; null means the list spans terms, e.g. "Personal" or "Clubs")
dependencies: task_id, blocked_by_task_id
grading_breakdown: term_id, course, category, percent
time_sessions: id, task_id, started_at, ended_at
scheduled_blocks: id, task_id, start, end, google_event_id
settings: key, value (timezone, default due time, working hours, current term, priority formula constants, backup folder, etc.)

---

## PHASE 1: Import format, review step, database
Goal: a validated import format, a terminal review flow with diffing, and the database.

Import format (one JSON file per course or batch):
- term (required): name, start_date, end_date. On import, the app finds the matching term or creates it.
- items[]: course, title, type, due_date (ISO 8601 with time if stated, else date only or null), grade_weight (percent or null), notes (nullable), source_quote (nullable), confidence (low|medium|high, default medium), expanded_from_recurring (boolean, default false), estimated_minutes (optional)
- grading_breakdown[]: category, percent
- Write docs/IMPORT_FORMAT.md describing the format with an example file, so I can paste it to Claude and ask for files in exactly this shape. Include these extraction rules in it:
  - Fill in the term from the syllabus.
  - Never invent dates (use null and confidence low).
  - Expand recurring items (e.g. "weekly homework due Sunday 11:59 PM") into individual dated tasks and flag them, using the term's start and end dates rather than assuming any particular semester.
  - When a syllabus and a schedule disagree, use the schedule's date, mark confidence low, and note the conflict in source_quote.
  - grade_weight is the item's OWN share of the final grade, not its category's. Divide a category's percent across its items (e.g. 15% across 11 counted homeworks is about 1.4% each). If the syllabus drops the lowest scores, say so in notes. Record the full category percent in grading_breakdown.

Workflow:
1. `npm run import <file.json>` validates with zod; failures print readable errors naming the exact item and field.
2. Each imported task gets an immutable import_key (a hash of term + course + a normalized original title) that survives later edits. This replaces title+due_date as the dedupe key, so a changed date doesn't create a duplicate and renaming a task in the app doesn't cause a re-import to recreate it.
3. Show a numbered terminal review list sorted by date, low-confidence items highlighted. On re-import, show a diff grouped as: new, changed (e.g. date moved), unchanged, and in the database but missing from the file.
4. I can edit, delete, or approve items. Nothing is written to the DB until I approve. Changed items are applied only if I approve them, and my manual edits to other fields are never overwritten.

Structure: src/import/, src/db/, src/cli/, docs/IMPORT_FORMAT.md, samples/, imports/, CLAUDE.md, README.md.

Phase 1 is done when: a sample file validates and appears in review; approved items land in SQLite with the correct term; re-importing the same file creates no duplicates; a re-import with a moved date shows as "changed," not as a new task; renaming a task locally doesn't break re-import matching; importing the same course into a different term creates separate tasks; bad files give clear errors; better-sqlite3 is verified under both Node and Electron; IMPORT_FORMAT.md is complete enough for Claude to produce valid files; and tests pass. Then STOP.

## PHASE 2: Core to-do features, terms, estimates, timer, backups
Goal: a fully usable CLI to-do app.
- Add, edit, delete, complete, and un-complete tasks manually (title, notes, due date/time, list, course, type, estimate). Quick-add syntax like `add "Read ch. 3" --due fri 5pm --list Math --est 45`, with natural-language dates via a well-maintained date parsing library, interpreted in my configured timezone.
- Lists: create, rename, delete, move tasks between lists; imported tasks can group by course. Lists can be tied to a term or span terms.
- Recurring tasks (daily, weekly, custom days): completing one creates the next occurrence.
- Search and filter by list, course, status, due range, text.
- Term management: commands to list, create, switch the current term, and archive a term. Archiving hides a term's tasks from default views, search, and the scheduler but keeps them in the database. Never delete a term's data.
- All default views, filters, and the scheduler operate on the current term plus tasks with no term. A `--term <name>` flag or `--all-terms` overrides this.
- Soft-delete with undo (never permanent delete by default).
- Data safety (this database is my only copy of my tasks, so it's a priority):
  - Use WAL mode and better-sqlite3's online backup API, never a raw file copy.
  - A `backup` command, plus automatic daily backups keeping the last 14. Backups include everything, including archived terms.
  - The backup folder is configurable, so I can point it at a cloud-synced folder (a backup on the same disk doesn't protect against losing the laptop).
  - Verify each backup by opening it and running an integrity check; report failures loudly.
  - An `export` command that dumps everything to JSON and to an .ics file, so I'm never locked in.
  - A `restore` command with a confirmation step.
- Timer: `npm run timer <task id>` starts a timer, stops on a keypress, records a time_sessions row, and sets actual_minutes to the sum of sessions.
- Learning: per task type, compute the ratio of actual to estimated minutes from completed tasks across ALL terms (more history means better accuracy). A command shows my multiplier per type (e.g. homework: 1.4x), and a function applies it to a new estimate only after at least 3 samples for that type. No ML, just ratios.

Phase 2 is done when all commands work and tests cover recurrence (including across DST), date parsing edge cases, term switching and archiving, soft-delete/undo, backup + integrity check + restore, export, and the multiplier math. Then STOP.

TRIAL GATE: SKIPPED by my choice. I accepted Phase 2 without the planned week of real-world use, so there is no trial gate before Phase 3. (Original intent: use the CLI app for real work for about a week, and if I report friction, fix the design before building more on top of it. If friction shows up later, we fix it then.)

## PHASE 3: Google Calendar and auto-scheduling
- Before writing any Phase 3 code, walk me through creating the Google Cloud project and OAuth credentials step by step. Check whether my school Google account allows third-party OAuth apps. If it doesn't, use a personal Google account whose calendar my school calendar is shared into.
- Google Calendar API with OAuth for a local desktop app, minimum scopes (check current docs). Note that projects in "Testing" mode issue refresh tokens that expire after about 7 days, so handle expired or revoked tokens with a clear "reconnect" message instead of failing. Store tokens in the OS keychain (Electron safeStorage when in Electron; an equivalent secure store in the CLI), never in the repo or a plain file.
- Read my calendars for busy/free time only. Write scheduled blocks ONLY to a dedicated calendar named "Planner Blocks" that the app creates. Never edit or delete events on my other calendars.
- Config file for working hours: earliest start, latest end, per-day overrides, min block length (e.g. 25 min), max block length (e.g. 120 min), buffer between blocks. Working hours are global, with optional per-term overrides since my schedule changes each semester. Tasks longer than the max are split into multiple blocks.
- Scheduler input: tasks from the current term plus term-less tasks, with estimated_minutes (apply the learned multiplier when available), due dates, grade weights, and free/busy time. Tasks with no estimate or no due date are skipped and listed so I know why.
- Greedy algorithm: sort by deadline then grade weight; place each task as late as possible before its deadline but never in the past, leaving slack before the due date. If a task can't fit, report it clearly instead of dropping it.
- `npm run schedule --dry-run` prints the proposed plan; `--apply` writes the blocks. Re-running replaces my earlier Planner blocks rather than duplicating them.
- `npm run replan`: when incomplete tasks have blocks in the past, re-place them in the next free slots and tell me what moved.

Phase 3 is done when dry-run output is readable, apply writes only to Planner Blocks, replan works, term scoping works, expired-token handling works, and tests cover slot-finding and splitting with fake calendar data and the injectable clock. Then STOP.

## PHASE 4: Dependencies, plan import, computed views
- Dependencies: CLI commands to add/remove "task A is blocked by task B", with cycle detection. Blocked tasks are not scheduled until their blockers are complete; completing a blocker unblocks dependents automatically.
- Plan import: extend the import format with an optional plan section, a list of steps for a parent task (an exam or project), each with title, estimated_minutes, due_date (optional), and depends_on (references to other steps by index). Update IMPORT_FORMAT.md with this section and an example so I can ask Claude to generate a study or work plan in this shape. Importing a plan file shows the steps for review and editing, then saves them as real tasks in the parent task's term, with dependencies wired and the parent task linked. Imported estimates get estimate_source = imported. Plan steps get import_keys too, so re-importing a revised plan diffs cleanly.
- Computed views replacing the Eisenhower matrix (nothing sorted by hand): Due Soon (next 72 hours), High Grade Impact, Quick Wins (estimate 20 minutes or less, unblocked), Blocked (with what's blocking each). Implement as one query layer the UI can reuse, scoped to the current term by default, plus `npm run views` to print all four on one screen.
- High Grade Impact: BEFORE implementing, show me a proposed priority formula (using grade_weight, deadline proximity, and remaining estimated effort) for approval. It must be simple, documented in CLAUDE.md, and have configurable constants in settings. Every ranked item shows a one-line plain-English reason (e.g. "worth 5%, due in 2 days, ~3 hours of work").

Phase 4 is done when dependencies and cycle detection are tested, blocked tasks are excluded from scheduling, plan files import correctly, the four views print correctly with reasons, and the formula is documented. Then STOP.

## PHASE 5: Electron desktop app
- Do not rewrite the engine. The UI calls existing modules through a thin IPC layer; business logic stays out of UI code. The Electron main process owns the database and all network calls. The renderer never touches secrets. Use contextIsolation and a minimal preload API.
- Required because this is my only to-do app: a global quick-add shortcut that opens a small capture window from anywhere; desktop notifications for due dates and for scheduled blocks starting; keyboard-first navigation; a system tray/menu bar icon with today's tasks and a running timer; a visible "last backup" indicator with a restore option; a term switcher in the header.
- Screens: (1) Today/Dashboard with the four computed views side by side, each task showing course, due date (with an indicator when the time was assumed), estimate, the reason line, and a Start Timer button; (2) Lists, with add/edit/complete/delete and drag-to-reorder; (3) Import: pick a JSON file (task batch or plan), validate, and review the diff (new/changed/unchanged/missing) with edit/approve, plus a link to IMPORT_FORMAT.md so I can copy the format to give Claude (no extraction or LLM calls in the app); (4) Task detail: edit everything, dependencies, notes; (5) Schedule: proposed plan with Apply and Replan buttons plus tasks that don't fit; (6) Settings: timezone, default due time, working hours (global and per-term), block lengths, priority formula constants, Google connection, backups and backup folder, and a Terms section to create, switch, and archive terms; (7) Archived terms browser, read-only by default.

- **Availability grid (added 2026-11-10; required):** a weekly calendar grid, Mon-Sun columns, 30-minute rows, about 6 AM to midnight. I click-drag to paint free time and drag to erase. It shows my busy Google events (read-only, grey) and my Planner Blocks (blue) on the same grid. Week navigation, a "repeat weekly" toggle that edits the weekly template instead of one date, per-date edits, undo, and keyboard support (arrow keys to move, space/enter to paint or erase, shift to extend). A Reschedule button runs a dry run and overlays the proposed blocks on the grid. It saves through IPC to the same `availability_windows` tables the CLI (`availability set|clear|copy-week|show`) uses, calling the same core functions (`setWindow`, `clearDate`, `copyWeek`); there is no business logic in the UI.

Phase 5 is done when `npm run dev` opens the app and every screen works against the real database, `npm run build` produces a packaged app for my OS, better-sqlite3 works in the packaged build, and errors show readable messages instead of failing silently. Commit after each screen.

---

Begin now: ask your clarifying questions for Phase 1, then show me the plan.
