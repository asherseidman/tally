# Tally connector for Claude (MCP)

A small local program that lets Claude (the desktop app or Claude Code) read your Tally data and, only if you allow it, make a short list of changes. It is **not** part of the app's window and it makes **no LLM calls and holds no API key**: Claude calls *it*.

- Runs over **stdio**, started by the Claude client. No network port, nothing listens.
- Opens your database next to the running Tally app (SQLite WAL, with a busy timeout), so both can run at once.
- **Never talks to Google and never holds a Google token.** Schedule previews are computed by the Tally *app* (it reads your calendars; the connector only files a request in the database and reads the answer). Writing a schedule to Google needs **your approval inside the app** (section 4).
- Has no tool for restoring a backup, changing settings, editing availability, changing a task's term, or connecting or disconnecting Google. Those **do not exist** in it.

## 1. Build it and get your config

```
cd ~/todo-planner
npm run build:mcp            # makes dist-mcp/tally-mcp.mjs (rerun after you update the code)
npm run mcp:config -- --demo # config for the DEMO database  (try this first)
npm run mcp:config           # config for your REAL database
```

`mcp:config` prints both snippets below with the right absolute paths for this Mac (Claude starts the connector without your shell, so `node` must be a full path).

### Which database: it can't be guessed
There is **no default database**. The config must set two environment variables, and the connector refuses to start if they disagree:

| variable | meaning |
|---|---|
| `TALLY_MCP_DB` | absolute path of the database file |
| `TALLY_MCP_EXPECT` | what you believe that file is: `real`, `demo` or `test` |

Real file with `demo` (or the demo file with `real`) → it refuses to start and says why. It never creates a database. At start-up it prints, on stderr, `[tally-mcp] REAL database: <path>` (or DEMO / TEST), and `tally_status` (and Claude's connection instructions) repeat it, so Claude can tell you which one it is on.

The connector never upgrades a database. If the file is from an older Tally it says so (this release adds database version 5: the connector's call log and its hand-off table); open Tally (or `npm run plan -- doctor`) once, which takes a verified backup first and upgrades it, then reconnect.

### Claude desktop app
Settings, Developer, Edit Config opens `~/Library/Application Support/Claude/claude_desktop_config.json`. Add the server inside `"mcpServers"` (create that key if it's missing), then **quit and reopen Claude**:

```json
{
  "mcpServers": {
    "tally-demo": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/Users/YOU/todo-planner/dist-mcp/tally-mcp.mjs"],
      "env": {
        "TALLY_MCP_DB": "/Users/YOU/Library/Application Support/todo-planner/demo.db",
        "TALLY_MCP_EXPECT": "demo"
      }
    }
  }
}
```
For your real data use the name `tally`, `planner.db` and `"TALLY_MCP_EXPECT": "real"` (`npm run mcp:config` prints it). Use different names so the two can sit side by side.

### Claude Code
One command (also printed by `mcp:config`), then `/mcp` inside Claude Code to see it connected:

```
claude mcp add tally-demo --scope user \
  -e TALLY_MCP_DB="$HOME/Library/Application Support/todo-planner/demo.db" -e TALLY_MCP_EXPECT=demo \
  -- /opt/homebrew/bin/node $HOME/todo-planner/dist-mcp/tally-mcp.mjs
```

### Running it by hand
`npm run mcp:demo` / `npm run mcp` start it (via tsx) with the right variables for the demo / real database. It speaks MCP on stdin/stdout, so on its own it just waits; it's for a client to start. `npm run smoke:mcp` runs the built connector against the demo database as a client would, including the demo Tally app answering previews and approving/rejecting an apply request. It flips the three switches in the DEMO database and turns them off again.

## 2. Reading is always on; everything else is behind three switches (all OFF by default)

In **Tally, Settings, General, Claude connector** (each has a plain explanation under it):

| switch | what it lets Claude do |
|---|---|
| **Allow Claude to change my tasks** | add, edit, finish, reopen and reorganize tasks and lists, add steps and dependencies, log work, run the timer, confirm an import you previewed |
| **Allow Claude to delete tasks** | delete **one** task at a time (soft delete, undoable). Also needs the switch above |
| **Allow Claude to apply schedules to Google** | *ask* for a schedule to be written. Nothing is written until you click **Approve** on the Schedule screen |

Each is read fresh on every call, so turning one on or off takes effect at once while Claude is connected. Claude has no tool that can change a switch. With a switch off, the matching tools answer with a plain sentence naming the switch and change nothing. The same Settings section lists **recent changes (with Undo)** and **the last 50 connector calls** (tool, time, result), so you can see what Claude did.

## 3. The tools (29)

Read (always allowed):

| tool | what it returns |
|---|---|
| `tally_status` | which database (real/demo/test), the three switches, today, time zone, current term, counts. Call first. |
| `list_tasks` | tasks, soonest due first. Filters: `term`, `all_terms`, `course`, `list`, `status`, `due_after`, `due_before` (dates or plain words), `text`, `limit` (max 100). Each task has `updatedAt`. |
| `get_task` | one task in full (with `updatedAt`), what blocks it and what it blocks, steps, parent, recent time entries. |
| `get_views` | Due soon, High grade impact, Quick wins, Blocked, with reasons, plus running timers. |
| `get_schedule` | the planned blocks Tally has stored, each marked `pinned` if you placed it by hand, plus `pinnedNotOnCalendarYet`. `include_google: true` adds `conflicts`: planned blocks that overlap busy time on your Google calendars (`overlapMinutes`), never saying what the busy time is. |
| `get_free_time` | by default: availability windows by day, Tally blocks inside them (with `pinned`), free minutes left; Google events not included. `include_google: true`: Tally computes availability minus Google busy time (free/busy only, the scheduler's calendars) minus planned blocks and returns **free intervals only**: no titles, attendees or calendar names. |
| `get_settings` | scheduling and priority values, the estimate rates (yours first, then built-in, in the order they are tried; kinds `per_unit`, `per_assignment` for a flat time per task, `no_rate`), time zone, default due time, the three switches. No calendar IDs, paths, tokens or secrets. |
| `get_timer` | the running timer (task, start, minutes elapsed). A timer running **more than 8 hours** is flagged (`runningOverLimit` and a `warning`). |
| `preview_schedule` / `preview_replan` | what the Schedule screen would show: `blocks`, `tentative`, `moved` / `trimmed` / `workAlreadyLogged` lines, `doesNotFit`, `notScheduled`, the calendar name, plus a `previewId` and `previewedAt`. Writes nothing. **Tally must be open** (it computes them). |
| `get_review` | what the weekly review screen shows, read only: blocks and due items since the last review, overdue and slipped tasks, tasks due in 14 days with no estimate / size or an assumed due time, and the last review date. Claude cannot answer the review or mark it done: that happens in Tally. |
| `get_pending_apply` | where the most recent apply request stands: `pending`, `applied`, `rejected`, `expired`, `stale`, `cancelled` or `failed`. |
| `import_dry_run` | validates an import file and returns the diff. Writes nothing; returns a `diff_id`. |

Write, behind **change my tasks**:

| tool | what it does |
|---|---|
| `add_task` | adds a task; a date at the end of the title is understood ("read ch 3 fri 5pm"). Optional `size` `{amount, unit}` (e.g. 100 points) gives a size-based estimate unless `estimate_minutes` is set. |
| `edit_task` | title, notes, list (or `"none"`), course (or `"none"`), type, `grade_weight` (or null), `optional`, `deadline_only`, `available_from` (or `"none"`), `size` `{amount, unit}` (unit: pages, video_minutes, problems, items or points; or null), `estimate_minutes` (or null), `due` (or `"none"`). Needs `read_updated_at` (below). |
| `create_list`, `rename_list`, `move_task_to_list` | lists. `move_task_to_list` also needs `read_updated_at`. Lists can't be deleted. |
| `add_step` | a child step under a parent task (it takes the parent's term, course and list; one level). |
| `add_dependency`, `remove_dependency` | `task` waits on / stops waiting on `blocked_by`; cycles are refused. |
| `mark_done`, `reopen_task`, `log_work` | finish / reopen / "I already worked N minutes". |
| `start_timer`, `stop_timer` | one timer at a time, as in the app: starting stops and records the running one; stopping records the session exactly as the app does. The Tally window and menu-bar icon show it within a few seconds. |
| `import_confirm` | writes the import previewed by `import_dry_run`, same `diff_id`. |

Behind **delete tasks** (plus change my tasks): `delete_task` `{id, force?}`. One task, soft delete (the same as the app's). Refused if other **open** tasks are waiting on it, unless you pass `force: true`; a forced delete is recorded and undoable like any other. There is no bulk delete, list delete or term delete.

Behind **apply schedules**: `apply_schedule` `{preview_id}`: see the next section.

### Editing is optimistic
`edit_task` and `move_task_to_list` require `read_updated_at`: the task's `updatedAt` exactly as Claude read it (`get_task` / `list_tasks`). If the task was changed in Tally since, the call is refused with "Task #N was changed in Tally after you read it… Nothing was changed. Read it again", and nothing is written. An estimate Claude sets is a **manual** one and stays manual; changing a size never replaces a manual estimate. **Not editable:** a task's term, import keys, ids. (Giving a term-less task a course would attach it to the current term, so that is refused too.)

### Import: two calls, same diff id
1. `import_dry_run` with the file → the diff and a `diff_id`. Nothing is written.
2. After you've seen the diff, `import_confirm` with that `diff_id`. Refused if the id is unknown or used, or if your tasks changed since the dry run (run it again). A verified backup is taken after a real import.

### Limits
Unknown arguments are rejected (no silent extras). Titles ≤ 300 characters, notes ≤ 5000, other text ≤ 100-200, `limit` ≤ 100, minutes ≤ 1440 per log (estimates ≤ 10080), schedule `days` 1-60, ids are positive whole numbers, an import file ≤ 1,000,000 characters. Over the limit is refused, never truncated.

### Google busy time, without titles (`include_google`)
The connector still never contacts Google. With `include_google: true`, `get_free_time` and `get_schedule` file a question in the database and the **Tally app** answers it (like previews), using free/busy only and the same calendars the scheduler uses. What comes back is free intervals (or, for `get_schedule`, which of Tally's own blocks overlap busy time and by how many minutes). Event titles, attendees, calendar names and the busy intervals themselves are never returned. If Tally is not open (about 10 seconds) or Google is disconnected, you get the Tally-only answer and a `warning` such as "Google Calendar events are NOT included: Tally is not open…" or the reconnect message.

### Pinned blocks (read only for Claude)
You can pin a block by hand in Tally (drag it on the Availability grid, or Pin… on the Schedule screen). Claude sees pinned state everywhere (`pinned: true` in previews, `get_schedule`, `get_free_time`; `pinnedBlockWarnings` in previews for pins the plan left out), but **no tool can create, move or remove a pin**.

## 4. Applying a schedule: Claude asks, you approve in Tally

```
Claude: preview_schedule  ──► the Tally app computes it (it reads your calendars) ──► previewId + timestamp
Claude: apply_schedule(previewId)  ──► creates a PENDING request. Nothing is written.
You:    Tally, Schedule screen: a card with the exact summary
        ("remove N earlier blocks, write M new blocks on the “Planner Blocks” calendar") and Approve / Reject
        Approve… shows the normal Apply confirmation; only confirming makes the APP write, with the same code as the Apply button
Claude: get_pending_apply  ──► applied / rejected / expired / stale
```

- **The connector never writes to Google and never holds a token.** `apply_schedule` only inserts a request row; there is no tool that approves. The write happens inside the app, through the same `schedule.apply` path and confirmation text as a normal Apply.
- The Schedule tab shows a marker while a request waits, and Tally notifies you: a desktop notification and an in-app banner, "Claude proposed a schedule: N blocks to write, M to remove. Review on the Schedule tab" (clicking it opens the Schedule tab with the card), plus a reminder when 2 minutes are left. Switch: **Settings, Notifications, "Claude proposes a schedule"** (on by default; held back during quiet hours; never repeated for the same request).
- If Google has rejected the saved sign-in, the app's preview fails with its specific message ("Your Google sign-in expired… Click Reconnect") and the connector passes that on; reconnect in Tally (Settings, Google).
- **Expires after 10 minutes. Only one can be pending at a time.**
- **Stale checks.** A preview id is single-use, refused after 30 minutes, and refused if tasks, dependencies, availability, pinned blocks or the written blocks changed since the preview. Approving re-checks that too, and then the app's own plan check (the Apply button's fingerprint: if your Google calendars changed, the plan differs and nothing is written). A request left pending is **cancelled** if you turn the switch off.
- Previews are always allowed (they write nothing) but need Tally to be open on the same database; otherwise the tool says so after about 30 seconds.

## 5. Undo

Every change Claude makes is recorded (which rows, before and after) with a number:

- **In the app:** Settings, General, Claude connector lists the recent changes, each with an **Undo** button.
- **In the terminal:** `npm run plan -- changes` lists them; `npm run plan -- changes undo 7` undoes #7.

Undo puts the rows back exactly (a task Claude added is soft-deleted, like `rm`; a deleted task comes back; a logged session is removed; a stopped timer is running again; a created list goes away and a rename is reverted; a repeating task's next occurrence goes away). It **refuses** if a task it touched was changed again afterwards, so it never overwrites newer edits: undo the newer change first. An undone import removes its tasks but leaves the term it created.

(An open Tally window may not show a change Claude made until you switch screens.)

## 6. Examples to say to Claude

- "Use Tally: what's due soon, and what should I do first?" (`get_views`)
- "Show my open MATH 115 tasks due before next Friday." (`list_tasks`)
- "Am I free Thursday afternoon, and how much room is left after my planned blocks?" (`get_free_time`)
- "Add 'read ch 3 fri 5pm' to ENGL 125, about 45 minutes." (`add_task`, needs the switch)
- "I spent 40 minutes on WeBWorK 7. Log it, then mark it done." (`log_work`, `mark_done`)
- "Check this syllabus JSON against Tally and tell me what would change; don't import yet." (`import_dry_run`)
  then, after you've looked: "That diff is fine, confirm it." (`import_confirm`)
- "Rename the list Homework to English, move 'Essay draft' into it, and add a step 'Outline' to it." (`rename_list`, `move_task_to_list`, `add_step`)
- "Start a timer on WeBWorK 7." / "Stop my timer." / "Is a timer running?" (`start_timer`, `stop_timer`, `get_timer`)
- "Delete the duplicate 'Quiz 4' task #31." (`delete_task`, needs the delete switch; if other tasks wait on it Claude must ask you before `force`)
- "Preview next week's schedule and tell me what doesn't fit." (`preview_schedule`)
  then "Apply it" (`apply_schedule`): you then see the card in Tally and click Approve.
- "Undo that last thing": Claude can't; use Settings, Claude connector, Undo (or `changes undo`).

## 7. Safety notes
- Local only: stdio, no port, no keys. The Claude client sends your tool results to Anthropic as part of the conversation like any other tool, so don't connect the real database to a client you wouldn't share your task list with. Start with the demo database.
- The connector opens only the file named in its config, after the real/demo check, and never creates or upgrades one.
- It's a separate process from the app. Both can be open; SQLite coordinates them (a write waits up to 5 s if the other is mid-write). The only things it needs the app for are schedule previews and approved applies.
- The code has no Google, keychain, network, backup-restore or settings-write paths; `tests/mcp.test.ts` and `tests/mcpExtended.test.ts` check that, the tool list, each tool, each switch off and on, the stale-edit check, force-delete, timers, preview ids, expiry, and that approval exists only in the app.
