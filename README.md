# Brain Dump — Nag Me Until It's Done

A dead-simple to-do list: dump what's on your mind, and if you don't finish a task
within an hour it nags you on Slack — then again every hour until you check it off,
until you get annoyed and just do it.

This **always-on** version runs a tiny Node server, so it keeps nagging even when no
browser is open. (There's also a standalone `index.html` that needs a tab kept open —
see the bottom.)

---

## Requirements

- **Node 18 or newer** (uses the built-in `fetch` — no `npm install`, no dependencies).
  Check with: `node -v`

## Run it

```bash
cd nag-server
node server.js
```

Then open **http://localhost:3000**.

## One-time Slack setup

1. Go to https://api.slack.com/apps → **Create New App** → *From scratch*.
2. Pick your workspace, name it (e.g. "Brain Dump").
3. In the sidebar, open **Incoming Webhooks** → toggle **On**.
4. Click **Add New Webhook to Workspace** → choose the channel (or your own DM) → **Allow**.
5. Copy the webhook URL (`https://hooks.slack.com/services/...`).
6. In the app, click **⚙ Settings**, paste the URL, hit **Send a test message** to confirm, then **Save**.

You can also set it without the UI:

```bash
SLACK_WEBHOOK_URL="https://hooks.slack.com/services/XXX" node server.js
```

## Settings

- **Deadline (minutes)** — how long before a new task is "overdue" (default 60).
- **Nag every (minutes)** — how often it re-nags after that (default 60).
- **Quiet hours** — no nags in this window (default 10:00pm–8:00am, server's local time).
  Anything that comes due overnight gets nagged when quiet hours end.

Tasks and settings are saved to `tasks.json` and `config.json` next to the server.

---

## Keep it always on

The point is that it runs even when you're not looking. Options:

- **Leave the terminal running** on a machine that stays on.
- **Run in the background** with [pm2](https://pm2.keepmetrics.io):
  ```bash
  npm install -g pm2
  pm2 start server.js --name brain-dump
  pm2 save
  ```
- **Deploy to any always-on host** (Render, Railway, a VPS, a Raspberry Pi). Set
  `SLACK_WEBHOOK_URL` as an env var and point a persistent disk at `DATA_DIR` if the
  host has ephemeral storage.

> Note: plain **GitHub Pages won't work for the always-on version** — it only hosts
> static files and can't run a server or send Slack messages. Use the standalone file
> below for GitHub Pages.

---

## Standalone (no server)

The file `public/index.html` also works on its own — just open it in a browser or host
it on GitHub Pages. It stores tasks in the browser and sends the Slack nags itself, so
**the tab has to stay open** for nagging to fire. The page tells you which mode it's in
via the badge under the title.
