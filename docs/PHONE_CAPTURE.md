# Capture tasks from your phone (Apple Reminders)

Add a reminder on your iPhone, and while Tally is open on your Mac it becomes a task. No Shortcut and no extra app: Apple Reminders syncs through iCloud, and Tally reads **one list** from the Reminders app on the Mac.

## How it works
1. On the phone you add a reminder to a list named **Tally Inbox** (typed, or "Hey Siri, remind me to read chapter 5 Friday 5pm in Tally Inbox").
2. Reminders syncs it to your Mac through iCloud.
3. Tally checks the list when it opens and once a minute while it is open. For each **open** reminder it:
   - reads the title the way quick-add does (a date or time at the end is understood: "read chapter 5 due friday 5pm");
   - uses the reminder's own due date instead, if it has one (that wins);
   - **creates the task first**, records the reminder's id, and only then marks the reminder **completed** (it never deletes anything).
4. The new tasks appear in the **Inbox** panel on Today, each with an **Undo**. A notification says how many arrived (not during quiet hours).

A reminder is never imported twice: Tally remembers every reminder id it has seen. If marking a reminder completed fails (or sync is slow), the task still exists, the reminder is not imported again, and Tally just retries the completing. A reminder it cannot read a date from still becomes a task (no due date, with a note). A reminder with no title becomes "(untitled reminder)". Titles are cut at 300 characters (the full text goes in the task's notes) and at most 50 reminders are taken per check (the rest on the next check a minute later).

Tally reads and changes **only** the list with that exact name. It never opens any other list.

## Set it up (about two minutes)
1. **On the iPhone:** open Reminders, tap **Add List**, name it exactly `Tally Inbox`. Make sure the list is in **iCloud** (not "On My iPhone"). On the Mac, Reminders must be signed in to the same iCloud account with Reminders syncing on (System Settings, your name, iCloud, Reminders).
2. **On the Mac:** open Tally, **Settings, Phone**, switch on **Bring in reminders from my phone**, and press **Check now**.
3. **Allow the permission:** macOS asks: "Tally wants to control Reminders" (it says Tally reads the "Tally Inbox" list). Click **OK**. If you click Don't Allow, Tally shows "Permission needed" and a **Retry** button: open **System Settings, Privacy & Security, Automation**, switch on **Reminders** under Tally (the **Open macOS Automation settings** button goes there), then press **Retry**.
4. **Make it quick on the phone:**
   - *Home Screen:* in Reminders, open the Tally Inbox list, tap the (...) menu, and use "Add to Home Screen" if offered, or long-press the Reminders icon and pick the list; or add the Reminders widget showing Tally Inbox to your Home Screen or Lock Screen and tap its **+**.
   - *Siri:* say "Remind me to email Prof. Lee Thursday 3pm in Tally Inbox."
   - *Action Button* (iPhone 15 Pro and later): Settings, Action Button, choose **Shortcut** or **Controls**, and pick a control or a "Add New Reminder" action for the Tally Inbox list. (This is a phone setting; Tally does not need a Shortcut.)

## Settings, Phone
- **Bring in reminders from my phone**: on/off (off by default, so nothing asks for permission until you want it).
- **Reminders list name**: default `Tally Inbox`; change it if you named the list differently.
- **Notify me when items arrive**: also in Settings, Notifications.
- **Permission / status**, **Last check** and **Imported so far**; **Check now** (or **Retry**) runs one check immediately, even if the minute timer is waiting after a denial.

## How to test
1. On the phone, add `Test from phone due tomorrow 5pm` to Tally Inbox.
2. On the Mac, wait for sync (usually seconds), then **Settings, Phone, Check now** (or wait a minute).
3. Today shows it in the **Inbox** panel; the reminder is now ticked off in Reminders. **Undo** removes the task (the reminder stays ticked and is not imported again).
4. Try one with no date ("buy a stapler") and one with a date in the Reminders' own due-date field to see "own due date wins".

## If something goes wrong
- "Permission needed": see step 3 above.
- "List not found": the list name must match exactly (capitals and spaces). Check Settings, Phone, list name.
- Nothing arrives: confirm the reminder is **open** (not completed), is in the iCloud list, and shows on the Mac's Reminders app. Reminders on "On My iPhone" lists do not sync to the Mac.
- "not yet marked completed in Reminders" on an Inbox item: the task was made; Tally will keep trying to tick the reminder.

## Technical notes
Tally runs the system `osascript` (JavaScript for Automation) to talk to the Reminders app with Apple events, so there is no extra helper app and nothing to sign. The script is a fixed string; the list name and reminder ids are passed only as data. macOS's Automation permission is per app and can be switched off at any time. Reminders is not read when the switch is off.
