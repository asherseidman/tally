# Stop the weekly Google reconnect (move the project to "In production")

**The problem.** Your Google Cloud project is in **Testing** mode. For an External app in Testing, Google expires every sign-in (and its refresh token) **7 days** after you consented. That is why scheduling stops working about once a week with "Google sign-in expired".

**The fix.** Change the project's *publishing status* from **Testing** to **In production**, as a **personal, unverified** app, then sign in once more. Refresh tokens from a production project normally last until something revokes them (see the last section).

Sources (checked 2026-11-13): Google's "Manage App Audience" help page (support.google.com/cloud/answer/15549945) and "Using OAuth 2.0 to Access Google APIs", section "Refresh token expiration" (developers.google.com/identity/protocols/oauth2). Google renames console pages now and then; if a button is labelled a little differently, look for the same words.

**Nothing about the app's permissions changes.** Do not touch the scopes. Tally keeps asking for exactly these three, and the guide below never edits them:

- `https://www.googleapis.com/auth/calendar.freebusy`
- `https://www.googleapis.com/auth/calendar.calendarlist.readonly`
- `https://www.googleapis.com/auth/calendar.app.created`

(No `calendar` or `calendar.readonly`, so event titles are never readable and your other calendars can never be edited.)

## Before you start
- Use the **same Google account that owns the Cloud project** (your personal account, per the notes in CLAUDE.md), not the U-M account.
- It takes about five minutes. Nothing in this guide gives anyone else access to your calendar: signing in still needs your Google password, and the app's client file stays on your Mac. (If you ever want to undo it, the Audience page has had a **Back to testing** button; the 7-day expiry then returns.)

## Step by step (Google Auth platform)

1. Open **https://console.cloud.google.com/auth/audience** in your browser (the page is called **Audience**; the older name for this area is *APIs & Services → OAuth consent screen*).
2. At the very top, make sure the **project picker** (next to the Google Cloud logo) shows **your Tally / planner project**. If it shows another project, click it and choose yours.
3. In the left menu you will see **Overview, Branding, Audience, Clients, Data Access, Verification Center, Settings**. You are on **Audience**.
4. Find the box titled **Publishing status**. It says **Testing**. Just under it there is a button, **Publish app**.
5. Look at **User type**: it should say **External**. Leave it as it is.
6. Click **Publish app**.
7. A dialog asks you to confirm that you want to push the app to production (it explains that the app becomes available to any user with a Google Account). Read it, then click **Confirm**.
8. The Publishing status now says **In production**. The **Test users** list stays on the page but no longer matters.

**Do not** click **Prepare for verification**, **Submit for verification** or anything on the **Verification Center** page. Verification is for apps with many users and is not needed for a personal one. Because the app stays *unverified*, Google caps it at 100 sign-ins over the project's whole lifetime (you are one) and shows a warning screen at sign-in (next section). Both are fine for a personal app.

**Do not** change anything on **Data Access** (that page lists the scopes above). If it lists exactly those three, you are done there.

## What you will see on the next sign-in
After publishing, Google shows a warning because the app is unverified and asks for calendar permissions (these calendar scopes count as "sensitive"):

1. A page titled **"Google hasn't verified this app"**.
2. Click **Advanced** (small, bottom left).
3. Click **Go to *your app's name* (unsafe)**. The "unsafe" only means "not verified by Google". The app is yours and the sign-in goes only to your own Mac.
4. Google lists the three permissions. Tick/allow them and click **Continue**.
5. The browser says "Connected. You can close this tab", and Tally shows **Connected**.

(In Testing mode you saw a different, milder warning. The new one is expected, not a sign something is wrong.)

## You must reconnect once afterwards
Sign-ins made while the project was in Testing **keep their 7-day limit** even after you publish. So make a fresh one:

- In Tally: **Settings → Google → Reconnect** (one click; it opens your browser), or in the terminal `npm run plan -- calendar connect`.
- Then in **Settings → Google**, set **My Google Cloud project is** to **In production** (it is only used to hide the 7-day countdown).
- The sign-in's age is shown in the same place. If it is still working when it is **more than 8 days old**, Tally records on its own that the project is in production.

If Google says it "did not return a refresh token": go to https://myaccount.google.com/permissions, remove the app, and Connect again.

## What can still revoke the sign-in (even in production)
From Google's "Refresh token expiration" list:

- **You (or an admin) removed the app's access** at https://myaccount.google.com/permissions. (Access removed = token dead.)
- **The sign-in was not used for 6 months.** Tally uses it whenever it plans, so this only matters if you stop using the app for half a year.
- **Too many sign-ins:** Google keeps at most **100** live refresh tokens per Google Account per client. Creating a new one silently kills the oldest. Reconnecting a few times is nowhere near that.
- **A password change** revokes a refresh token only if the token has Gmail scopes. Tally's calendar scopes are not Gmail scopes, so a password change **normally does not** log Tally out; if Google ever does revoke it, Tally will say so.
- A Workspace/organization admin restricting calendar access, or time-limited access, can also end it (not applicable to a personal account unless you set that up).
- Deleting or rotating the OAuth **client** (`google-client.json`) breaks sign-in in a different way (`invalid_client`): Tally tells you "Google does not recognise this app's OAuth client" and does **not** offer Reconnect, because signing in again would not help. Download the new Desktop-app client JSON and save it as `~/Library/Application Support/todo-planner/google-client.json`.

## What Tally does when it happens
- **Settings → Google** says what happened, in specific words, how old the sign-in was, and has a **Reconnect** button.
- The **Schedule** and **Availability** screens show the same message with a **Reconnect** button instead of a generic error.
- A **banner** and a desktop notification appear once ("Google sign-in expired", with Reconnect).
- If it was the 7-day Testing limit, the message says so and points here.
- While the project is known to be in Testing mode, Settings → Google shows when the current sign-in will expire and warns when it is within 2 days.
