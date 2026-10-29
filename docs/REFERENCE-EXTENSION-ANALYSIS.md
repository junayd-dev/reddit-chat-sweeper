# How "Bulk Delete Reddit Messages & Chats" (Glench, v2.4) works

Analysis of the uploaded files, used as a reference only. No code from it is used in Reddit Chat Sweeper.

## Packaging

* Manifest V2, built with Vite and Svelte. Files named `*-loader.js` are tiny wrappers that dynamically `import()` the real bundle from `web_accessible_resources`.
* Three content scripts, one background script, one options/popup page.

## Pieces

| File | Role |
|---|---|
| `manifest.json` | Declares three content scripts, a non-persistent background script, `options_ui`, a popup, and permissions `storage`, `webRequest`, `extensionpay.com`, `glench-now.web.val.run`, plus `old.reddit.com` hosts. |
| `forward_to_messages.ts` (+loader) | Runs on `old.reddit.com/?bulk_delete_messages*`. Reads your username from the page (`.user a`), sends you to the login page if it says "Log in", otherwise redirects to `chat.reddit.com/?bulk_delete_name=<username>`. Old Reddit is used only as a convenient place to learn who is logged in. |
| `index.ts` (+loader) (`index_ts-fde0af3f.js`) | **The main tool.** Runs on `reddit.com/chat/?bulk_delete_name=*`. A Svelte UI is overlaid on Reddit's own chat page and drives it. |
| `index.ts-4de04d34.js` (background) | Starts ExtensionPay, opens the options page on install, and records `x-ratelimit-*` headers from `old.reddit.com/api` requests (used by a sibling post-deletion product; not part of chat deletion). |
| `Options.js` / `popup.html.js` / `options.html.js` | A small Svelte page: "Upgrade or log in" links, status of the paid tier, and a link to start. |
| `onpaid.ts` (+loader) | Runs on `extensionpay.com` so a finished payment can notify the extension. |
| `ExtPay.module.js` | The ExtensionPay library. Talks to `extensionpay.com/api/...` to create a key and look up whether the user has paid. |

## How chat deletion actually works

The extension does **not** call an API. It automates Reddit's chat web page by clicking buttons, one message at a time:

1. **List conversations.** Finds Reddit's custom elements (many are inside Shadow DOM): `rs-rooms-nav`, `rs-virtual-scroll`, `rs-rooms-nav-room`. It scrolls the virtual list to the bottom repeatedly so every room renders, and records each room's link, name and avatar.
2. **Open a conversation.** Scrolls the list until the room's link is found and clicks it, then waits until the timeline stops changing.
3. **Walk the timeline from newest to oldest.** Scrolls each `rs-timeline-event` into view.
4. **Delete one message.** Dispatches a `mouseenter` event so the hover toolbar appears, looks for `rs-timeline-event-delete-action` (which exists only on messages you wrote), clicks its button, waits for `rs-rpl-dialog-content`, clicks the dialog's `button.button-primary`, then waits 500 ms.
5. **Threads.** If a message has a `button.replies`, it opens the thread panel (`rs-thread`), deletes the replies there, closes it and continues.
6. **Optional "hide conversation".** Opens `rs-room-settings-button`, finds the menu entry with `icon-name="hide"` and confirms the dialog.

So what is technically possible follows from Reddit's own UI: you can delete your own messages (the delete control is absent on other people's) and hide a conversation. Nothing else.

## Business logic around it

* **Free tier:** counts conversations in `localStorage` (`bulk_delete_message_num_deleted`, `..._last_deleted_at`) and allows 1 conversation per 24 h. The reference clock comes from a request to `glench-now.web.val.run` (a third-party server).
* **Paid tier:** ExtensionPay reports `user.paid`; paid users can tick several conversations (checkboxes) while free users get single-select radio buttons.
* This is client-side gating. Reddit itself places no such limit; it is purely the extension's product decision.

## Weaknesses (why a different design is better)

* **Fragile:** depends on Reddit's internal element names and Shadow DOM layout. Any front-end change breaks it (the UI itself tells users to email the author if that happens).
* **Slow:** it has to render, scroll to, hover and confirm every message in the browser.
* **Must stay on screen:** the tab has to remain open and untouched.
* **Third-party calls:** ExtensionPay and a clock server are contacted.
* A visible bug in the bundle: the free-limit check inside the delete loop references variables `now` and `one_day` that are never defined.

## What Reddit Chat really is

Reddit Chat is a standard **Matrix** chat client talking to `matrix.redditspace.com`. "Delete message" is a Matrix *redaction* (`PUT /rooms/{room}/redact/{event}/{txn}`) that the server only permits for your own events. Reddit Chat Sweeper uses that route directly: the same operation the page performs, with no clicking, no payment gate and no third-party service. The trade-off is that these endpoints are not publicly documented by Reddit and can change.
