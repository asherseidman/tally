import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, Notification, powerMonitor, screen, shell, session, Tray, type IpcMainInvokeEvent } from 'electron';
import { DEFAULT_QUICK_ADD_SHORTCUT } from '../src/app/accelerator';
import { getSetting } from '../src/db/repo';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openContext, type CliContext } from '../src/cli/context';
import { createCalendar, noGoogleHandle, type CalendarHandle } from '../src/schedule/calendarFactory';
import { dispatch, processConnectorJobs, inboxTick, seedPendingApplyForTest, type ApiDeps } from '../src/app/api';
import type { AppHooks } from '../src/app/settingsApi';
import type { GoogleStatus } from '../src/app/types';
import { buildGoogleStatus } from '../src/app/googleStatus';
import { recordProblem, recordWorking, recordConnected, forgetConnection } from '../src/schedule/googleHealth';
import { existsSync } from 'node:fs';
import { JxaReminders } from '../src/phone/jxaReminders';
import { FakeReminders } from '../src/phone/fakeReminders';
import type { RemindersSource } from '../src/phone/reminders';
import { KeychainSecretStore, CachedSecretStore } from '../src/schedule/secretStore';
import { clientFileInfo, currentClientId, installClientFile, removeClientFile } from '../src/schedule/clientFile';
import { OAuthTokenProvider, makeOAuthClient, connectInteractive, defaultClientFile, REFRESH_TOKEN_KEY, type HealthHooks } from '../src/schedule/auth';
import { restoreBackup, autoBackupIfDue } from '../src/core/backup';
import { runNotifications, loadNotifySettings, type Notice } from '../src/app/notifier';
import { Deliverer, type DeliveryEnv } from '../src/app/delivery';
import { addTask } from '../src/core/tasks';
import { trayIconBitmap, visiblePixels, TRAY_ICON_PIXELS } from '../src/app/trayIcon';
import { trayState, trayMenuModel, trayTitle, formatElapsed, TRAY_TEXT_MODES, type TrayTextMode, type MenuItemModel, type TrayState } from '../src/app/trayModel';
import { runningTimers, startExclusive, stopAll, type RunningTimer } from '../src/app/timerOps';
import { resolveQuit, type QuitChoice } from '../src/app/quitFlow';
import { appendFileSync, statSync, writeFileSync } from 'node:fs';
import { appDataDir, dbPath } from '../src/paths';
import { backupFolderFor } from '../src/cli/context';
import { listBackups } from '../src/core/backup';

/**
 * Main process: owns the database, the Google connection and every secret. The renderer only ever sees the JSON
 * results of `dispatch` (src/app/api.ts), one IPC channel, validated on this side.
 */
const here = dirname(fileURLToPath(import.meta.url));

/** A plain-text log of what the app did around quitting and the menu-bar icon: ~/Library/Application Support/todo-planner/planner-debug.log. Small, and trimmed at startup. */
const debugLog = join(appDataDir(), process.env.PLANNER_DEMO === '1' || process.argv.includes('--demo') ? 'planner-debug-demo.log' : 'planner-debug.log');
try { if (statSync(debugLog).size > 100_000) writeFileSync(debugLog, ''); } catch { /* no log yet */ }
function trace(msg: string) {
  const line = `${new Date().toISOString()} [${process.pid}] ${msg}\n`;
  try { appendFileSync(debugLog, line); } catch { /* logging must never break the app */ }
  if (process.env.PLANNER_TRACE_STDOUT) process.stdout.write(`TRACE ${line}`);
}
const devUrl = process.env.ELECTRON_RENDERER_URL; // set by `npm run dev`
const demo = process.argv.includes('--demo') || process.env.PLANNER_DEMO === '1';

let cx: CliContext | undefined;
let calendar: CalendarHandle | undefined;

// One shared, cached store: the Keychain is read at most once per launch (macOS asks once, or never after "Always Allow")
const store = new CachedSecretStore(new KeychainSecretStore());
/** Lets the Google code report why a sign-in stopped working (and that it worked); the app keeps that in its database to explain it. */
const healthHooks: HealthHooks = {
  problem: (code, kind) => { if (cx) recordProblem(cx.ctx.db, new Date(), code, kind); },
  working: () => { if (cx) recordWorking(cx.ctx.db, new Date()); },
};
const googleStatus = async (check: boolean): Promise<GoogleStatus> => {
  const clientFile = defaultClientFile();
  const info = clientFileInfo(clientFile);
  const clientFileFound = info.found;
  const db = cx!.ctx.db;
  const input = { demo: demo && !clientPanelTest, clientFile, clientFileFound, clientFileValid: info.valid, clientIdTail: info.idTail };
  if (input.demo || !clientFileFound || !info.valid || (demo && clientPanelTest)) return buildGoogleStatus(db, new Date(), { ...input, tokenSaved: false });
  const token = await store.get(REFRESH_TOKEN_KEY).catch(() => undefined);
  if (!token || !check) return buildGoogleStatus(db, new Date(), { ...input, tokenSaved: !!token });
  try {
    await new OAuthTokenProvider(makeOAuthClient(), store, undefined, healthHooks).getAccessToken();
    return buildGoogleStatus(db, new Date(), { ...input, tokenSaved: true, check: { ok: true } });
  } catch (e) {
    return buildGoogleStatus(db, new Date(), { ...input, tokenSaved: !!(await store.get(REFRESH_TOKEN_KEY).catch(() => undefined)), check: { ok: false, error: (e as Error).message } });
  }
};

// ---- the small quick-add window and its global shortcut ----
let quitting = false;
let quickWin: BrowserWindow | undefined;
let currentAccel = ''; // the accelerator that is registered right now ('' = none)
const quickTesting = !!process.env.PLANNER_SELFTEST_QUICK_SCRIPT;
/** Autopilot for scripts/quit-flow-check.mjs: runs the REAL app (window, tray, polling renderer) and drives it. Demo database only. */
const quitFlow = process.env.PLANNER_SELFTEST_QUIT_FLOW as 'start-and-quit' | 'relaunch' | undefined;

const webPrefs = () => ({ preload: join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true });
function lockdown(win: BrowserWindow) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    // #quick is a hash change on our own page; anything else leaves the app
    const base = devUrl ?? 'file://';
    if (!url.startsWith(base)) e.preventDefault();
  });
}

function createQuickWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 620, height: 210, show: false, frame: false, resizable: false, fullscreenable: false, minimizable: false, maximizable: false,
    alwaysOnTop: true, skipTaskbar: true, title: demo ? 'Tally: quick add (DEMO)' : 'Tally: quick add', backgroundColor: '#ffffff', webPreferences: webPrefs(),
  });
  w.setAlwaysOnTop(true, 'floating');
  lockdown(w);
  // Closing only hides it, so the next shortcut press is instant; clicking elsewhere dismisses it like a launcher.
  w.on('close', (e) => { trace(`quick window close requested (quitting=${quitting})`); if (!quitting) { e.preventDefault(); w.hide(); } });
  w.on('blur', () => { if (!quickTesting) w.hide(); });
  if (devUrl) void w.loadURL(`${devUrl}#quick`);
  else void w.loadFile(join(here, '..', 'dist', 'renderer', 'index.html'), { hash: 'quick' });
  return w;
}

function showQuick() {
  if (!quickWin || quickWin.isDestroyed()) quickWin = createQuickWindow();
  const w = quickWin;
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { x, y, width, height } = d.workArea;
  const [ww] = w.getSize();
  w.setPosition(Math.round(x + (width - ww) / 2), Math.round(y + height / 4));
  w.show();
  w.focus();
}

/** Register (or, with '', remove) the global shortcut. If the system refuses the new one the old one stays. */
function applyShortcut(accel: string) {
  if (accel === currentAccel) return;
  const prev = currentAccel;
  if (prev) globalShortcut.unregister(prev);
  if (accel) {
    let ok = false;
    try { ok = globalShortcut.register(accel, showQuick); } catch { ok = false; }
    if (!ok) {
      if (prev) { try { globalShortcut.register(prev, showQuick); } catch { /* keep going */ } }
      throw new Error(`“${accel}” could not be registered: another app or macOS is already using it. Choose a different shortcut.`);
    }
  }
  currentAccel = accel;
}

// ---- desktop notifications ----
/** Self-test only (demo database): drive the real client-file panel and the no-client behaviour; a pretend file picker answers the dialog. Real Google is never contacted. */
const clientPanelTest = process.env.PLANNER_SELFTEST_GOOGLE_PANEL === '1' && demo && !!(process.env.PLANNER_SELFTEST || process.env.PLANNER_SELFTEST_SCRIPT)
  && /^\/(private\/)?tmp\//.test(process.env.PLANNER_GOOGLE_CLIENT ?? ''); // the client file it may touch must be under /tmp: never the real one
let testPick = process.env.PLANNER_SELFTEST_CHOOSE_FILE;

// Under any self-test nothing touches the real desktop: a fake operating system stands in, and the timers stay off, so tests are deterministic and silent.
const silent = !!(process.env.PLANNER_SELFTEST || process.env.PLANNER_SELFTEST_SCRIPT || process.env.PLANNER_SELFTEST_QUICK_SCRIPT || process.env.PLANNER_SELFTEST_TRAY || process.env.PLANNER_NO_OS_NOTIFICATIONS);
let backupProblem: string | null = null;

function openFromNotification(taskId?: number, target?: 'schedule' | 'settings-google' | 'today') {
  const w = showMain();
  if (target) void w.webContents.executeJavaScript(`window.dispatchEvent(new CustomEvent('planner:open-screen', { detail: ${JSON.stringify(target)} }))`).catch(() => {});
  if (taskId && Number.isInteger(taskId)) void w.webContents.executeJavaScript(`window.dispatchEvent(new CustomEvent('planner:open-task', { detail: ${taskId} }))`).catch(() => {});
}

/** The pretend operating system used in self-tests: PLANNER_FAKE_OS_NOTIFICATIONS = shown | silent (default) | failed | unsupported. */
const fakeOs = (process.env.PLANNER_FAKE_OS_NOTIFICATIONS ?? 'silent') as 'shown' | 'silent' | 'failed' | 'unsupported';
const env: DeliveryEnv = silent
  ? {
      supported: () => fakeOs !== 'unsupported',
      create: () => {
        const handlers = new Map<string, ((...a: unknown[]) => void)[]>();
        return {
          on: (e, cb) => { handlers.set(e, [...(handlers.get(e) ?? []), cb]); },
          show: () => {
            const fire = (e: string, ...a: unknown[]) => setTimeout(() => (handlers.get(e) ?? []).forEach((cb) => cb(...a)), 5);
            if (fakeOs === 'shown') fire('show');
            else if (fakeOs === 'failed') fire('failed', {}, 'Notifications are not allowed for this application');
          },
        };
      },
    }
  : {
      supported: () => Notification.isSupported(),
      create: (o) => {
        const n = new Notification({ title: demo ? `[DEMO] ${o.title}` : o.title, body: o.body });
        return { on: (e, cb) => { (n as unknown as { on(e: string, cb: (...a: unknown[]) => void): void }).on(e, cb); }, show: () => n.show() };
      },
    };

const deliverer = new Deliverer(env, {
  mode: () => (cx ? loadNotifySettings(cx.ctx).delivery : 'auto'),
  timeoutMs: Number(process.env.PLANNER_NOTIFY_TIMEOUT_MS ?? 2000),
  now: () => new Date(),
  after: (ms, fn) => { setTimeout(fn, ms); },
  onClick: (r) => openFromNotification(r.taskId, r.target),
});
const showNotice = (n: { kind: 'block' | 'due' | 'backup' | 'test' | 'claude' | 'google' | 'phone'; title: string; body: string; taskId?: number; target?: 'schedule' | 'settings-google' | 'today'; action?: 'reconnect' }) => deliverer.deliver(n);

function notifyTick(): Notice[] {
  if (!cx) return [];
  try { return runNotifications(cx.ctx, (n) => { showNotice(n); }, { backupError: backupProblem }); }
  catch (e) { console.error(`(notification check failed: ${(e as Error).message})`); return []; }
}

/** Once an hour while the app is open: make sure today's backup exists; remember a failure so it can be announced. */
async function backupCheck() {
  if (!cx) return;
  try { await autoBackupIfDue(cx.ctx, cx.backupFolder); backupProblem = null; }
  catch (e) { backupProblem = (e as Error).message; }
}

/**
 * The Claude connector (a separate program) never talks to Google. It files requests in the database and this process answers:
 * schedule previews are computed here, and an apply waits here until the user clicks Approve on the Schedule screen.
 */
let brokerBusy = false;
function startConnectorBroker() {
  const tick = async () => {
    if (brokerBusy || !cx || quitting) return;
    brokerBusy = true;
    try {
      await processConnectorJobs(await deps());
      // a schedule Claude just proposed, or a Google sign-in that just failed, should not wait for the 30-second check
      runNotifications(cx.ctx, (n) => { showNotice(n); }, { only: 'urgent' });
    } catch (e) { trace(`connector jobs failed: ${(e as Error).message}`); } finally { brokerBusy = false; }
  };
  setInterval(() => void tick(), 1500).unref();
}

/** Phone capture: a pass shortly after launch (to take any backlog), then once a minute while Tally is open. Does nothing while the switch is off. */
function startInboxTimer() {
  if (silent) return;
  const tick = async () => {
    if (!cx || quitting) return;
    try { await inboxTick(await deps()); runNotifications(cx.ctx, (n) => { showNotice(n); }, { only: 'urgent' }); } catch (e) { trace(`phone inbox pass failed: ${(e as Error).message}`); }
  };
  setTimeout(() => void tick(), 8_000).unref();
  setInterval(() => void tick(), 60_000).unref();
}

function startNotificationTimers() {
  if (silent) return;
  backupProblem = cx?.backupError ?? null;
  setTimeout(notifyTick, 4_000).unref();
  setInterval(notifyTick, 30_000).unref();
  setInterval(() => { void backupCheck().then(notifyTick); }, 3_600_000).unref();
}

// ---- the menu-bar icon (tray) ----
let mainWin: BrowserWindow | undefined;
let tray: Tray | undefined;
let trayRunning = false;
let menuOpen = false;
let cachedState: TrayState | undefined;
let cachedAt = 0;
let lastMenuKey = '';
let lastTooltip = '';
let lastTitle = '';
let trayTextMode: TrayTextMode = 'full';
function loadTrayTextMode() { const v = cx ? getSetting(cx.ctx.db, 'tray_text') : undefined; trayTextMode = (TRAY_TEXT_MODES as string[]).includes(v ?? '') ? (v as TrayTextMode) : 'full'; }
const trayTesting = !!process.env.PLANNER_SELFTEST_TRAY;
const wantTray = !(process.env.PLANNER_SELFTEST || process.env.PLANNER_SELFTEST_SCRIPT || process.env.PLANNER_SELFTEST_QUICK_SCRIPT) || trayTesting;

/** Show (or recreate) the main window and return it. */
function showMain(): BrowserWindow {
  if (!mainWin || mainWin.isDestroyed()) createWindow();
  const w = mainWin!;
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
  return w;
}

// Kept referenced for the life of the app: if these were garbage collected macOS could drop the icon.
const trayImages: { idle?: Electron.NativeImage; running?: Electron.NativeImage } = {};
function trayIcon(running: boolean): Electron.NativeImage {
  const key = running ? 'running' : 'idle';
  if (!trayImages[key]) {
    const img = nativeImage.createFromBitmap(trayIconBitmap(running), { width: TRAY_ICON_PIXELS, height: TRAY_ICON_PIXELS, scaleFactor: 2 });
    img.setTemplateImage(true); // black + alpha: macOS tints it for light/dark menu bars
    trayImages[key] = img;
  }
  return trayImages[key]!;
}

/** Everything that decides whether the icon can show, for Settings and for the log. */
function trayDiagnostics() {
  if (!tray || tray.isDestroyed()) return { created: false as const };
  const img = trayIcon(trayRunning);
  const bounds = tray.getBounds();
  return {
    created: true as const, bounds, title: lastTitle, imageEmpty: img.isEmpty(), size: img.getSize(), scaleFactors: img.getScaleFactors(),
    template: img.isTemplateImage, visiblePixels: visiblePixels(trayIconBitmap(trayRunning)),
    /** macOS gives a status item a position once it is allowed in the menu bar; an all-zero rectangle means it was not placed */
    placed: bounds.width > 0 && bounds.height > 0,
    screenWidth: screen.getPrimaryDisplay().bounds.width,
    // Status items fill the menu bar from the RIGHT. One whose centre is left of 60% of the screen width had no room there: on a notched MacBook it ends up under the notch or among the app menus, where it cannot be seen.
    likelyHidden: bounds.width > 0 && bounds.x + bounds.width / 2 < screen.getPrimaryDisplay().bounds.width * 0.6,
  };
}

function toTemplate(items: MenuItemModel[]): Electron.MenuItemConstructorOptions[] {
  return items.map((m) => (m.type === 'separator' ? { type: 'separator' as const } : {
    label: m.label, enabled: m.enabled !== false, id: m.id,
    ...(m.submenu ? { submenu: toTemplate(m.submenu) } : {}),
    ...(m.id ? { click: () => { void trayAction(m.id!); } } : {}),
  }));
}

function currentTrayState(force: boolean): TrayState | undefined {
  if (!cx) return undefined;
  const now = Date.now();
  const run = runningTimers(cx.ctx)[0];
  const sig = run ? `${run.sessionId}` : '-';
  if (force || !cachedState || now - cachedAt > 30_000 || (cachedState.running ? `${cachedState.running.sessionId}` : '-') !== sig) {
    cachedState = trayState(cx.ctx);
    cachedAt = now;
  }
  return cachedState;
}

/** Called every second (cheap: one query) and after every tray action. */
function refreshTray(force = false) {
  try { refreshTrayNow(force); } catch (e) { trace(`menu bar refresh failed: ${(e as Error).message}`); }
}
function refreshTrayNow(force: boolean) {
  if (!tray || tray.isDestroyed() || !cx) return;
  const st = currentTrayState(force);
  if (!st) return;
  const now = cx.ctx.clock.now().getTime();
  const running = st.running;
  if (!!running !== trayRunning || force) { trayRunning = !!running; tray.setImage(trayIcon(trayRunning)); }
  lastTitle = trayTitle(running, now, 22, trayTextMode);
  tray.setTitle(lastTitle); // macOS: text beside the icon (a timer glyph when idle, so something shows even if the image fails)
  lastTooltip = running ? `Timer: ${running.title} · ${formatElapsed(now - running.startedAtMs)}` : 'Tally: no timer running';
  tray.setToolTip(lastTooltip);
  refreshDock(st, running, now, force);
  const key = JSON.stringify([running?.sessionId ?? null, st.startTarget, st.candidates, currentAccel]);
  if (!menuOpen && (force || key !== lastMenuKey || (running && Math.floor(now / 5_000) !== Math.floor(lastMenuBuiltAt / 5_000)))) {
    const menu = Menu.buildFromTemplate(toTemplate(trayMenuModel(st, now, { shortcut: currentAccel || undefined })));
    const m = menu as unknown as { on(e: string, cb: () => void): void };
    m.on('menu-will-show', () => { menuOpen = true; });
    m.on('menu-will-close', () => { menuOpen = false; });
    tray.setContextMenu(menu);
    trayMenu = menu;
    lastMenuKey = key;
    lastMenuBuiltAt = now;
  }
}
/**
 * macOS fallback that cannot be hidden by a crowded menu bar or the notch: the Dock icon shows the running time as a badge and has
 * the same menu (right-click or hold the icon) as the menu-bar icon.
 */
let lastDockKey = '';
let lastDockBadge = '';
function refreshDock(st: TrayState, running: TrayState['running'], now: number, force: boolean) {
  if (process.platform !== 'darwin' || !app.dock) return;
  const shortBadge = running ? `${Math.floor((now - running.startedAtMs) / 60_000)}m` : '';
  if (shortBadge !== lastDockBadge || force) { app.dock.setBadge(shortBadge); lastDockBadge = shortBadge; }
  const key = JSON.stringify([running?.sessionId ?? null, st.startTarget, st.candidates, currentAccel]);
  if (key !== lastDockKey || force) {
    app.dock.setMenu(Menu.buildFromTemplate(toTemplate(trayMenuModel(st, now, { shortcut: currentAccel || undefined }).filter((m) => m.id !== 'quit'))));
    lastDockKey = key;
  }
}
let trayMenu: Menu | undefined;
let lastMenuBuiltAt = 0;

async function trayAction(id: string) {
  try {
    if (id === 'quit') { app.quit(); return; }
    if (id === 'quick') { showQuick(); return; }
    if (id === 'open') { showMain(); return; }
    if (!cx) return;
    if (id === 'stop') stopAll(cx.ctx);
    else if (id.startsWith('start:')) startExclusive(cx.ctx, Number(id.slice(6)));
    refreshTray(true);
  } catch (e) { console.error(`(menu bar action failed: ${(e as Error).message})`); }
}

function createTray() {
  if (!wantTray) return;
  try {
    loadTrayTextMode();
    tray = new Tray(trayIcon(false)); // created inside app.whenReady (this is only called from there) and kept in the module-level `tray`
    refreshTray(true);
    // hovering the icon (macOS) refreshes the menu just before it is opened, so its elapsed time is current
    (tray as unknown as { on(e: string, cb: () => void): void }).on('mouse-enter', () => refreshTray(true));
    setInterval(() => refreshTray(), 1000).unref();
    const d = trayDiagnostics();
    trace(`menu bar icon created: ${JSON.stringify(d)}`);
    // macOS places the item a moment after creation: look again
    setTimeout(() => trace(`menu bar icon, 1.5 s later: ${JSON.stringify(trayDiagnostics())}`), 1500).unref();
  } catch (e) { tray = undefined; trace(`menu bar icon unavailable: ${(e as Error).message}`); }
}

// ---- quitting without losing a running timer ----
// The decision (stop / keep / cancel) is in src/app/quitFlow.ts and is tested against a real database file; this file asks the question and quits.
async function askUserAboutTimer(running: RunningTimer[]): Promise<QuitChoice> {
  const forced = process.env.PLANNER_QUIT_TIMER as QuitChoice | undefined;
  if ((silent || quitFlow) && forced) return forced; // tests answer the dialog through the environment; a person answers it for real
  const r = running[0];
  const { response } = await dialog.showMessageBox({
    type: 'question', title: 'A timer is running', buttons: ['Stop timer, save and quit', 'Quit and leave the timer running', 'Cancel (stay open)'], defaultId: 0, cancelId: 2,
    message: `A timer is running on “${r.title}” (${formatElapsed(Date.now() - r.startedAtMs)}).`,
    detail: 'Stop, save and quit: adds this time to the task, then the app quits.\nQuit and leave the timer running: the app quits, but the timer stays saved and keeps counting; you will see it running, with the full elapsed time, next time you open the app.\nCancel: the app stays open.',
  });
  trace(`dialog answered with button ${response}: ${['stop', 'keep', 'cancel'][response] ?? 'unknown'}`);
  return (['stop', 'keep', 'cancel'] as const)[response];
}
let quitAsked = false;

// Phone capture: the real Reminders app through osascript/JXA. A self-test on the DEMO database may use a pretend Reminders (a JSON file) instead; the real app is never touched then.
const remindersSource: RemindersSource = process.env.PLANNER_FAKE_REMINDERS && demo && silent ? new FakeReminders(process.env.PLANNER_FAKE_REMINDERS) : new JxaReminders();
const PRIVACY_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation';

const hooks: AppHooks = {
  reminders: remindersSource,
  openPrivacyPane: () => { void shell.openExternal(PRIVACY_PANE); },
  trayRefresh: () => { loadTrayTextMode(); refreshTray(true); },
  setTheme: (t) => applyTheme(t),
  // a changed color scheme reaches every open window (main, quick-add) at once, with no restart
  setScheme: (css) => { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) void w.webContents.executeJavaScript(`window.dispatchEvent(new CustomEvent('planner:appearance', { detail: ${JSON.stringify(css)} }))`).catch(() => {}); },
  notifyTest: () => deliverer.test(),
  notifyCheck: notifyTick,
  notifyRecent: () => deliverer.records,
  banners: () => deliverer.banners,
  dismissBanner: (id) => deliverer.dismiss(id),
  setBackupFolder: (f) => { if (cx) cx.backupFolder = f; },
  setShortcut: applyShortcut,
  shortcutActive: () => currentAccel !== '' && globalShortcut.isRegistered(currentAccel),
  // Swap the live database for a verified backup: close our connection, restore (a pre-restore copy is saved first), reopen.
  restore: async (backupPath) => {
    if (!cx) throw new Error('The database is not open.');
    const { dbFile, backupFolder, ctx } = cx;
    cx.close();
    cx = undefined;
    calendar = undefined;
    try {
      return await restoreBackup(dbFile, backupPath, backupFolder, ctx.clock);
    } finally {
      cx = await openContext(demo); // reopen whatever is on disk now (the restored data, or the untouched original if the restore refused)
    }
  },
  google: {
    status: () => googleStatus(false),
    check: () => googleStatus(true),
    connect: async () => {
      if (demo) return googleStatus(false);
      await connectInteractive(store, defaultClientFile(), () => {}, () => { if (cx) recordConnected(cx.ctx.db, new Date()); });
      deliverer.dismissKind('google'); // the banner about the expired sign-in has done its job
      return googleStatus(true);
    },
    chooseClient: async (confirmReplace) => {
      if (demo && !clientPanelTest) throw new Error('The demo database uses a simulated calendar, so there is nothing to set up.');
      const target = defaultClientFile();
      const had = existsSync(target);
      if (had && !confirmReplace) throw new Error('A Google client file is already set up. Confirm that you want to replace it first (you will need to reconnect).');
      let picked: string | undefined;
      if (clientPanelTest) picked = testPick; // a pretend picker; a script cannot click a native dialog
      else {
        const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
        const opts: Electron.OpenDialogOptions = { title: 'Choose your Google client file', message: 'Choose the Desktop-app client JSON you downloaded from Google Cloud.', properties: ['openFile'], filters: [{ name: 'Google client file (JSON)', extensions: ['json'] }], buttonLabel: 'Use this file' };
        const r = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
        if (r.canceled || !r.filePaths[0]) return { ...(await googleStatus(false)), cancelled: true };
        picked = r.filePaths[0];
      }
      if (!picked) return { ...(await googleStatus(false)), cancelled: true };
      const oldId = had ? currentClientId(target) : undefined;
      const res = installClientFile(target, picked); // throws a plain-words error for a bad file; nothing is written then
      calendar = undefined; // the next calendar request sees the new client
      let notice = `Saved. Client ID ends in ${res.tail}.`;
      if (had && !res.sameClient && oldId !== undefined) {
        // a sign-in made with the old client cannot be used with the new one
        const hadToken = !demo && !!(await store.get(REFRESH_TOKEN_KEY).catch(() => undefined));
        if (!demo) { await store.delete(REFRESH_TOKEN_KEY).catch(() => {}); if (cx) forgetConnection(cx.ctx.db); }
        deliverer.dismissKind('google');
        notice += hadToken ? ' This is a different client, so the saved sign-in was removed: choose Connect to sign in again.' : ' This is a different client: choose Connect to sign in.';
      } else if (had) notice += ' The sign-in made with this client ID is kept.';
      trace('google client file replaced/saved (the file and its secret are never logged)');
      return { ...(await googleStatus(false)), notice };
    },
    removeClient: async () => {
      if (demo && !clientPanelTest) throw new Error('The demo database uses a simulated calendar, so there is nothing to remove.');
      removeClientFile(defaultClientFile());
      calendar = undefined;
      if (!demo) { await store.delete(REFRESH_TOKEN_KEY).catch(() => {}); if (cx) forgetConnection(cx.ctx.db); }
      deliverer.dismissKind('google');
      return googleStatus(false);
    },
    disconnect: async () => {
      if (!demo) { await store.delete(REFRESH_TOKEN_KEY); if (cx) forgetConnection(cx.ctx.db); deliverer.dismissKind('google'); }
      const s = await googleStatus(false);
      return demo ? s : { ...s, message: 'Removed the saved sign-in from your keychain. To also revoke access on Google’s side: https://myaccount.google.com/permissions' };
    },
  },
};

async function deps(): Promise<ApiDeps> {
  if (!cx) {
    if (quitting) throw new Error('The app is quitting.'); // a late request from a closing window must not reopen the database
    cx = await openContext(demo);
  }
  const c = cx;
  return {
    ctx: c.ctx, dbFile: c.dbFile, demo: c.demo, backupFolder: c.backupFolder, hooks,
    calendar: () => (calendar ??= (clientPanelTest && !existsSync(defaultClientFile()) ? noGoogleHandle() : createCalendar(c.ctx.tz, c.demo, store, healthHooks))),
  };
}

/** Only our own window may call the API (not a navigated or embedded page). */
function trusted(e: IpcMainInvokeEvent): boolean {
  const url = e.senderFrame?.url ?? '';
  return devUrl ? url.startsWith(devUrl) : url.startsWith('file://');
}

/** 1280x860, unless a screenshot asks for another size (PLANNER_WINDOW_SIZE=900x640) */
function windowSize() {
  const m = /^(\d+)x(\d+)$/.exec(process.env.PLANNER_WINDOW_SIZE ?? '');
  return m ? { width: Number(m[1]), height: Number(m[2]) } : { width: 1280, height: 860 };
}

function createWindow() {
  const win = new BrowserWindow({
    ...windowSize(), minWidth: 900, minHeight: 600, show: false, title: demo ? 'Tally (DEMO)' : 'Tally',
    backgroundColor: '#ffffff',
    webPreferences: webPrefs(),
  });
  win.once('ready-to-show', () => win.show());
  mainWin = win;
  // Closing the window only hides it while the menu-bar icon exists, so the shortcut, timer and notifications keep working. Quit from the menu really quits.
  win.on('close', (e) => { trace(`main window close requested (quitting=${quitting}, tray=${!!tray})`); if (!quitting && tray) { e.preventDefault(); win.hide(); } });
  win.on('closed', () => { mainWin = undefined; if (!tray) { quitting = true; app.quit(); } });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (devUrl ? !url.startsWith(devUrl) : !url.startsWith('file://')) e.preventDefault();
  });
  if (process.env.PLANNER_SELFTEST) {
    // Smoke test: load the screen, report what rendered, save a screenshot, quit. (npm run smoke)
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        if (process.env.PLANNER_SELFTEST_SCRIPT) {
          // Drives the real UI (scripts/smoke-ui.js). Only ever against the DEMO database.
          if (!demo) { console.log('SMOKE refused: UI scripts run only with --demo'); app.quit(); return; }
          const { readFileSync } = await import('node:fs');
          console.log('SMOKEUI ' + (await win.webContents.executeJavaScript(readFileSync(process.env.PLANNER_SELFTEST_SCRIPT, 'utf8'))));
        }
        if (process.env.PLANNER_SHOT_SCREEN && process.env.PLANNER_SHOT_SCREEN !== 'today' && process.env.PLANNER_SELFTEST) {
          // screenshots (scripts/ui-shots.mjs, demo only): open the requested screen first
          if (!demo) { console.log('SHOT refused: demo database only'); app.quit(); return; }
          const { readFileSync } = await import('node:fs');
          const screenName = process.env.PLANNER_SHOT_SCREEN;
          if (screenName === 'quick') {
            showQuick();
            for (let i = 0; i < 100 && (!quickWin || quickWin.webContents.isLoading() || !quickWin.webContents.getURL().includes('#quick')); i++) await new Promise((r) => setTimeout(r, 50));
            await new Promise((r) => setTimeout(r, 500));
            await quickWin!.webContents.executeJavaScript(`(async () => { const i = document.querySelector('input[aria-label=Task]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'Write response paper due friday 5pm'); i.dispatchEvent(new Event('input', { bubbles: true })); await new Promise((r) => setTimeout(r, 600)); })()`);
            let q = await quickWin!.webContents.capturePage();
            if (process.env.PLANNER_SHOT_WIDTH && q.getSize().width > Number(process.env.PLANNER_SHOT_WIDTH)) q = q.resize({ width: Number(process.env.PLANNER_SHOT_WIDTH), quality: 'best' });
            const { writeFileSync: wf } = await import('node:fs');
            wf(process.env.PLANNER_SELFTEST!, q.toPNG());
            quitting = true; app.quit(); return;
          }
          await win.webContents.executeJavaScript(readFileSync(join(here, '..', 'scripts', 'shot-prep.js'), 'utf8') + `('${screenName.replace(/[^a-z]/g, '')}')`);
        }
        const probe = await win.webContents.executeJavaScript(`JSON.stringify({
          cells: document.querySelectorAll('[role=gridcell]').length,
          freeCells: document.querySelectorAll('.cell.free').length,
          busyEvents: document.querySelectorAll('.ev.busy').length,
          blockEvents: document.querySelectorAll('.ev.block').length,
          heads: [...document.querySelectorAll('.dayhead b')].map((e) => e.textContent),
          banner: document.querySelector('.demo-banner')?.textContent ?? null,
          backup: document.querySelector('.backup')?.textContent ?? null,
          errors: [...document.querySelectorAll('[role=alert], .fatal')].map((e) => e.textContent),
          notes: [...document.querySelectorAll('.note')].map((e) => e.textContent),
        })`);
        console.log('SMOKE ' + probe);
        let img = await win.webContents.capturePage();
        if (process.env.PLANNER_SHOT_WIDTH) img = img.resize({ width: Number(process.env.PLANNER_SHOT_WIDTH), quality: 'best' }); // UI screenshots at 1x
        const { writeFileSync } = await import('node:fs');
        writeFileSync(process.env.PLANNER_SELFTEST!, img.toPNG());
        app.quit();
      }, Number(process.env.PLANNER_SELFTEST_WAIT ?? 2500));
    });
  }
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(here, '..', 'dist', 'renderer', 'index.html'));
}

const printConfig = process.argv.includes('--print-config');
// The product is called Tally. The data folder (~/Library/Application Support/todo-planner), planner.db, the backup folder, the Google
// client file and the Keychain service names are deliberately NOT renamed: renaming them would orphan existing data and sign-ins.
app.setName('Tally');
app.setAboutPanelOptions({ applicationName: 'Tally', applicationVersion: app.getVersion(), credits: 'A personal to-do list and planner. Your data stays on this Mac (and your own iCloud backup folder).', copyright: 'Personal use' });

/** Apply the Appearance setting to every window (the renderer's CSS follows prefers-color-scheme, which follows this). */
function applyTheme(t: 'system' | 'light' | 'dark') {
  if (process.env.PLANNER_THEME === 'light' || process.env.PLANNER_THEME === 'dark') return; // forced for screenshots/tests
  nativeTheme.themeSource = t;
}

/** The app used to be called Planner. If an old Planner.app is still running it would share the database and the shortcut: say so. */
async function warnIfOldPlannerRunning() {
  if (!app.isPackaged) return;
  const { execFileSync } = await import('node:child_process');
  let pids = '';
  try { pids = execFileSync('pgrep', ['-f', '/Planner.app/Contents/MacOS/Planner'], { encoding: 'utf8' }).trim(); } catch { return; }
  if (!pids) return;
  trace(`the old Planner app is running (pid ${pids.replace(/\s+/g, ', ')})`);
  const { response } = await dialog.showMessageBox({
    type: 'warning', title: 'The old Planner app is still running', buttons: ['Quit Tally', 'Continue anyway'], defaultId: 0, cancelId: 0,
    message: 'Planner (the old name of this app) is still running.',
    detail: 'Both would use the same database and the same keyboard shortcut. Quit Planner from its menu-bar icon ("Quit Planner"), then open Tally again.',
  });
  if (response === 0) { quitting = true; app.exit(0); }
}

/**
 * `Tally --print-config`: what THIS build would use, without opening or changing anything: the database file, whether it exists, where
 * the backups go (read from the database's own backup_folder setting, read-only), and whether the native modules load.
 * Used to prove the packaged app points at the real database and the same iCloud backups.
 */
async function printConfigAndExit() {
  const file = dbPath(demo);
  const out: Record<string, unknown> = {
    packaged: app.isPackaged, version: app.getVersion(), electron: process.versions.electron, node: process.versions.node, arch: process.arch,
    execPath: process.execPath, demo, db: file, dbExists: existsSync(file),
    envOverrides: ['PLANNER_DB', 'PLANNER_DEMO_DB', 'PLANNER_GOOGLE_CLIENT'].filter((k) => process.env[k]),
  };
  try {
    const { default: Database } = await import('better-sqlite3');
    out.sqlite = 'loaded';
    if (existsSync(file)) {
      const db = new Database(file, { readonly: true, fileMustExist: true });
      try {
        out.schemaVersion = db.pragma('user_version', { simple: true });
        const row = db.prepare("SELECT value FROM settings WHERE key = 'backup_folder'").get() as { value: string } | undefined;
        const folder = backupFolderFor(row?.value, file, demo);
        const newest = listBackups(folder)[0];
        Object.assign(out, { backupFolder: folder, backupFolderIsSaved: !!row, backupFolderInICloud: folder.includes('/Library/Mobile Documents/'), backupFolderExists: existsSync(folder), newestBackup: newest ? { name: newest.name, takenAt: newest.takenAt.toISOString() } : null });
      } finally { db.close(); }
    }
  } catch (e) { out.sqlite = `FAILED: ${(e as Error).message}`; }
  try {
    const { Entry } = await import('@napi-rs/keyring');
    new Entry('todo-planner', '__probe__'); // creating the handle does not read the Keychain
    out.keyring = 'loaded';
  } catch (e) { out.keyring = `FAILED: ${(e as Error).message}`; }
  console.log('PLANNERCONFIG ' + JSON.stringify(out));
  app.exit(0);
}

app.whenReady().then(async () => {
  // screenshots and tests can force a theme; otherwise the saved Appearance setting (or the system) decides
  if (process.env.PLANNER_THEME === 'light' || process.env.PLANNER_THEME === 'dark') nativeTheme.themeSource = process.env.PLANNER_THEME;
  if (printConfig) { await printConfigAndExit(); return; }
  // Packaged: only one Tally at a time (two would both open the database and fight over the global shortcut).
  if (app.isPackaged && !silent) {
    await warnIfOldPlannerRunning();
    if (!app.requestSingleInstanceLock()) { trace('another Tally is already running: exiting'); app.exit(0); return; }
    app.on('second-instance', () => { showMain(); });
  }
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  if (!devUrl) {
    session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
      cb({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': ["default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:"] } });
    });
  }
  ipcMain.handle('planner:invoke', async (e, channel: unknown, args: unknown) => {
    if (!trusted(e)) return { ok: false, error: 'Request from an untrusted page was refused.' };
    if (typeof channel !== 'string') return { ok: false, error: 'Bad request.' };
    if (channel === 'tray.info') return { ok: true, value: trayDiagnostics() };
    if (channel === 'selftest.pendingApply') { // test only: never available outside a self-test on the demo database
      if (!silent || !demo) return { ok: false, error: 'Not available.' };
      try { return { ok: true, value: await seedPendingApplyForTest(await deps()) }; } catch (e) { return { ok: false, error: (e as Error).message }; }
    }
    if (channel === 'selftest.chooseFile') { // test only: which file the pretend file picker returns next
      if (!clientPanelTest) return { ok: false, error: 'Not available.' };
      testPick = String((args as { path?: string } | undefined)?.path ?? '');
      return { ok: true, value: null };
    }
    if (channel === 'selftest.googleProblem') { // test only: pretend Google rejected the saved sign-in (or clear that again)
      if (!silent || !demo) return { ok: false, error: 'Not available.' };
      const db = (await deps()).ctx.db;
      if ((args as { clear?: boolean } | undefined)?.clear) forgetConnection(db);
      else { recordConnected(db, new Date(Date.now() - 7.2 * 86_400_000)); recordProblem(db, new Date(), 'invalid_grant', 'reconnect'); }
      return { ok: true, value: null };
    }
    if (channel === 'selftest.reminders') { // test only: drive the pretend Reminders app (deny permission, add a reminder); never the real one
      if (!silent || !demo || !(remindersSource instanceof FakeReminders)) return { ok: false, error: 'Not available.' };
      const a = (args ?? {}) as { deny?: boolean; add?: { id: string; title: string }[] };
      if (typeof a.deny === 'boolean') remindersSource.deny = a.deny;
      if (a.add?.length) remindersSource.add('Tally Inbox', ...a.add);
      return { ok: true, value: null };
    }
    if (channel === 'quick.hide') { if (quickWin && !quickWin.isDestroyed()) quickWin.hide(); return { ok: true, value: null }; } // window chrome, not data: handled here
    return dispatch(await deps(), channel, args);
  });
  const d0 = await deps(); // opens the database (and takes the daily backup) before the first screen asks for anything
  { const t = getSetting(d0.ctx.db, 'theme'); applyTheme(t === 'light' || t === 'dark' ? t : 'system'); }
  // the global quick-add shortcut ('' in settings = turned off); a failure here is shown in Settings, it must not stop the app
  try { applyShortcut(getSetting(d0.ctx.db, 'quick_add_shortcut') ?? DEFAULT_QUICK_ADD_SHORTCUT); }
  catch (e) { console.error(`(quick-add shortcut not active: ${(e as Error).message})`); }
  if (quickTesting) { void runQuickSelfTest(); return; }
  if (trayTesting) { createTray(); void runTraySelfTest(); return; }
  if (!app.isPackaged && process.platform === 'darwin' && app.dock) { const ic = nativeImage.createFromPath(join(here, '..', 'build', 'icon.png')); if (!ic.isEmpty()) app.dock.setIcon(ic); } // the packaged app has its own .icns
  startNotificationTimers();
  startConnectorBroker();
  startInboxTimer();
  createTray();
  createWindow();
  if (quitFlow) void runQuitFlow(quitFlow);
  app.on('activate', () => { showMain(); }); // clicking the Dock icon brings the window back
});


/** The quit flow as a person meets it: a real window and tray, a timer started from the tray, then the same app.quit() Cmd+Q performs. */
async function runQuitFlow(mode: 'start-and-quit' | 'relaunch') {
  if (!demo) { console.log('QUITFLOW refused: demo database only'); app.exit(2); return; }
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const t0 = Date.now();
  while (!(mainWin && mainWin.isVisible()) && Date.now() - t0 < 15000) await wait(100);
  await wait(2500); // let the window's own polling (banners, timers) run, as it does in real use
  if (mode === 'start-and-quit') {
    const st = trayState(cx!.ctx);
    if (!st.startTarget) { console.log('QUITFLOW ' + JSON.stringify({ error: 'nothing to time' })); app.exit(2); return; }
    await trayAction(`start:${st.startTarget.id}`);
    await wait(2500);
    const run = runningTimers(cx!.ctx)[0];
    console.log('QUITFLOW ' + JSON.stringify({ phase: 'quitting', sessionId: run?.sessionId, startedAt: run ? new Date(run.startedAtMs).toISOString() : null, title: tray?.getTitle() }));
    app.quit(); // exactly what Cmd+Q (or the menu's Quit) calls
    return;
  }
  // relaunch: report what a person would see
  const run = runningTimers(cx!.ctx)[0];
  refreshTray(true);
  await wait(1200);
  const bar = await mainWin!.webContents.executeJavaScript(`document.querySelector('.timerbar')?.textContent ?? null`).catch(() => null);
  console.log('QUITFLOW ' + JSON.stringify({ phase: 'relaunched', sessionId: run?.sessionId ?? null, startedAt: run ? new Date(run.startedAtMs).toISOString() : null, elapsedMs: run ? Date.now() - run.startedAtMs : null, trayTitle: tray?.getTitle() ?? null, timerBar: bar }));
  process.env.PLANNER_QUIT_TIMER = 'stop';
  app.quit();
}

/** Self-test of the quick-add window (npm run smoke:ui, demo database only): show it like the shortcut does, drive it, report. */
async function runQuickSelfTest() {
  if (!demo) { console.log('SMOKE refused: UI scripts run only with --demo'); app.quit(); return; }
  const { readFileSync } = await import('node:fs');
  showQuick();
  const w = quickWin!;
  // wait until the page has really loaded (right after creation the window is still on about:blank)
  for (let i = 0; i < 200 && (w.webContents.isLoading() || !w.webContents.getURL().includes('#quick')); i++) await new Promise((r) => setTimeout(r, 50));
  const before = { shortcut: currentAccel, registered: currentAccel ? globalShortcut.isRegistered(currentAccel) : false, visible: w.isVisible(), alwaysOnTop: w.isAlwaysOnTop(), url: w.webContents.getURL().replace(/^.*#/, '#') };
  await new Promise((r) => setTimeout(r, 400));
  const result = await w.webContents.executeJavaScript(readFileSync(process.env.PLANNER_SELFTEST_QUICK_SCRIPT!, 'utf8'));
  await new Promise((r) => setTimeout(r, 300)); // the window hides itself after an add
  const afterVisible = w.isVisible();
  showQuick(); // the second shortcut press must work as well as the first
  await new Promise((r) => setTimeout(r, 300));
  const reopened = !quickWin!.isDestroyed() && quickWin!.isVisible();
  console.log('SMOKEQUICK ' + JSON.stringify({ before, afterVisible, reopened, result: JSON.parse(result) }));
  quitting = true;
  app.quit();
}


/** Self-test of the menu-bar icon (npm run smoke:ui, demo database only): drives the real tray, menu, window and quit logic and reports. */
async function runTraySelfTest() {
  if (!demo) { console.log('SMOKE refused: UI scripts run only with --demo'); app.quit(); return; }
  const out: { name: string; ok: boolean; info?: string; error?: string }[] = [];
  const step = async (name: string, fn: () => Promise<string | void> | string | void) => {
    try { out.push({ name, ok: true, info: (await fn()) ?? undefined }); } catch (e) { out.push({ name, ok: false, error: (e as Error).message }); }
  };
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn: () => boolean, what: string, ms = 8000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error(`timed out waiting for ${what}`); await wait(50); } };
  const ctx = () => cx!.ctx;
  const sessions = () => ctx().db.all<{ id: number; ended_at: string | null }>('SELECT id, ended_at FROM time_sessions ORDER BY id');
  stopAll(ctx()); // start from idle even if the demo database was left with a running timer
  const task = addTask(ctx(), { title: 'TRAY test task', type: 'homework', due: 'in 1 day' });
  const menuLabels = () => (trayMenu?.items ?? []).map((i) => i.label).filter(Boolean);

  await step('the icon exists and is idle: no title, menu says nothing is running', async () => {
    if (!tray) throw new Error('no tray was created');
    await wait(200);
    if (tray.getTitle() !== '⏱') throw new Error(`idle title is "${tray.getTitle()}" (expected the timer glyph)`);
    if (menuLabels()[0] !== 'No timer running') throw new Error(`menu starts with ${menuLabels()[0]}`);
    const need = ['Quick add', 'Open Tally', 'Quit Tally'];
    for (const n of need) if (!menuLabels().some((l) => l!.startsWith(n))) throw new Error(`menu is missing ${n}: ${menuLabels().join(' | ')}`);
    if (!menuLabels().some((l) => l!.startsWith('Start timer'))) throw new Error('menu has no Start entry');
    return menuLabels().join(' | ');
  });

  await step('the icon image is valid: not empty, 16x16 points at @2x, a template image, with real pixels; the Tray is kept referenced', async () => {
    const d = trayDiagnostics();
    if (!d.created) throw new Error('no tray');
    if (d.imageEmpty) throw new Error('the icon image is EMPTY');
    if (d.size.width !== 16 || d.size.height !== 16) throw new Error(`size ${d.size.width}x${d.size.height}, expected 16x16`);
    if (!d.scaleFactors.includes(2)) throw new Error(`scale factors ${d.scaleFactors}`);
    if (!d.template) throw new Error('not a template image');
    if (d.visiblePixels < 100) throw new Error(`only ${d.visiblePixels} visible pixels`);
    await wait(1800);
    const later = trayDiagnostics();
    if (!later.created) throw new Error('the tray object was lost');
    return `image ok (${d.size.width}x${d.size.height} @${d.scaleFactors}, template, ${d.visiblePixels} px); macOS placed it: ${later.placed ? 'yes' : 'NO'} bounds ${JSON.stringify(later.bounds)}`;
  });

  let titleAtStart = '';
  await step('Start (from the menu) begins a timer; the icon shows the task and elapsed time', async () => {
    const item = trayMenu!.items.find((i) => i.label?.startsWith('Start timer'))!;
    (item as unknown as { click(): void }).click();
    await until(() => runningTimers(ctx()).length === 1, 'the timer to start');
    await until(() => /\d+:\d\d$/.test(tray!.getTitle()), 'the title to show elapsed time');
    titleAtStart = tray!.getTitle();
    if (!trayRunning) throw new Error('icon did not switch to the running glyph');
    if (!/Timer:/.test(lastTooltip)) throw new Error(`tooltip: ${lastTooltip}`);
    await until(() => menuLabels()[0]?.startsWith('Timer:') ?? false, 'the menu to show the timer');
    return `title "${titleAtStart}", menu: ${menuLabels().slice(0, 3).join(' | ')}`;
  });

  await step('the elapsed time keeps counting', async () => {
    await wait(2300); // the title refreshes once a second
    const now = tray!.getTitle();
    if (now === titleAtStart) throw new Error(`still "${now}" after 2.3 s`);
    return `"${titleAtStart}" -> "${now}"`;
  });

  await step('Stop (from the menu) records the session and the icon goes idle', async () => {
    const stop = trayMenu!.getMenuItemById('stop');
    if (!stop) throw new Error('no Stop entry while running');
    (stop as unknown as { click(): void }).click();
    await until(() => runningTimers(ctx()).length === 0, 'the timer to stop');
    await until(() => tray!.getTitle() === '⏱', 'the title to go back to the idle glyph');
    if (trayRunning) throw new Error('icon still shows running');
    if (sessions().some((x) => x.ended_at === null)) throw new Error('a session is still open');
    if (menuLabels()[0] !== 'No timer running') throw new Error('menu not idle');
    return 'recorded, idle again';
  });

  await step('closing the window hides it to the tray; the app, shortcut and icon keep running; Open Tally brings it back', async () => {
    createWindow();
    await until(() => !!mainWin && mainWin.isVisible(), 'the window to show', 12000);
    const w = mainWin!;
    w.close();
    await wait(300);
    if (w.isDestroyed()) throw new Error('the window was destroyed instead of hidden');
    if (w.isVisible()) throw new Error('the window is still visible');
    if (!tray || tray.isDestroyed()) throw new Error('the tray went away');
    if (currentAccel && !globalShortcut.isRegistered(currentAccel)) throw new Error('the global shortcut stopped working');
    showQuick();
    await wait(200);
    const quickShown = !!quickWin && quickWin.isVisible();
    quickWin?.hide();
    if (!quickShown) throw new Error('the quick-add window does not open while the main window is hidden');
    await trayAction('open');
    await until(() => w.isVisible(), 'the window to come back');
    return 'hidden (not destroyed), shortcut + quick add still work, Open Tally restores it';
  });

  await step('quitting with a running timer: Cancel keeps the app and the timer', async () => {
    await trayAction(`start:${task.id}`);
    const r = (await resolveQuit(cx!.ctx, async () => 'cancel')).action;
    if (r !== 'cancel') throw new Error(`got ${r}`);
    if (runningTimers(ctx()).length !== 1) throw new Error('the timer was lost on cancel');
    return 'still running';
  });

  await step('quitting with a running timer: Stop and save records the time (nothing lost)', async () => {
    const before = sessions().length;
    const r = (await resolveQuit(cx!.ctx, async () => 'stop')).action;
    if (r !== 'quit') throw new Error(`got ${r}`);
    const rows = sessions();
    if (rows.length !== before) throw new Error('the session disappeared');
    if (rows.some((x) => x.ended_at === null)) throw new Error('the session was left open');
    return 'session closed with an end time';
  });

  await step('quitting with a running timer: Keep running leaves it saved, and it is still running after a restart', async () => {
    await trayAction(`start:${task.id}`);
    const before = runningTimers(ctx())[0];
    const r = (await resolveQuit(cx!.ctx, async () => 'keep')).action;
    if (r !== 'quit') throw new Error(`got ${r}`);
    // simulate the restart: close the database and open it again
    cx!.close();
    cx = await openContext(demo);
    const after = runningTimers(ctx())[0];
    if (!after || after.sessionId !== before.sessionId || after.startedAtMs !== before.startedAtMs) throw new Error('the timer did not survive the restart');
    refreshTray(true);
    await until(() => /\d+:\d\d$/.test(tray!.getTitle()), 'the icon to show the surviving timer');
    stopAll(ctx());
    refreshTray(true);
    return `same session #${after.sessionId} still running after reopening; icon showed it`;
  });

  console.log('SMOKETRAY ' + JSON.stringify({ steps: out }));
  quitting = true;
  app.quit();
}

/**
 * A quit that has been decided (nothing running, or the person answered the dialog) finishes HERE, directly: release the shortcut and icon,
 * close the database, exit. It does not wait for the windows to close: in a real run on macOS, after answering the dialog, app.quit()
 * stalled for ~3.7 s before the windows let go (the log showed "calling app.quit()" and then nothing until a second Cmd+Q).
 * Nothing is lost by exiting directly: a running timer is a row in the database, and a stopped one was recorded before this point.
 */
let finishing = false;
function finishQuit() {
  if (finishing) return;
  finishing = true;
  quitting = true;
  trace('finishing the quit: releasing the shortcut and icon, closing the database, exiting');
  try { globalShortcut.unregisterAll(); } catch { /* going anyway */ }
  try { if (tray && !tray.isDestroyed()) tray.destroy(); } catch { /* going anyway */ }
  tray = undefined;
  try { cx?.close(); } catch { /* already closed */ }
  cx = undefined;
  trace('exit(0)');
  app.exit(0);
}

app.on('before-quit', (e) => {
  trace(`before-quit (quitting=${quitting}, asking=${quitAsked})`);
  if (quitting) return;
  e.preventDefault(); // every quit goes through the running-timer check first
  if (quitAsked) return;
  quitAsked = true;
  void resolveQuit(cx?.ctx, askUserAboutTimer, trace)
    .then((r) => {
      if (r.action !== 'quit') { trace('quit cancelled'); return; }
      finishQuit();
    })
    .catch((err) => trace(`quit handling failed: ${(err as Error).message}`))
    .finally(() => { quitAsked = false; });
});
// a system shutdown must not wait on a dialog: leave a running timer open (it is saved in the database) and go
app.whenReady().then(() => { powerMonitor.on('shutdown', () => { quitting = true; }); });
app.on('will-quit', () => {
  trace('will-quit: releasing the shortcut and icon, closing the database');
  globalShortcut.unregisterAll();
  if (tray && !tray.isDestroyed()) tray.destroy();
  tray = undefined;
  cx?.close();
  cx = undefined;
});
app.on('quit', (_e, code) => trace(`quit (exit code ${code})`));
app.on('window-all-closed', () => { if (!tray) app.quit(); });
