# Installing Tally on a Mac

Tally is a desktop to-do list and planner. This page covers installing the app from a download. (To run it from source, see the README.)

## What you need

- A Mac with **Apple silicon** (M1 or later). Intel Macs are not supported.
- **macOS 13 Ventura or later.** (Tally is built on Electron 45, whose app bundle declares macOS 13.0 as the minimum.)

The first-launch steps below were checked against Apple's current Mac User Guide page "Open a Mac app from an unknown developer", which covers macOS 13 through macOS 26.

## 1. Download and install

1. Open the **Releases** page of this repository and download `Tally-<version>-arm64.zip` from the newest release. Download the matching `.sha256` file too if you want to check it.
2. Double-click the zip to unzip it. You get **Tally.app**.
3. Drag **Tally.app** into your **Applications** folder.

**Optional: check the download.** In Terminal, from the folder holding both files:

```
shasum -a 256 -c Tally-<version>-arm64.zip.sha256
```

It should print `Tally-<version>-arm64.zip: OK`.

## 2. First launch (macOS will warn you)

Tally is not signed with a paid Apple Developer ID and is not notarized, so macOS shows a warning the first time. This is expected for any app that does not come from the App Store or a registered developer: macOS cannot check who made it, so it asks you to confirm. You only do this once.

**macOS 15 Sequoia and later (including macOS 26):**

1. Double-click Tally in Applications. A warning appears. Click **Done** (or OK); do not move it to the Bin.
2. Open **System Settings > Privacy & Security** and scroll down to the **Security** section.
3. Next to the message about Tally being blocked, click **Open Anyway**. This button is available for about an hour after you tried to open the app.
4. Enter your Mac login password and click **OK**, then click **Open** if asked.

On these versions the older right-click trick no longer works, so use the steps above.

**macOS 13 Ventura and 14 Sonoma:** the same Privacy & Security steps work. The older shortcut also works here: Control-click (or right-click) **Tally.app**, choose **Open**, then click **Open** again.

**Last resort, Terminal.** If the steps above do not work, you can remove the quarantine flag macOS put on the download. This turns off the first-launch check for this one app, so only do it for a file you downloaded from this repository's Releases page and checked above:

```
xattr -dr com.apple.quarantine /Applications/Tally.app
```

After the first launch, Tally opens normally by double-click.

## 3. What happens next

- **Your data stays on your Mac.** Tally creates its data folder, `~/Library/Application Support/todo-planner/`, the first time it runs. The database (`planner.db`) and its settings live there. Tally has no account and no server.
- **Notifications:** if you switch on notifications, macOS asks whether Tally may send them. Settings > Notifications has a test button; if macOS blocks them, Tally shows the message in the app instead.
- **Keychain:** only if you connect Google Calendar, Tally stores the sign-in token in your macOS Keychain, and macOS asks for permission. Choose **Always Allow** so it doesn't ask each time.
- **Reminders:** only if you switch on phone capture (Settings > Phone), macOS asks whether Tally may control Reminders.

## Google Calendar is optional

Tally works without it. Without Google you paint your free time on the **Availability** grid and Tally plans around that. Calendar sync needs your own Google client (Tally does not ship one).

Google Calendar setup guide: coming soon.

## Updating

1. Download the new zip from Releases.
2. Quit Tally (menu-bar icon > **Quit Tally**, or Tally > Quit). If a timer is running, choose what to do with it.
3. Drag the new **Tally.app** into Applications and replace the old one.

Your data is kept, because it lives in the data folder, not in the app. A new build may ask for macOS approval again (the first-launch steps) and, if you use Google, for Keychain access again.

## Uninstalling

1. Quit Tally and drag **Tally.app** from Applications to the Bin.
2. Optional: delete your data. This removes your tasks permanently, so copy anything you want to keep first:
   - `~/Library/Application Support/todo-planner/` (your database, settings, logs)
   - `~/Library/Application Support/Tally/` (the app's cache)
   - Backups: in the folder shown in Settings > Backups (by default a `backups` folder inside the data folder, or the folder you chose).
   - If you connected Google: open **Keychain Access** and delete the `todo-planner` item.

In Finder, choose **Go > Go to Folder...** (Shift-Command-G) and paste a path to open it.

## Troubleshooting

**"Tally is damaged and can't be opened."** The download was probably changed or cut short, or the quarantine flag is confused. Delete the app, download the zip again, check it with the `shasum` command above, and repeat the first-launch steps. If it still shows, use the Terminal `xattr` command above.

**Tally won't open after a macOS update.** A macOS update can reset the exception you made. Repeat the first-launch steps (Privacy & Security > Open Anyway). If it still fails, download the newest release.

**Where is the debug log?** `~/Library/Application Support/todo-planner/planner-debug.log` (a plain text file recording quitting and menu-bar icon steps). Include it when you report a problem, after removing anything you don't want to share.

**The menu-bar icon is missing.** On a crowded menu bar, macOS can hide it. Tally also shows the running timer as a badge on its Dock icon.
