# 🎯 Warzone Services — Discord Store Bot + Web Control Panel

A complete store system for Warzone boosting: Discord bot, automatic server
organization, and a web Command Center to manage everything.

## ✨ What it does

**Auto server setup (zero work):** on its very first boot the bot organizes your
Discord server by itself — creates 📢 INFO (welcome / how-to-buy / vouches),
🛒 STORE (rank-boost / gun-leveling / camo-unlock / wins-and-packages),
🎫 TICKETS (private), 🔒 ADMIN (order-logs), posts the welcome message + buyer
guide, seeds 5 ready-made Warzone services and posts them to their channels.
You can re-run it anytime from the panel (Server Setup page) — it never
duplicates existing channels. Disable with `AUTO_SETUP=0`.

**Three service engines:**
| Engine | For | Buyer experience |
|---|---|---|
| 🏆 Ladder | Rank boost | picks current → target rank, price per tier auto-calculated |
| 🔫 Multi-select | Gun leveling, camo unlock | **selects MANY items at once**, total adds up; optional weapon-pick step for camos |
| 📦 Packages | Wins, kills, nuke, account levels | multi-selects packages, total adds up |

**Order flow:** Order button → pick options → private ticket → payment method →
receipt screenshot → you approve in the panel → buyer sends login via a secure
form → you click Complete → buyer gets DM + vouch reminder → revenue tracked.

**Web Command Center (`/panel.html`):** dashboard with revenue chart + launch
checklist, service editor with Warzone presets, payments with receipt previews,
per-ticket Complete buttons, orders + CSV export, customers + blacklist +
broadcast DM, coupons, server setup page, settings, logs, backup/restore.

## 🚀 Deploy with GitHub + Railway

1. **Create the Discord application** at https://discord.com/developers/applications
   → New Application → Bot tab → *Reset Token* (copy it — you'll paste it into
   Railway only, never into code or chat). Under **Privileged Gateway Intents**
   enable: Presence, Server Members, **Message Content**.
2. **Invite the bot** — OAuth2 → URL Generator → scopes `bot` +
   `applications.commands`, permissions **Administrator** → open the URL and add
   it to your *Warzone Services* server.
3. **Push this folder to a GitHub repo** (the included `.gitignore` keeps
   `data.json` and `.env` out of git):
   ```bash
   git init && git add . && git commit -m "Warzone Services bot"
   git branch -M main
   git remote add origin https://github.com/YOURNAME/warzone-services.git
   git push -u origin main
   ```
4. **Railway** → New Project → *Deploy from GitHub repo* → pick the repo.
5. Railway → your service → **Variables**:
   - `DISCORD_TOKEN` = your bot token
   - `PANEL_PASSWORD` = a strong password for the panel
6. Railway → **Settings → Networking → Generate Domain**. Open
   `https://your-app.up.railway.app/panel.html` and log in.
7. That's it — on first boot the bot organizes the server and lists the starter
   services. Then in the panel: **Settings** → add your payment methods
   (STC Pay / AlRajhi / PayPal) + your Owner Discord ID, and edit the starter
   services/prices to match your offers.

## 🧪 Tests
`test/run-tests.js` runs the real bot against offline mocks that enforce real
Discord limits and simulates full buyer flows for all three engines
(51/51 checks passing). Run with `node test/run-tests.js`. The `test/` folder
is optional in production.

## ⚠️ Security notes
- Never paste your bot token in chats, code, or GitHub — Railway Variables only.
  If a token ever leaks, reset it in the Discord Developer Portal.
- `data.json` holds customer data — it's git-ignored and NOT publicly served.
- Change `PANEL_PASSWORD` from the default before going live.
