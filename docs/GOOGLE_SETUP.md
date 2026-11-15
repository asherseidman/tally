# Set up Google Calendar for Tally (free, about 15 minutes)

**Tally works without this.** The Availability grid is enough to plan. Do this only if you want Tally to see your calendar's busy times and write your planned study blocks to a calendar named **Planner Blocks**.

Tally does not ship with a Google client, so you create your own, free, in your own Google account. Nobody else (including the developer) ever sees it.

*Checked against Google's current documentation on **2026-11-15** (Google Workspace "Create a Google Cloud project", "Configure the OAuth consent screen", "Create access credentials", the Cloud Console help pages "Manage App Audience", "Manage App Data Access", "Manage OAuth Clients", and the Calendar API quickstart). Google renames console pages now and then; if a label differs slightly, look for the same words.*

**Use a personal Google account.** School and work accounts are often set by an administrator to block apps like this.

## 1. Create a project
1. Open **https://console.cloud.google.com/projectcreate** (menu **IAM & Admin > Create a Project**).
2. **Project name**: anything, for example `Tally`. Leave **Location** as it is. Click **Create** and wait a few seconds. Make sure the new project is selected in the project picker at the top.

## 2. Turn on the Google Calendar API
Open **https://console.cloud.google.com/flows/enableapi?apiid=calendar-json.googleapis.com**, confirm your project is selected, and click **Enable**. (Or: menu **APIs & Services > Library**, search "Google Calendar API", **Enable**.)

## 3. Configure the Google Auth platform
Open **https://console.developers.google.com/auth/branding** (menu **Google Auth platform**). If it says *Google Auth platform not configured yet*, click **Get Started** and:
1. **App information**: App name `Tally`, and a **User support email** (yours). **Next**.
2. **Audience**: choose **External**. **Next**.
3. **Contact information**: your email address. **Next**.
4. **Finish**: tick *I agree to the Google API Services: User Data Policy*, then **Continue** and **Create**.

## 4. Add the three scopes (and yourself as a test user)
1. Open **Data Access** (https://console.developers.google.com/auth/scopes) and click **Add or remove scopes**. In the **Manually add scopes** box, add exactly these three, one per line, then click **Update** and finally **Save**:

   ```
   https://www.googleapis.com/auth/calendar.freebusy
   https://www.googleapis.com/auth/calendar.calendarlist.readonly
   https://www.googleapis.com/auth/calendar.app.created
   ```
   Nothing else. These let Tally read only free/busy times (never event titles or details) and the list of your calendars, and create and manage events only on the "Planner Blocks" calendar it creates. It cannot edit your other calendars.
2. Open **Audience** (https://console.developers.google.com/auth/audience). Under **Test users** click **Add users**, enter your own Google address, **Save**.

## 5. Create the OAuth client and download it
1. Open **Clients** (https://console.developers.google.com/auth/clients) and click **Create Client**.
2. **Application type**: **Desktop app**. Name it anything. Click **Create**.
3. **Download the JSON now.** Google shows the client secret only when the client is created, and only the last four characters afterwards. (If you miss it: open the client, **Add secret**, and download the new one.) Keep the file private; do not put it in a repository or share it.

## 6. Give it to Tally and connect
1. In Tally: **Settings > Google > Set up Google Calendar > Choose client file…** and pick the JSON. Tally checks it is a Desktop-app client and saves it on your Mac. It shows only the end of the client ID, never the secret.
2. Click **Connect**. Your browser opens.
3. Pick your account. You will see **"Google hasn't verified this app"**. That is expected, because it is your own app. Click **Advanced**, then **Go to Tally (unsafe)** (it shows the app name you chose in step 3). Google lists the three permissions; allow them and click **Continue**. (Google's own help page shows this warning screen only as a picture, so the exact button wording here follows what Google has shown for unverified apps and may differ slightly.) The page says it is connected; return to Tally, which now shows **Connected**.

## 7. Stop the weekly reconnect
While the project is in **Testing**, Google expires every sign-in **7 days** after you gave consent. To end that:
1. Open **Audience** again, check **User type: External**, and click **Publish app** (confirm). Publishing status becomes **In production**.
2. Do **not** submit the app for verification. For a personal app you don't need to; Google then shows the "not verified" screen above and caps the project at 100 sign-ins in total (you are one).
3. Sign-ins made during Testing keep their 7-day limit, so in Tally click **Reconnect** once (**Settings > Google**) and set *My Google Cloud project is* to **In production**.

More detail on what can still end a sign-in: [GOOGLE_PRODUCTION.md](GOOGLE_PRODUCTION.md).

## Where your data goes
- **Everything stays on your Mac.** Tally has no server and sends nothing to the developer.
- The client file is `~/Library/Application Support/todo-planner/google-client.json` (only you can read it). Your sign-in token is in your macOS **Keychain**, not in a file.
- Tally talks only to Google, from your Mac, using your own client. It reads free/busy times and writes only to the "Planner Blocks" calendar.

## Disconnect or revoke
- **Disconnect**: Settings > Google > **Disconnect** removes the sign-in from your Keychain. **Remove client file** deletes the client file.
- **Revoke on Google's side**: open **https://myaccount.google.com/permissions**, choose the app, and remove access. To delete the client altogether, use the **Clients** page in the Cloud console.

## Troubleshooting
- **"Access blocked" / "app is not verified" with no Advanced link, or you can't sign in**: a school or work account may be blocked by its administrator; use a personal account. In Testing mode, make sure you added yourself under **Audience > Test users**.
- **"Choose client file" says it is a Web client**: create a new client with **Application type: Desktop app**.
- **"Google did not return a refresh token"**: remove the app at myaccount.google.com/permissions and press Connect again.
- **"Google does not recognise this app's client"** (or `invalid_client`): the client was deleted or its secret rotated; download a new JSON and choose it again. (Google also deletes OAuth clients unused for six months.)
- **Sign-in stopped working after about a week**: the project is still in Testing; see step 7.
- **"redirect_uri_mismatch"**: you probably chose a Web client; use a Desktop app client.
