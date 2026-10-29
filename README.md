# Reddit Chat Sweeper

A Firefox extension that deletes **your own** Reddit chat messages in bulk, and can remove conversations from your chat list.

You pick conversations from a checklist, press one button, and watch the progress. There is nothing to install besides the extension itself: no Python, no Command Prompt, no copying of tokens.

> **Please read this first (honest status).** I could not log in to a real Reddit account while building this, so it has been tested against a *simulated* Reddit chat server (20 automated tests plus a click-through of the real interface), **not against live Reddit**. Reddit's chat uses internal, undocumented web addresses that Reddit can change at any time. Because of that, **please try it on one conversation first** using the "Count my messages" button, then a real delete on a single unimportant conversation, before running it on everything. See [Troubleshooting](#troubleshooting) if something is off.

---

## What it can and cannot do

| Action | Possible? | Notes |
|---|---|---|
| Delete **your own** messages in a conversation | Yes | Includes thread replies. Reddit only allows deleting your own messages, and the server enforces that. |
| Delete **other people's** messages | **No** | Reddit does not allow it. The extension never tries. |
| Delete a conversation **for the other person** | **No** | Not possible on Reddit. |
| **Leave** a conversation (removes it from your list) | Yes | Your messages stay visible to the other people unless you delete them first. |
| Decline a **chat request** you never accepted | Yes | Use "Leave only". |
| Old-style private messages (the inbox at reddit.com/message) | **Not covered** | That is a different system from Chat. |

Good to know:

* **Deleting is permanent.** When you delete a chat message on Reddit, it is removed for *everyone* in the conversation, not just for you.
* **Leave after deleting, not before.** Once you have left a conversation you can no longer delete what you left behind. That is why "Delete my messages, then leave" only leaves a conversation if *every* deletion in it succeeded.
* Reddit may keep its own internal backups or logs. This tool can only do what Reddit's chat lets you do yourself.
* Reddit rate-limits chat requests. The extension slows down automatically when asked. Large histories (thousands of messages) can take a while. Roughly 2 to 3 messages per second is typical.

---

## Install in Firefox (Windows, about 2 minutes)

You need **Firefox 140 or newer** (check under menu ☰ → Help → About Firefox).

1. **Unzip** the downloaded `reddit-chat-sweeper.zip`. Right-click it → **Extract All…** → Extract. Remember where the folder is.
2. In Firefox, type `about:debugging` in the address bar and press Enter.
3. Click **This Firefox** on the left.
4. Click **Load Temporary Add-on…**
5. Browse into the unzipped folder and select the file **`manifest.json`**, then click Open.
6. The extension is now loaded. Click the puzzle-piece icon in Firefox's toolbar and pin **Reddit Chat Sweeper**, or just click it from that menu.

**Important:** Firefox removes temporary add-ons when you close Firefox. After a restart, repeat steps 2 to 5 (about 20 seconds). This is a Firefox rule for unsigned extensions, not a bug.

> **Private windows:** Firefox does not run extensions in private windows unless you allow it. Use a normal window.

---

## Use it

1. **Log in to Reddit** in Firefox as usual.
2. Click the **Reddit Chat Sweeper** toolbar button. A new tab opens.
3. **Step 1, Connect.** Press **Open Reddit Chat** (or skip ahead: *Load my conversations* will open it for you). Let the Reddit Chat page finish loading. The extension quietly notices the session that page uses; the green dot appears. Leave that Reddit tab open; it keeps the session fresh.
4. **Step 2, Pick conversations.** Press **Load my conversations**. Tick the ones you want, or use **Select all shown**. The filter box narrows the list by name.
5. **Step 3, Choose what to do**:
   * **Delete my messages**: the conversation stays in your list.
   * **Delete my messages, then leave**: also removes it from your list.
   * **Leave only**: removes it from your list, keeps your messages visible to others.
6. **Recommended:** press **Count my messages (deletes nothing)** first. It only counts.
7. Press **Delete selected…**, read the confirmation, tick *I understand this cannot be undone*, and confirm.
8. Watch the **Progress** panel. Each conversation shows its own status. **Stop** ends the run safely at any time.
9. The final message says how many deletions **Reddit confirmed**, how many failed, and why.

Leave the Sweeper tab open while it works. If you close it, the run stops (nothing breaks; run it again and it continues, because already-deleted messages are skipped).

---

## Privacy and permissions

Everything runs on your computer. The extension talks to **one** server: Reddit's chat server (Reddit's chat servers on `redditspace.com`). No analytics, no accounts, no third-party servers, no payment checks.

| Permission | Why |
|---|---|
| `https://*.redditspace.com/*` | To list your conversations and delete your messages, using the same chat server Reddit's own website uses. |
| `https://www.reddit.com/*` (and `reddit.com`) | Lets a tiny script run on Reddit pages. It only watches for the login header that the page sends to Reddit's chat servers, and for nothing else. |
| `webRequest` | Read-only. A second way to notice that same login header. It cannot block or change anything. It also counts which Reddit host names the page contacts (names and numbers only) for the troubleshooting panel. |
| `storage` | Holds the session token **in memory only** (`storage.session`). It is never written to disk and disappears when you close Firefox. |

* Your password and Reddit cookies are never read or sent.
* Your message **text** is never read, stored or logged. The extension only looks at who sent each message and its ID.
* The optional activity log contains conversation names and counts only, and is saved only if you press *Save log*.
* Firefox is told this add-on collects no data (`data_collection_permissions: none`).

---

## Troubleshooting

**"No Reddit chat session detected" / "Not connected yet" never turns green**
Work through these in order:
1. **Press the blue "Allow access" button** in step 1 if you see it. Firefox requires you to allow site access for extensions separately. (Or: `about:addons` → *Reddit Chat Sweeper* → **Permissions** → switch everything on.)
2. **Open Reddit Chat in a normal window** (not private), logged in, `https://www.reddit.com/chat`, and wait until your chat list appears. After allowing access, always press **F5** on that Reddit tab so the extension's helper script is loaded into it.
3. Look at the line under step 1 and open **Troubleshooting details**. It shows how many chat requests were seen and which Reddit hosts the page is talking to.
   * **Nothing seen at all:** Firefox is not letting the extension watch the page. Re-check step 1, private windows, and other extensions that block scripts or trackers on reddit.com (try pausing them for reddit.com).
   * **Seen, but no login header:** Reddit changed how chat logs in. Press *Copy these details* and share them; the host list shows where chat traffic actually goes.
4. **Last resort:** the same panel has a manual option: copy the token from Firefox's developer tools (the steps are written there) and paste it in. It is kept in memory only. Never share it with anyone.

**"Reddit says your chat session has expired"**, see the next entry.

**"Reddit says your chat session has expired"**
Reddit's session tokens are short-lived (roughly an hour). Switch to the Reddit Chat tab, press **F5** to refresh it, wait for the chats to load, go back and press the button again. Finished work is skipped.

**"Reddit is asking us to slow down"**
This is normal for long runs; the extension waits and continues more gently. If it gives up, wait a few minutes and start again.

**Some messages "could not be deleted"**
The summary shows an example reason. Press the button again to retry just those. A conversation is never left while it still has failures.

**The conversation is still in my list after deleting**
That is expected for *Delete my messages*. Choose *Delete my messages, then leave* (or *Leave only*) to remove it.

**Names look odd or say "Unnamed conversation"**
Reddit does not always provide names. Group chats and some DMs can look generic; the first few members are shown when known.

**I see no messages deleted but there were some**
Run *Count my messages*. If it says 0 but you know you wrote messages, Reddit may store that message type differently. Please note which kind (text, image, GIF) so it can be extended.

**Everything worked yesterday, today nothing does**
See below.

### If Reddit changes something

The extension relies on Reddit's *unofficial* chat interface (the standard Matrix chat protocol on `matrix.redditspace.com`). If Reddit changes it, the usual symptoms are *Not connected yet*, *HTTP 404* or *HTTP 400* errors. Developers can look at the three small files in `lib/` and `background.js`; the extension follows whichever `redditspace.com` address Reddit's own page is using; the pattern lives in `background.js` and `host_permissions` in `manifest.json`.

---

## For developers

```
reddit-chat-sweeper/
  manifest.json        Firefox Manifest V3, minimal permissions
  background.js        Notices the session token; opens the app tab
  app/                 The interface (app.html, app.css, app.js)
  lib/matrix.js        Small Matrix client: retries, rate limits, auth handling
  lib/sweeper.js       The delete / leave job and its safety rules
  icons/icon.svg
  tests/               Automated tests with a pretend Reddit chat server
  docs/                How the reference extension works
```

Run the tests (needs Node 20+; no installs required): `npm test`

How a deletion works: Reddit Chat is a Matrix chat service. For each conversation the extension pages backwards through its history (filtered to messages you sent) and sends a Matrix *redaction* for each one. A deletion is counted only when Reddit replies with the ID of the redaction event. Anything else is counted as a failure.

Safety rules baked into the code:

* Only events whose sender is *you* are ever redacted (checked again on your computer even if the server filters).
* Deleted counts only include confirmations from Reddit.
* Expired token → the run stops with counts intact; a refreshed token is picked up automatically if Reddit renews it mid-run.
* 429 rate limits → wait the time Reddit asks for, then slow the pace.
* Never leaves a conversation that still has failed deletions.

## Not affiliated with Reddit

This is an independent project. It is not affiliated with or endorsed by Reddit, Inc. or by the authors of any other extension. Use it only on your own account. MIT licence, no warranty.
