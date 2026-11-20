<div align="center">

<img src="src/client/public/assets/logo/logo-128.png" width="84" alt="Agent Frontdesk logo">

# Agent Frontdesk

**Coordinate work across the desktop AI chats you already use.**<br>
The collaboration fork of [Phz-06/agent-frontdesk](https://github.com/Phz-06/agent-frontdesk).

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Platform: macOS · Windows 11](https://img.shields.io/badge/platform-macOS%20%C2%B7%20Windows%2011-lightgrey.svg)
![Node 22.16+](https://img.shields.io/badge/node-%E2%89%A5%2022.16-brightgreen.svg)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-orange.svg)](CONTRIBUTING.md)

[What this fork adds](#what-this-fork-adds) · [Quick start](#quick-start) · [Add an AI](#add-an-ai) · [How it works](#how-it-works) · [Roadmap](#roadmap) · [简体中文](README.zh-CN.md)

<table>
<tr>
<td width="50%">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/frontdesk-en-dark.png">
  <img src="docs/images/frontdesk-en-light.png" alt="A rail of AI avatars on the left with what each one just said, projects and chats in the middle, and a running conversation on the right" width="100%">
</picture>
</td>
<td width="50%">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/frontdesk-preview-en-dark.png">
  <img src="docs/images/frontdesk-preview-en-light.png" alt="A Codex chat with the README its reply mentions opened in the preview on the right" width="100%">
</picture>
</td>
</tr>
<tr>
<td align="center"><sub>Several AIs at work, each with its latest line next to its avatar</sub></td>
<td align="center"><sub>A file from a reply opens in the preview on the right, and the desktop app is one click away</sub></td>
</tr>
</table>

</div>

## What this fork adds

The original Agent Frontdesk brings existing desktop AI chats into one web console. It supports continuing chats, handling approvals and quoting one chat in another. Your desktop apps run the work and keep the native history.

This branch lets several native chats work on one task. For example, ask the coordinator to find two existing chats, have them review the same change, and check progress while they work. The group results link back to the desktop turns that produced them.

| Addition | What you can do |
| --- | --- |
| [Coordinator](#coordinator) | Use a dedicated Codex or Antigravity chat to find, remember and delegate to existing sessions. Receipts show the instruction, the reply and any delivery still being confirmed. |
| [Group tasks](#groups) | Combine existing chats with dedicated group members. Check progress without starting a new desktop turn, amend or replace a task, and see which revision each result belongs to. Hosts and members keep their native context and receive selected excerpts. |
| [WeChat](#message-the-coordinator-from-wechat) | Send private text to a paired coordinator and receive its replies. Approvals and plan decisions use the desktop workflow. |
| Additional engines and inbox views | Use the optional [DeepSeek Harness bridge](docs/skins/dsh/progress.md) to send to DSH. Browse [WorkBuddy history](docs/skins/workbuddy/progress.md) and jump to its desktop app for sending. Find recent unread chats, desktop pins and requests that need your input. |

Codex and Antigravity can act as coordinators or start new group hosts. Existing Codex, Antigravity, Claude and DSH chats can join groups when their adapters support sending. Automated tests exercise group dispatch and recovery with simulated desktop sessions. Live behavior depends on the engine and desktop version.

## Features

- All your AIs sit in a rail on the left. You can see who is running, who has a new reply and how much quota is left, and each one's latest line pops up next to its avatar
- Each AI’s sidebar shows up to three recent unread chats, then desktop pins, projects, and recent chats. Use **All chats** below the search box to change views. The browser remembers the view for each AI. Click the **!** badge or select **Needs your input** in the sidebar to see chats awaiting a decision. Reading a chat keeps it on the list until the request clears.
- Continue any chat, or start a new one in a project
- Send, steer a running turn, queue, stop. Switching to another AI while one is running does not interrupt it
- Change the model, reasoning effort and permissions, attach images and files, dictate
- Refer to another AI's chat: Frontdesk attaches that chat to your message as a card you can also turn into text to edit, with the older turns of a long chat shortened
- Answer the AI's questions and approval requests right in the page
- Replies look the way each desktop app shows them, with code, maths, diagrams, tool steps and plans
- A file mentioned in a reply opens in a preview on the right with one click, or shows in Finder / File Explorer
- Any chat opens in its desktop app with one click, on the same session
- Switch AIs on and off, rename them, reorder them, change their avatars. Light and dark, English and Chinese

## Quick start

You need macOS or Windows 11 and [Node.js](https://nodejs.org) 22.16 or later. Nothing else is installed: the helper that works the desktop apps' windows is compiled on your machine, with Xcode's command line tools on macOS and with the C# compiler that ships with Windows (.NET Framework 4) on Windows.

```sh
git clone --branch frontdesk-collaboration https://github.com/UltraClr/agent-frontdesk.git
cd agent-frontdesk
npm ci
npm start
```

Open <http://127.0.0.1:4100>. Every AI whose desktop app is installed shows up in the rail, and you can switch them on and off under **+**.

Open and sign in to the desktop apps you want to use. The built-in desktop engines are Codex, Claude and Antigravity. See the [DSH setup guide](docs/skins/dsh/progress.md) to enable sending with DSH.

On macOS, sending to Codex and Claude needs the Accessibility permission. In System Settings → Privacy & Security → Accessibility, allow the terminal app you run `npm start` in, then start Frontdesk again. On Windows 11 there is no permission to grant; run Frontdesk with the same rights as the desktop apps (both as administrator, or neither), since Windows lets a program read a window of a higher-rights app but not act on it. For now, keep the desktop apps' interface in English.

Claude's model list, quota and voice input also need Claude Code signed in once, with the account the desktop app uses. When it is not, the page shows the command to run in a terminal.

If the port is taken, run `PORT=4200 npm start` (or in Windows PowerShell: `$env:PORT=4200; npm start`).

## What to expect on Windows

On macOS, Frontdesk presses buttons in a desktop app's window without that window taking the keyboard. Windows doesn't allow it: whenever Frontdesk fills in a message or presses Send in Claude's or Codex's window, that window takes the keyboard focus for a moment. We keep that moment short and put everything back afterwards, but you may still notice it:

- **Typing elsewhere while a message goes out.** One message takes the focus 2–3 times, 20–90 ms each. Frontdesk waits for a pause when you type in its own page, but in other apps a word you're composing with an input method can be cut off, or a key lost.
- **Changing the model or effort.** The app's menu only works while the app has the focus, so for about half a second your keystrokes go to the app.
- **Full screen.** If the program in front runs in exclusive full screen, Frontdesk holds the message until you leave it. A borderless full-screen window may stutter for a moment.
- **A few pixels in a corner.** While it works, the app's window sits off screen except for a corner, and goes back where it was afterwards. If the server stops halfway, the next start puts it back.
- Codex's regular messages, steers, stops and most model changes use its own channel and aren't affected. A new Codex chat, and a model change for a chat Codex has not opened yet, go through its window like Claude's.

If you know a way to act on a Chromium/Electron window on Windows without it taking the focus, please get in touch. What we've tried and measured is in [docs/windows.md](docs/windows.md).

### Coordinator

DeepSeek Harness can join the agent rail and receive work from a coordinator. Install the local package from `integrations/dsh-frontdesk-bridge` in the DSH desktop profile, enable **Agent Frontdesk bridge** in **Settings → Plugins**, and restart DSH. [DSH setup and supported actions](docs/skins/dsh/progress.md)

Click the robot at the top of the rail to open your last-used coordinator chat. Choose Codex or Antigravity as the coordinator. Each keeps a separate project under `agent-frontdesk/<engine>-controller/` in its data directory. For Codex, open the setup draft, confirm the folder in the desktop app if prompted, and send the draft there once. After Frontdesk verifies the native chat and its folder, you can send tasks in the browser.

The agent icons below open their regular chats. Ask the coordinator to find an existing Codex, Antigravity, or Claude coding chat, check its progress, or send it a message. Delegated tasks are tracked in the sidebar. Frontdesk can follow them with the browser closed while its server is running.

To run a separate instance, set `BRIDGE_COORDINATOR_PROFILE` to a name such as `test` and set `PORT` to a free port before starting Frontdesk. Coordinator projects for that profile live under `agent-frontdesk/profiles/<name>/`. Use a different `BRIDGE_SETTINGS_FILE` if the instances should also have separate settings.

Click **Remember chats** and describe a project, topic, or task. The coordinator can save any matching chat with a short description and an optional alias. Delegating work also remembers the target chat. Later you can say “Have the chat that collected the interviews add yesterday’s notes.” The coordinator checks its saved chats and asks you to choose if several fit. Each coordinator keeps its own list across restarts. Its local tool supports `track`, `workers`, and `untrack`. Expand a dispatch receipt to see the instruction, the target’s reply, or a delivery error. Once the desktop confirms delivery, **Open target chat** takes you to that turn. When you ask the coordinator to act on a reply, the tool uses `send` with `followUp: true` to start a follow-up turn. Receipts without a known source turn appear in the dispatch history at the bottom of the conversation.

#### Groups

Create a group from the coordinator sidebar or ask your coordinator to group the chats it found. Choose an agent to start a host chat or select an existing chat as the host. For a new Codex host, open the desktop setup draft when prompted. If host setup fails, you can select another host in the same group. Coordinators share the group directory.

Use **Manage members** to add existing chats, set up dedicated members, or remove members after creating the group. Choose a member as the recipient to ask it directly. Choose the host for a multi-step discussion or summary. A decision links back to its native turn and can be reported explicitly to the current coordinator.

Frontdesk labels the coordinator with `[Coordinator]`, group hosts with `[Group]`, and dedicated members with the group name. Search the session list by group name or label. Existing chats added as ordinary members keep their titles. Desktop apps control their own titles.

The host continues in its own desktop chat. Ask it to consider member replies when needed, or use **Reply to this** to include a specific excerpt. Members receive their assigned question and relevant excerpts. If the same native chat participates in two groups, it remembers the tasks it received from both.

Each group advances one host-led task at a time. Open **View task progress** to see deliveries and approvals without sending a desktop message. Choose **Add to current task** to give the host more requirements, or **Replace current task** to start a different task. **Stop further dispatches** keeps the receipts for turns already sent. Follow the desktop link to stop an already running turn. The host looks for replies from the current task by default. Use **Reply to this** to bring a specific message from earlier work.

#### Message the coordinator from WeChat

On the computer running Frontdesk, open an initialized coordinator chat and choose **WeChat** at the bottom of its sidebar. Generate a QR code, scan it with your own WeChat account, and enter the verification code if WeChat shows one. Private text messages go to the bound desktop chat. Its replies, delegated results, and requests for attention come back to the same WeChat conversation. You can close the browser while Frontdesk and the desktop engines stay running.

Each Frontdesk configuration binds one WeChat direct chat to one coordinator. Switching coordinators in the browser keeps the existing binding. The channel accepts private text from the paired account. Approvals and decisions to implement a plan use the desktop workflow. To stop forwarding, open **WeChat** and choose **Disconnect WeChat**. Credentials and delivery state are stored locally under `~/.config/agent-frontdesk/weixin/`. The connection uses [Tencent iLink](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md) long polling.

## Add an AI

Frontdesk is meant for every desktop AI, so connecting one is a job for the AI itself. Click **+** in the rail, copy the prompt and send it to the AI you want to add. It follows [the onboarding guide](skills/add-desktop-engine/SKILL.md) and writes its own plugin: it reads its own data, picks a channel for sending, and declares what it can do.

It does not build any pages. The sidebar, conversation, composer, cards, file preview, queue and quota are shared, and a new AI gets them all. Everything a plugin implements is in one file, [`src/shared/contract.ts`](src/shared/contract.ts).

## How it works

Frontdesk is a small server on your computer. It reads the records each desktop app keeps locally to show history and progress. To send, it uses the app's own channel: an interface where the app has one, and otherwise macOS Accessibility (or Windows UI Automation on Windows 11), which fills in the message and presses Send in the app's window in the background, without bringing it to the front. On Windows the app's window takes the keyboard focus for a moment each time; Frontdesk gives it straight back and puts the window back where it was (see [What to expect on Windows](#what-to-expect-on-windows)). No key is sent and the clipboard is never touched.

```
 Browser ──▶ Frontdesk server ──▶ a plugin per AI ──▶ the desktop app
                              ◀── the app's local records
```

| AI | Reads history from | Sends through |
| --- | --- | --- |
| Codex | Codex's local app-server | Codex's own message queue and its window-to-window channel (also for model changes), with macOS Accessibility / Windows UIA for new chats |
| Claude | Claude Code's session transcripts | macOS Accessibility / Windows UIA |
| Antigravity | Its local database and transcripts | Its local language server |

Whether a turn has finished is decided by the desktop app's own record. These channels can change when a desktop app updates, and we update with them.

More detail is in [docs/architecture.md](docs/architecture.md).

## Configuration

All optional. Frontdesk finds standard install locations by itself.

<details>
<summary>Environment variables</summary>

| Variable | Purpose | Default |
| --- | --- | --- |
| `HOST` / `PORT` | Address the server listens on | `127.0.0.1` / `4100` |
| `HTTPS_PORT` | HTTPS port with a self-signed certificate, for the microphone on other devices; `0` turns it off | `PORT + 1` when `HOST` is not local |
| `BRIDGE_DEFAULT_CWD` | Working folder for new chats | your home folder |
| `BRIDGE_UPLOADS_DIR` | Where attachments are stored | `uploads/` in the project |
| `BRIDGE_EXPORTS_DIR` | Where the whole record of a long chat you refer to is written as Markdown, when the message carries it shortened (kept 30 days) | `exports/` in the project |
| `BRIDGE_SETTINGS_FILE` | Where it keeps which AIs are on, their names and order | `.frontdesk.json` in the project |
| `BRIDGE_COORDINATOR_PROFILE` | Name for an instance's coordinator, group and WeChat bindings | unnamed default profile |
| `BRIDGE_PLUGIN_DIR` | Folder the plugins are loaded from | `dist/server/plugins` |
| `BRIDGE_MODEL_CATALOG` | JSON file of model IDs for AIs that cannot list their own | none |
| `BRIDGE_DICTATION_ENGINE` | Which AI's speech-to-text voice input tries first; it falls back to another AI's or the browser's | `claude` |
| `CODEX_BIN` / `CODEX_HOME` | Codex executable and data folder | CLI bundled with the desktop app, then `PATH`. Data defaults to `~/.codex`. |
| `CLAUDE_BIN` / `CLAUDE_HOME` | Claude Code executable and session folder | found on `PATH` or in Claude's app data / `~/.claude` |
| `CLAUDE_DESKTOP_HOME` | Claude desktop app's data folder | `~/Library/Application Support/Claude` (Windows: `%LOCALAPPDATA%\Claude-Data\claude_<id>`, else `%APPDATA%\Claude`) |
| `AGENTAPI_BIN` / `ANTIGRAVITY_HOME` | Antigravity's CLI and data folder | `~/.gemini/antigravity` |
| `DSH_HOME` | DeepSeek Harness data folder, set in both desktop and Frontdesk when using a custom folder | `~/.dsh` |
| `DSH_FRONTDESK_BRIDGE_FILE` | Shared DSH bridge connection file, set to the same path in both processes | `frontdesk-bridge.json` in the DSH data folder |
| `DSH_APP_ASAR` / `DSH_APP_ICON` | Installed DeepSeek Harness app archive and icon for a nonstandard install | macOS app bundle |
| `WORKBUDDY_HOME` | WorkBuddy session data folder | `~/.workbuddy` |
| `CHATGPT_APP_ASAR` / `CLAUDE_APP_ASAR` / `ANTIGRAVITY_APP_ICON` | Installed apps that icons, characters and fonts are read from | `/Applications` on macOS, `%LOCALAPPDATA%\Programs` or MSIX on Windows |

</details>

## Security and privacy

- The server listens on your own machine only and has no login, so do not expose it to the internet
- Chats stay on your computer. There is no telemetry and no server of ours
- Voice input and quota use Claude Code's own sign-in, read on the server only
- On macOS, the Accessibility permission goes to the terminal that runs Frontdesk (Windows uses UI Automation with no system-wide Accessibility grant)

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Roadmap

- More desktop AIs
- Full support for desktop apps set to Chinese and other interface languages
- A login, so you can check in and send from your phone

## Development

```sh
npm run dev      # page with hot reload on PORT, server on PORT+1
npm test
npm run check    # type check and build
```

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE). Agent Frontdesk is an independent project, not affiliated with OpenAI, Anthropic or Google. Product names are trademarks of their owners.
