# FWRP Testing Guide

**For:** testers checking the Food Waste Redistribution Platform before release.
**Coordinator:** Nikhil. Send all reports to him (see section 4).

---

## 1. About this guide

### What FWRP is

FWRP connects people who have **surplus food** with organizations that **need food**, and with **volunteers** who carry it between them. Every donation follows the same path:

```
Provider lists food → Platform matches it to a nearby recipient → Recipient accepts
→ Admin assigns a volunteer → Volunteer picks up → Provider confirms handover
→ Volunteer delivers → Recipient confirms receipt → Donation completed
```

There are four kinds of users, and each sees different screens:

| Role | Who they are | What they do |
|---|---|---|
| **Provider** | Restaurant, hotel, caterer | Lists surplus food, hands it to the volunteer |
| **Recipient** | Shelter, NGO, food bank | Posts what it needs, accepts donations, confirms what arrived |
| **Volunteer** | Driver | Says when they are free, picks up and delivers |
| **Admin** | Platform staff | Verifies organizations, assigns volunteers, handles problems, sees reports |

### What you are checking

1. **Does each step of the workflow work?** Every button does what it says, and the next person in the chain sees the change.
2. **Does the app stop wrong actions?** For example, accepting a donation twice, entering a deadline in the past, or opening another role's pages.
3. **Is it clear and comfortable to use?** Wording, layout, error messages, and whether it works on a phone.

### How to use this guide

- Work through the sections **in order**. Test 1 (the full workflow) comes first, because most other tests build on it.
- Each test has an **ID** (for example `PRV-04`), **steps**, and **what should happen**. For each one, mark ✅ **Pass**, ❌ **Fail**, or ⚠️ **Works, but something is off**.
- If the result doesn't match "What should happen", write a bug report (section 4) using the test ID.
- Don't stop at the first problem. Note it and carry on.
- **Time needed:** about 3–4 hours for everything, or about 45 minutes for Test 1 alone.

---

## 2. Getting the app running

You run the app on your own computer. It connects to the shared online database.

### What you need

- **Node.js 22 or newer.** Check with `node -v` in a terminal. If it's older, install the LTS version from https://nodejs.org.
- **Git**, and access to the GitHub repository.
- **The backend `.env` file.** Nikhil sends it to you privately. It contains the database password, so never post it in a group chat or commit it.
- A modern browser (Chrome, Edge or Firefox), and ideally a phone for Test 9.

### First-time setup

```powershell
git clone https://github.com/AnujSaha0111/FWRP.git
cd FWRP\backend
# put the .env file Nikhil sent you into this folder (FWRP\backend\.env)
npm install
npx prisma generate
cd ..\frontend
npm install
```

### Every time you test

Open **two terminals**.

**Terminal 1, the backend:**
```powershell
cd FWRP\backend
npm run dev
```
Wait until it says `FWRP backend listening on port 3001`. Then check that http://localhost:3001/api/health shows `"db": "up (…)"`.

**Terminal 2, the frontend:**
```powershell
cd FWRP\frontend
npm run dev
```
Open **http://localhost:5173**.

Leave both terminals running while you test. To stop, press `Ctrl+C` in each.

> **Run `npm run migrate` or `npm run seed` only if Nikhil asks you to.** Both change the shared database for everyone (see section 3).

### If something goes wrong

| What you see | What to do |
|---|---|
| `'vite' is not recognized` | Run `npm install` in `frontend` |
| Login fails, or every page shows an error | The backend isn't running. Check terminal 1 |
| `EPERM … query_engine` during `prisma generate` | Stop the backend (`Ctrl+C`), run the command again, then restart the backend |
| A page takes several seconds | Normal. The database is far away. Report it only if it takes over 20 seconds |
| "Too many attempts, please wait" at login | You hit the login limit (10 failed tries). Wait 15 minutes or use another account |

---

## 3. Demo accounts and ground rules

All accounts use the password **`Password123!`**

| Email | Role | Notes |
|---|---|---|
| admin@fwrp.demo | Admin | |
| provider1@fwrp.demo | Provider | Spice Route Restaurant, MG Road |
| provider2@fwrp.demo | Provider | Grand Palace Hotel |
| recipient1@fwrp.demo | Recipient | Hope Shelter. Needs 60 vegetarian meals |
| recipient2@fwrp.demo | Recipient | City Food Bank. Needs bread and fruit |
| recipient3@fwrp.demo | Recipient | Little Hands Kitchen. **Not verified yet** (used in ADM-04) |
| volunteer1@fwrp.demo | Volunteer | Available for 3 days after seeding |
| volunteer2@fwrp.demo | Volunteer | Available for 12 hours after seeding |

### Demo data you start with

The demo data is in Bengaluru:

- **Donations:**
  - **Vegetable biryani**, 40 meals, Spice Route. **Expires 5 hours after the data was reset.**
  - **Fresh bread loaves**, 25 loaves, Grand Palace. Expires after 8 hours.
  - **Bananas and apples**, 15 kg, Spice Route. Expires after 24 hours.
- **Requirements:**
  - Hope Shelter: 60 meals, high priority.
  - City Food Bank: 20 loaves of bread, and 10 kg of fruit.
- **History:** one completed past delivery and one expired donation, so the dashboards have numbers.

### Ground rules: everyone shares one database

What one tester does, everyone sees. So:

1. **Nikhil assigns each tester a time slot or a set of accounts.** Two people using the same account, or accepting the same donation, will see each other's changes. That isn't a bug, but it makes results confusing.
2. **Only Nikhil resets the demo data** (`npm run seed`). Resetting signs everyone out and puts all donations back to the start. Ask him before Test 1 if the biryani has already been used or has expired.
3. **Create your own test data with your name in it**, for example a donation called "Test – Priya – rice". Others then know it's yours.
4. **Don't change the system settings** (ADM-10) beyond what the test says, and put them back afterwards. They affect matching for everyone.
5. Use **one browser per role** so you can stay signed in to several at once. For example: Chrome for the recipient, Edge for the admin, and a private window for the volunteer.

---

## 4. How to report what you find

### One report per problem

Copy this template for each bug:

```
Test ID:      PRV-04
Title:        Short summary, e.g. "Cancel button does nothing on donation page"
Account:      provider1@fwrp.demo
Browser/device: Chrome on Windows / Safari on iPhone 13
Steps:
  1. …
  2. …
What I expected: (copy "What should happen" from the guide)
What happened:   …
Severity:     Blocker / Major / Minor / Cosmetic
Screenshot:   attached
Time:         4 Nov, 3:42 pm
```

### Severity levels

| Severity | Meaning | Example |
|---|---|---|
| **Blocker** | You can't continue the workflow at all | "Accept" fails, so no delivery can happen |
| **Major** | A feature is wrong, but there is a way around it | Wrong quantity shown after delivery |
| **Minor** | Works, but confusing or awkward | An error message doesn't explain what to fix |
| **Cosmetic** | Looks wrong only | Text overlaps on a phone |

### Helpful extras

- **Screenshots or a screen recording.** On Windows press `Win + Shift + S`. On a phone use the screenshot buttons.
- **Error text from the browser.** Press `F12`, open the **Console** tab, and copy any red text.
- **Error text from terminal 1** (the backend), if a red error appears there when the problem happens.
- **Ideas and confusing wording are welcome too.** Mark them as "Suggestion".

### What to send back

When you finish, send Nikhil:
1. The **checklist from section 15**, with ✅/❌/⚠️ for every test.
2. **All your bug reports.**
3. **Two or three sentences** on your overall impression: what felt easy, and what felt confusing.

---

## 5. Test 1 — the complete donation workflow (do this first)

This follows one donation from listing to delivery, across all four roles. Keep four browsers or windows open, one per account. Check the time first: the biryani must be **less than 5 hours** past the last data reset. If you aren't sure, ask Nikhil.

| ID | Account | Steps | What should happen |
|---|---|---|---|
| **WF-01** | recipient1 | Sign in. Open **Matches**. | Cards appear, ranked best first. **Vegetable biryani** is at or near the top, with a match % (around 85–90%), the distance in km (about 1 km), "Pick up by …", and "For requirement: Prepared meals · 60 needed". |
| **WF-02** | recipient1 | On the biryani card, click **Accept**. Read the dialog, then click **Accept donation**. | A green message: "Accepted 'Vegetable biryani'. A volunteer will be assigned." The card disappears from Matches. |
| **WF-03** | provider1 | Sign in. Open **My donations** → **Active** → **Vegetable biryani**. | Status **Accepted**. Progress shows Listed ✓ and Accepted ✓. "Recipient: Hope Shelter, Accepted". Under Pickup: "Waiting for a volunteer". The **Edit** button is gone, because accepted donations can't be edited. |
| **WF-04** | provider1 | Click the **bell** (top right). | A notification "Donation accepted … (40 meals)". |
| **WF-05** | admin | Sign in. Open **Pickup queue**. | The biryani is listed under "Waiting for a volunteer", with "→ Hope Shelter" and its deadline. |
| **WF-06** | admin | Click **Assign volunteer**. | A dialog lists volunteers who are free during the pickup window (Vikram, and Neha if still available), with their free hours. |
| **WF-07** | admin | Select **Vikram (Volunteer)** → **Assign**. | "Volunteer assigned and notified". The biryani leaves the queue. On **Overview**, "Active deliveries" goes up by 1. |
| **WF-08** | volunteer1 | Sign in. | Dashboard banner: "You have a new pickup request". |
| **WF-09** | volunteer1 | Open the request (banner link, or **Assignments → New**). | Shows the food, quantity, a map with **Pickup** (amber) and **Drop-off** (green) points, both addresses, tappable phone numbers, and **Accept pickup** / **I can't make it**. |
| **WF-10** | volunteer1 | Click **Accept pickup**. | "Pickup accepted". The main button changes to **I'm at the pickup**. |
| **WF-11** | volunteer1 | Click **I'm at the pickup**. | The status changes to "At pickup". |
| **WF-12** | provider1 | Refresh the biryani page. | Under "Pickup & delivery": volunteer Vikram, delivering to Hope Shelter, and a box "The volunteer is at your pickup point…" with a **Confirm handover** button. |
| **WF-13** | provider1 | Click **Confirm handover**. | "Handover confirmed". The status becomes **Picked up**, and the progress shows Picked up ✓. |
| **WF-14** | volunteer1 | Refresh. The button should now say **I'm on my way**. Click it. | The status becomes "On the way". The button changes to **Delivered**, with an optional "Proof of delivery" field. |
| **WF-15** | volunteer1 | Type `Handed to John at the gate` in Proof of delivery, then click **Delivered**. | A message "Delivered. Waiting for the recipient to confirm…". |
| **WF-16** | recipient1 | The dashboard shows a yellow banner "1 delivery waiting for your confirmation". Open **Deliveries** → the biryani. | A route map, the timeline (Assigned ✓, Picked up ✓, Delivered ✓), and a **Confirm receipt** form with **Quantity received** set to 40. |
| **WF-17** | recipient1 | Change the quantity to **38**, enter "John" as Received by, then click **Confirm receipt**. | "Receipt confirmed. Thank you!" The panel shows "38 meals confirmed … by John". |
| **WF-18** | recipient1 | Open **Requirements**. | The Prepared meals requirement shows "**38 of 60 received**", with status **Partly fulfilled**. |
| **WF-19** | provider1 | Refresh the biryani page. | Status **Completed**, all progress steps ticked, "Received 38 meals". On the dashboard, **Completed** has gone up and "Redistributed" includes the meals. |
| **WF-20** | volunteer1 | Open the dashboard. | **Completed** has gone up by 1. Notifications include "Delivery completed". |
| **WF-21** | admin | Open **Overview**. | Completed donations and meals redistributed have gone up. Analytics also shows the biryani as completed. |

If all 21 steps pass, the core of the platform works.

---

## 6. Test 2 — sign in, registration, password and profile

| ID | Steps | What should happen |
|---|---|---|
| **AUTH-01** | Sign out. On the sign-in page, click **Sign in** with empty fields. | "Enter a valid email address" and "Enter your password" appear under the fields. Nothing is sent. |
| **AUTH-02** | Sign in as provider1 with the wrong password `wrong123`. | A red box: "That email and password do not match an active account." |
| **AUTH-03** | Sign in correctly. | You land on your role's dashboard (provider → provider dashboard). |
| **AUTH-04** | Click the **eye** icon in the password field. | The password becomes visible, and hidden again on a second click. |
| **AUTH-05** | Account menu (your name, top right) → **Sign out**. Then type `localhost:5173/provider` in the address bar. | After signing out you see the sign-in page. Opening the provider page sends you back to sign in. |
| **AUTH-06** | **Register a provider.** Sign out → **Create an account** → **I have surplus food**. Fill in name, a **new** email (e.g. `yourname.provider@test.com`), phone `+91 98450 11111`, a password of 8+ characters. Leave the organization fields empty and click **Create account**. | Errors for organization name, street address, and "Place the pin on your location". |
| **AUTH-07** | Fill in the organization name ("Test – yourname cafe"), choose a type and an address. **Click the map** to drop the pin. Click **Create account**. | You are signed in and land on the provider dashboard, with a yellow **"Verification pending"** banner. |
| **AUTH-08** | During registration, try **Use my location** (allow it when the browser asks), then try typing coordinates by hand. | The pin moves to your location, or to the typed coordinates. If you deny permission, a message tells you to click the map instead. |
| **AUTH-09** | Register a **volunteer** (**I can deliver**). | There is no organization section. After creating the account you land on the volunteer dashboard. |
| **AUTH-10** | Try registering with an email that already exists (e.g. `provider1@fwrp.demo`). | "Email is already registered" (shown under the email field or above the form). |
| **AUTH-11** | Phone `abc`, password `short`. | "Enter a valid phone number…" and "Use at least 8 characters". |
| **AUTH-12** | **Forgot password:** sign out → **Forgot password?** → enter `provider1@fwrp.demo` → **Send reset link**. Repeat with `nobody@nowhere.com`. | Both show the same "Check your email" screen, so it never reveals which emails exist. (The email itself isn't actually sent in this test setup; see section 14.) |
| **AUTH-13** | Open `localhost:5173/reset-password` (with no link). | "Reset link missing", with a link to request a new one. |
| **AUTH-14** | **Profile:** sign in with *your own* registered account → **Profile**. Change your name → **Save changes**. | "Profile saved". The new name shows in the top bar. |
| **AUTH-15** | **Change password:** on Profile, enter a wrong current password and a new password. | "Current password is incorrect" under the field. |
| **AUTH-16** | Enter the correct current password and a new password (type it twice). Save. Then sign out and sign in with the **new** password. | "Password changed…". Signing in with the new password works, and the old one no longer does. |
| **AUTH-17** | On Profile → **Organization**, move the map pin to a different spot → **Save organization**. | "Organization saved". After a refresh, the pin stays at the new spot. |

> In AUTH-14 to 17, use **your own** registered account, not the shared demo accounts, so other testers aren't affected.

---

## 7. Test 3 — food provider

Sign in as **provider1**, or as your own provider account once an admin has verified it.

| ID | Steps | What should happen |
|---|---|---|
| **PRV-01** | Open the **Dashboard**. | Four tiles (Active, Completed, Expired, Fulfillment rate), Your impact (redistributed and listed quantities), and Recent activity linking to donations. |
| **PRV-02** | **New donation:** click **New donation** → **List donation** without filling anything in. | An error under each required field. Nothing is saved. |
| **PRV-03** | Fill in: What is it "Test – yourname – rice", Category **Prepared meals**, Type "Vegetarian", Quantity **20**, Unit "meals". Set **Pick up by** to a time **before** "Available from". Submit. | "The deadline must be after the start". |
| **PRV-04** | Set Pick up by to about 3 hours from now. Submit. | You land on the new donation's page, with status **Available** and the message "Donation listed. Matching nearby recipients…". |
| **PRV-05** | On that page, look at **Matched recipients**. | Hope Shelter (and possibly others) with a match %, distance, and how much they need. If none show, click **Refresh**. |
| **PRV-06** | **Edit** the donation: change the quantity to 25 → **Save changes**. | "Donation updated". The page shows 25 meals. |
| **PRV-07** | Tick **Pickup is somewhere other than my organization**, then save without placing a pin. | "Place the pin on the pickup point". Place a pin and save; it then succeeds. |
| **PRV-08** | **My donations:** check the tabs Active / Completed / Expired & cancelled / All. | Each tab shows only donations in that state, and the counts beside the tabs match. |
| **PRV-09** | **Cancel** your test donation: **Cancel donation** → read the dialog → **Keep it**. Then cancel again and confirm. | "Keep it" changes nothing. Confirming shows "Donation cancelled", with status **Cancelled**, and it moves to the "Expired & cancelled" tab. |
| **PRV-10** | Open a completed donation (from Test 1, or the old "Paneer curry" one for provider2). | No Edit or Cancel buttons. Shows the volunteer, the times, and the received quantity. |
| **PRV-11** | On any donation, click **Report a problem**. | The Reports page opens with a dialog, and the **Donation ID is already filled in**. |
| **PRV-12** | As your **unverified** new provider (from AUTH-07), list a donation. | It is listed and gets matches. Unverified providers *can* list donations today; only recipients must be verified. The yellow verification banner stays visible. If you think providers should be blocked until verified, file a **Suggestion**. |

---

## 8. Test 4 — recipient organization

Sign in as **recipient2** (City Food Bank), so you don't disturb Test 1, which uses recipient1.

| ID | Steps | What should happen |
|---|---|---|
| **REC-01** | **Dashboard.** | Tiles: Matches for you, Open requirements, On the way, Available now. Plus "Received so far" and buttons for requirements and browsing. |
| **REC-02** | **Matches.** | Bread and fruit donations appear, with the bread matched to the bread requirement. Each card shows a match %, distance, deadline and the requirement it's for. |
| **REC-03** | **Decline** a match → confirm. | "Match declined". It disappears and doesn't come back after a refresh. |
| **REC-04** | **Requirements → New requirement**, then submit empty. | An error on each field. |
| **REC-05** | Create: Category **Dairy**, Type "Milk", Quantity 10, Needed by tomorrow, Priority **Critical**, Location (pre-filled). | It appears under **Active** with a "Critical priority" badge and "0 of 10 received". |
| **REC-06** | **Edit** it (change the quantity to 12). | It saves, and the list shows "0 of 12". |
| **REC-07** | **Cancel** it → confirm. | It moves to the **Closed** tab as **Cancelled**. |
| **REC-08** | Set a requirement's "Needed by" to a past time. | "The deadline must be in the future". |
| **REC-09** | **Browse donations:** filter by category **Bakery**. | Only bakery donations are shown. |
| **REC-10** | Click **Accept** on a donation → the dialog asks **For requirement**. Check the dropdown lists only *your* open requirements, then click **Cancel**. | Only City Food Bank's requirements are listed. Cancelling changes nothing. |
| **REC-11** | Only if Nikhil says it's free to take: accept the **bread** for the bread requirement. | "Accepted…". It then appears in the admin's Pickup queue (check with the admin tester). |
| **REC-12** | Sign in as **recipient3** (unverified). Open **Requirements**. | The **New requirement** button is disabled, and a "Verification pending" banner explains why. |
| **REC-13** | **Deliveries:** check the Incoming and Received tabs (recipient1 has data from Test 1). | Incoming lists deliveries on their way, and Received lists the confirmed ones with the quantity. |
| **REC-14** | On a delivery waiting for confirmation, set the quantity received **higher** than the donated amount. | An error that it can't exceed the donated quantity. |

---

## 9. Test 5 — volunteer

Sign in as **volunteer2** (Neha) unless the test says otherwise.

| ID | Steps | What should happen |
|---|---|---|
| **VOL-01** | **Dashboard.** | Tiles: Active deliveries, Completed, Upcoming availability, Average time to pickup. Plus "Current delivery" and "Get more pickups". |
| **VOL-02** | **Availability → Add a window**, with "Until" earlier than "From". | "The end must be after the start." Nothing is saved. |
| **VOL-03** | Add a window from tomorrow 10:00 to tomorrow 14:00. | "Availability added". It appears under Upcoming windows with "Starts in …". |
| **VOL-04** | Add a window that overlaps the one from VOL-03 (tomorrow 12:00–16:00). | An error that it overlaps an existing window. |
| **VOL-05** | Add a window longer than 7 days. | "A window can be at most 7 days." |
| **VOL-06** | **Delete** the window from VOL-03 (bin icon). | "Availability removed". It disappears. |
| **VOL-07** | **Decline flow** (ask the admin tester to assign volunteer2 to a donation): open the request → **I can't make it** → enter the reason "Car unavailable" → **Decline pickup**. | "Pickup declined…". It disappears from your list. **Admin:** it appears under "Declined by the volunteer" in the Pickup queue, with your reason. |
| **VOL-08** | **Admin reassigns** that donation to volunteer1. Then sign in as volunteer1. | volunteer1 sees the new request. |
| **VOL-09** | During a delivery, the screen always shows **exactly one** next-step button. | It's never possible to skip a step (for example from "Accepted" straight to "Delivered"). |
| **VOL-10** | On a delivery, tap the provider's **phone number** (on a phone). | The phone app opens to call. |
| **VOL-11** | **Assignments** tabs: New / In progress / Done. | Each delivery is in the right tab for its status. |

---

## 10. Test 6 — administrator

Sign in as **admin**.

| ID | Steps | What should happen |
|---|---|---|
| **ADM-01** | **Overview.** | 8 tiles (Pending pickups, Active deliveries, Active, Completed and Expired donations, Verified organizations, Active volunteers, Open reports). Each tile links to its screen. Below them are the impact numbers (meals, fulfillment %, expiry %, average times). |
| **ADM-02** | **Monitoring.** | Four panels: Delayed or missed, Waiting for a volunteer, Expiring soon (unclaimed), Active deliveries. "Updated … ago". **Refresh** works. |
| **ADM-03** | **Pickup queue:** open the Assign dialog for a donation. | Only volunteers free during the pickup window are listed. If none are free, a clear message says so. |
| **ADM-04** | **Verification** → **Pending** tab → **Little Hands Kitchen** (or your own new organization) → **Start review**. | It moves to the **Under Review** tab. **View location** opens a map at its pin. |
| **ADM-05** | On Under Review, click **Reject** → then **Reject** again with an empty reason. | "Give a short reason (3+ characters)". It isn't rejected. |
| **ADM-06** | Instead, **Verify** your own test organization (from AUTH-07). Sign in as that user. | "… verified". That user's yellow banner is gone, and they have a "verified" notification. |
| **ADM-07** | **Users:** search "vikram", and try the Role and Status filters. | Results match. |
| **ADM-08** | **Manage** *your own test volunteer* (AUTH-09) → **Suspend** → enter a reason → confirm. While signed in as that volunteer in another browser, click around. | "… suspended; signed out everywhere". Within a click or two, the volunteer is sent to the sign-in page and can't sign back in. |
| **ADM-09** | **Reactivate** that user. | They can sign in again. |
| **ADM-10** | **Settings:** change the **Matching radius** to 30 → Save. Then click **Default** to restore it. | "Matching radius saved". The value returns to 50 after Default. Changed-by and changed-time are shown. |
| **ADM-11** | **Settings → Match score weights:** set Distance to **3** → Save. | "Each weight must be between 0 and 1." Nothing is saved. |
| **ADM-12** | **Reports & disputes:** open a report filed in Test 2/3 (or file one first from any account) → **Resolve** with no note. | "Write a short resolution note for the reporter." With a note, it moves to **Resolved**, and the reporter gets a notification showing your note on their Reports page. |
| **ADM-13** | **Analytics & export:** set a date range of the last 7 days and category **Prepared meals** → **Apply**. | Totals, KPIs, Most active donors and recipients, and failed/cancelled donations update for those filters. |
| **ADM-14** | Click **Download CSV**. Open the file in Excel or Google Sheets. | One row per donation, with readable columns (food, provider, status, recipient, dates, quantity received). |
| **ADM-15** | **Activity log:** filter Record type **Donation**, then search for the action `DONATION_ACCEPTED`. | Entries with who, when, and the before/after values (e.g. status Available → Accepted). |
| **ADM-16** | Admin → **your name → Profile**, then try suspending **yourself** under Users. | The Users screen says "You cannot change your own account status." |

---

## 11. Test 7 — notifications, automatic expiry and alerts

The app runs some tasks automatically every minute. These tests involve **waiting**.

| ID | Steps | What should happen |
|---|---|---|
| **NOT-01** | As any user with notifications, open the **bell**. | A list, newest first. Unread ones are highlighted with a dot. The bell shows the unread count. |
| **NOT-02** | Click **Mark as read** on one notification, then **Mark all as read**. | The dot disappears, and the bell count drops to 0. |
| **NOT-03** | Click **View** on a notification. | It opens the related page (the donation, delivery, matches, or reports). |
| **NOT-04** | Use the **All / Unread** filter. | Unread shows only unread notifications. |
| **EXP-01** | **Expiry warning:** as provider1, create a donation "Test – yourname – expiring", with Pick up by **40 minutes** from now. Wait about 2 minutes, then check the bell. | A notification **"Donation expiring soon … expires in about 40 min"**. |
| **EXP-02** | **Auto-expiry:** create another donation with Pick up by **3 minutes** from now. Wait 5 minutes and refresh **My donations**. | It shows **Expired**, and a **"Donation expired"** notification arrives. It disappears from recipients' Browse and Matches. |
| **EXP-03** | As a recipient, create a requirement needed in **3 minutes**. Wait 5 minutes. | Its status becomes **Expired** (in the Closed tab). |
| **EXP-04** | **Missed pickup** (admin + volunteer): assign a volunteer to a donation whose window ends within a few minutes, and don't pick it up. After the window ends, check the admin's **Monitoring** and bell. | It appears under "Delayed or missed", and the admin gets a **"Pickup missed"** notification. |

---

## 12. Test 8 — access and security checks

| ID | Steps | What should happen |
|---|---|---|
| **SEC-01** | Signed in as **provider1**, type these into the address bar: `localhost:5173/admin`, `/recipient`, `/volunteer/availability`. | You're sent back to the provider dashboard every time. Other roles' screens never show. |
| **SEC-02** | Repeat as **recipient**, **volunteer** and **admin** with the other roles' addresses. | Same: each role only sees its own area. |
| **SEC-03** | As provider2, open provider1's donation by pasting its page address (copy it from provider1's browser). | "Donation not found", or an error. Never provider1's details. |
| **SEC-04** | As recipient2, paste recipient1's delivery page address. | An error. You never see another organization's delivery. |
| **SEC-05** | **Login limit:** sign out, and try to sign in as *your own* test account with a wrong password **11 times**. | From the 11th try: "Too many attempts, please wait and try again." (It unlocks after 15 minutes.) |
| **SEC-06** | Sign in to *your own* test account in two browsers. In browser B, change the password (Profile). Keep using browser A. | Browser B stays signed in. Browser A is sent to sign in **within 15 minutes** (when its short-lived session token renews and is refused). |
| **SEC-07** | Type `localhost:5173/this-does-not-exist`. | A friendly "Page not found" with a button home. |

---

## 13. Test 9 — phone, keyboard and general usability

| ID | Steps | What should happen |
|---|---|---|
| **UX-01** | **On a phone:** find your computer's IP address (`ipconfig` → IPv4, e.g. 192.168.1.20). In terminal 2, stop the frontend and run `npm run dev -- --host` instead. On the phone (same Wi-Fi), open `http://<that-ip>:5173`. Sign in. | The layout fits the screen with no sideways scrolling. The **☰ menu** opens the navigation. |
| **UX-02** | On the phone, do the volunteer delivery steps (WF-09 to WF-15). | The buttons are big enough to tap easily, and the map can be moved with a finger. |
| **UX-03** | On the phone, fill in the donation form and registration (with the map). | Fields don't hide behind the keyboard, and the date pickers work. |
| **UX-04** | **Keyboard only** (no mouse): press `Tab` repeatedly on the sign-in page and a dashboard. | A visible outline shows where you are. You can reach and press every button with `Enter`. On the first `Tab`, a "Skip to content" link appears. |
| **UX-05** | Open any dialog (e.g. Cancel donation), then press `Esc`. | The dialog closes. While it's open, `Tab` stays inside it. |
| **UX-06** | Make the browser window narrow, then wide. | The sidebar becomes a ☰ menu on narrow screens. Nothing overlaps or is cut off. |
| **UX-07** | Read the wording on every screen you used. | Note anything confusing, misspelled, or too technical, as a **Suggestion** report. |
| **UX-08** | Zoom the browser to 200% (`Ctrl` + `+`). | Everything is still readable and usable. |

---

## 14. Known limitations (not bugs)

Please **don't report these**. They are known and accepted for now:

1. **Emails are not really sent** in this test setup. "Forgot password", alerts and other emails are created but never delivered, so you can't complete the reset-password link by email. AUTH-12 only checks the request screen.
2. **Some pages take a few seconds to load**, because the database is hosted far away. Report it only if something takes over 20 seconds, or never finishes.
3. **Organization coordinates are picked on the map.** There is no address search. Typing an address doesn't move the pin.
4. **Reports need the donation or account ID typed in.** There is no search box in the report dialog; IDs are shown on donation pages and in Admin → Users.
5. **Times use your computer's clock and time zone.** If your clock is wrong, deadlines will look wrong.
6. **Shared database:** other testers' donations and actions appear in your lists (see section 3).
7. **Matches update every 15 minutes in the background**, or immediately after a change. A new donation may need **Refresh** on its page before matches show.
8. **One volunteer can only do one delivery at a time.** Assigning a busy volunteer is refused on purpose.

---

## 15. Final sign-off checklist

Copy this list, fill it in with ✅ Pass / ❌ Fail / ⚠️ Partly, and send it to Nikhil with your bug reports.

**Tester:** ____________ **Date:** ________ **Browser(s)/phone:** ________________

| Area | Tests | Result | Bug IDs / notes |
|---|---|---|---|
| Full workflow | WF-01 – WF-21 | | |
| Sign in & registration | AUTH-01 – AUTH-13 | | |
| Profile & password | AUTH-14 – AUTH-17 | | |
| Provider | PRV-01 – PRV-12 | | |
| Recipient | REC-01 – REC-14 | | |
| Volunteer | VOL-01 – VOL-11 | | |
| Admin | ADM-01 – ADM-16 | | |
| Notifications | NOT-01 – NOT-04 | | |
| Expiry & alerts | EXP-01 – EXP-04 | | |
| Access & security | SEC-01 – SEC-07 | | |
| Phone, keyboard, usability | UX-01 – UX-08 | | |

**Overall impression (2–3 sentences):**

&nbsp;

**The single most important thing to fix:**

&nbsp;

Thank you for testing!
