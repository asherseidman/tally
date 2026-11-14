# Import format

The planner never calls an LLM. Give Claude your syllabus plus this document, ask for one JSON file per course (or batch) in exactly this shape, save it under `imports/`, then run:

```
npm run import -- imports/my-course.json
```

You get a numbered review list; nothing is written until you approve.

## Extraction rules (paste these to Claude)

1. **Fill in the term from the syllabus** (`term.name`, e.g. "Fall 2026", plus real start/end dates). Use the exact same `term.name` in every file for that term, because it is part of each task's identity.
2. **Never invent dates.** If a date is not stated, use `"due_date": null` and `"confidence": "low"`.
3. **Expand recurring items** (e.g. "weekly homework due Sunday 11:59 PM") into individual dated items, each with `"expanded_from_recurring": true`. Use the term's own start and end dates to decide how many occurrences; do not assume any particular semester. Skip weeks the syllabus says are off (breaks, exam weeks) and mention it in `notes`.
4. **When the syllabus and a schedule disagree, use the schedule's date**, set `"confidence": "low"`, and note the conflict in `source_quote` (e.g. `"Syllabus: Oct 20 / Schedule: Oct 22"`).
5. **`grade_weight` is the item's OWN share of the final grade, not its category's.** Divide a category's percent across its items (15% across 11 counted homeworks is about 1.4 each). If the syllabus drops the lowest scores, say so in `notes` (and divide across the counted items). Record the full category percent in `grading_breakdown`.
6. Keep each `title` unique within a course and stable. The same title in the same course and term is how a later re-import recognizes the task.
7. Output only the JSON, no commentary.

## Fields

```jsonc
{
  "term": {                       // required
    "name": "Fall 2026",
    "start_date": "2026-08-31",   // YYYY-MM-DD
    "end_date": "2026-12-11"
  },
  "items": [                      // required (may be empty)
    {
      "course": "MATH 101",       // required
      "title": "Homework 1",      // required, unique per course
      "type": "homework",         // homework|project|exam|quiz|reading|attendance|other
      "due_date": "2026-09-06",   // ISO 8601 date, or datetime "2026-09-06T17:00:00", or null
      "grade_weight": 1.4,        // percent of FINAL grade (0-100) or null
      "notes": null,              // string or null
      "source_quote": null,       // exact syllabus text this came from, or null
      "confidence": "medium",     // low|medium|high (default medium)
      "expanded_from_recurring": false,  // default false
      "estimated_minutes": 90,    // optional positive integer; only used for NEW tasks (the app owns estimates after that)
      "size": { "amount": 26, "unit": "pages" },  // optional. unit: pages|video_minutes|problems|items|points. "amount" may be (decimals allowed)
                                  // null/omitted when the size is not known yet (e.g. a video whose length is unknown);
                                  // the task then shows under `ls --needs-size`. The app turns amount x rate into an estimate.
      "available_from": "2026-11-07",  // optional YYYY-MM-DD: the task is not scheduled before this local date
      "deadline_only": false,     // optional (default false): an event or deadline to SHOW (e.g. a showcase, a registration date),
                                  // not work to schedule. It keeps its due date, is never scheduled, and is not listed as "not scheduled".
      "optional": false           // optional (default false): optional tasks are not scheduled unless include_optional_tasks is on
    }
  ],
  "grading_breakdown": [          // optional
    { "category": "Homework", "percent": 15 }
    // "course" is optional when the file has a single course; required if there are several
  ]
}
```

### Dates and times
- Date only (`2026-09-06`): the app uses your default due time (11:59 PM unless changed) in your timezone and marks the task **time assumed** (shown with `*`).
- Datetime without offset (`2026-09-06T17:00:00`): interpreted in your configured timezone (default America/Detroit). Include an offset (`-04:00`) or `Z` only if the source gives one.
- Unknown: `null`.

## Example

```json
{
  "term": { "name": "Sample Term A", "start_date": "2026-08-31", "end_date": "2026-12-11" },
  "items": [
    {
      "course": "MATH 101",
      "title": "Homework 1",
      "type": "homework",
      "due_date": "2026-09-06",
      "grade_weight": 1.4,
      "notes": "Lowest homework score is dropped.",
      "source_quote": "Homework is due Sundays at 11:59 PM",
      "confidence": "high",
      "expanded_from_recurring": true
    },
    {
      "course": "MATH 101",
      "title": "Midterm Exam",
      "type": "exam",
      "due_date": "2026-10-20T19:00:00",
      "grade_weight": 25,
      "notes": "Syllabus and schedule disagree; used the schedule's date.",
      "source_quote": "Syllabus: Oct 20 / Schedule: Oct 22",
      "confidence": "low"
    },
    {
      "course": "MATH 101",
      "title": "Final Project",
      "type": "project",
      "due_date": null,
      "grade_weight": 20,
      "source_quote": "Final project due date TBA",
      "confidence": "low"
    }
  ],
  "grading_breakdown": [
    { "category": "Homework", "percent": 15 },
    { "category": "Midterm", "percent": 25 },
    { "category": "Final Project", "percent": 20 }
  ]
}
```

More examples: `samples/`.

## What re-import does

Each task gets an immutable `import_key` = hash of (term + course + normalized original title). Matching uses only that key, so:

- Moved date -> **changed** (not a duplicate). Renamed locally -> still matched.
- The same course in a different term -> separate tasks.
- Fields you edited in the app are never overwritten; if the file also changed such a field it is shown as "edited locally: will NOT overwrite".
- Tasks in the database but absent from the file are listed as **missing** and left alone. Tasks you deleted are not resurrected.

### Size, available_from, optional
- Give a size instead of a guessed estimate where the work is countable: `{"amount": 26, "unit": "pages"}` for pages 209-234 (count inclusively: 234 - 209 + 1). Do not also invent `estimated_minutes` for it; a manual estimate always wins over the size-based one.
- Use `optional: true` for recommended-but-not-required work (e.g. "background reading"). Required items stay `false`.
- Use `deadline_only: true` for something that is a date to remember, not work to do (a showcase event, a registration deadline with no prep). It stays visible in `ls` with its due date and is ignored by the scheduler without being listed under "not scheduled". An item with real work should not be marked this way.
- Use `available_from` when work is released on a known date (a problem set announced on Saturday, due the next Thursday).
- Use `points` for assignments worth a number of points (zyBooks: `{"amount": 100, "unit": "points"}`, about 30 minutes at the default 0.3 min per point; the rate can be set per course and title in the app).
- A size with an unknown amount is valid: `"size": {"unit": "video_minutes"}`.
- Re-import: these fields are compared like the others. A value you changed in the app is never overwritten; a file that newly supplies a missing amount fills it in.

## Plans (optional): steps for an exam or project
A file may carry `plans`: a list of steps for a parent task that already exists (in the same file's `items`, or already imported). Ask Claude for a study or work plan in this shape and import it like any other file; `items` may be empty.

```jsonc
{
  "term": { "name": "Fall 2026", "start_date": "2026-08-31", "end_date": "2026-12-21" },
  "items": [],                                  // optional when the parent is already imported
  "plans": [
    {
      "parent": { "course": "EECS 183", "title": "Exam 2" },   // must match an existing task (course + title)
      "steps": [
        { "title": "Review lectures 10-14", "estimated_minutes": 90 },
        { "title": "Redo project problems", "estimated_minutes": 120, "depends_on": [0] },
        { "title": "Timed practice exam", "estimated_minutes": 90, "due_date": "2026-11-10", "depends_on": [0, 1] }
      ]
    }
  ]
}
```
- Each step: `title` and `estimated_minutes` (required), `due_date` (optional; a step without one takes the parent's due date at import time), `depends_on` (optional list of **0-based positions** of other steps in the same plan that must be finished first).
- Steps become real tasks in the parent's term and course, linked to the parent (`show <parent>` lists them), with the dependencies wired. Estimates are saved with source "imported". A blocked step is not scheduled until the steps it depends on are done.
- Validation errors name the plan and step: an unknown or looping `depends_on`, a duplicate step title, a missing parent. Nothing is imported if any plan is invalid.
- Steps get import keys from the parent's identity plus the step title, so a revised plan diffs cleanly: new steps are added, changed due dates or dependencies are updated (unless you edited them locally), steps dropped from the file are reported as "missing" and left alone. Estimates never change on re-import.
- Once a parent has open steps, the scheduler plans the steps instead of the parent itself (the parent is listed under NOT SCHEDULED with that reason). It still counts as an exam window if it has a real time.

## Review commands
`a` approve · `d N` skip item · `u N` un-skip · `e N field value` edit (title, type, due, weight, est, notes) · `l` list · `q` quit. Flags: `--demo` (use the demo DB), `--dry-run`, `--yes` (approve all without prompting).

## Errors
Invalid files are rejected before anything is written, with messages like `items[3] ("Quiz 2").due_date: must be ISO 8601 ...`.
