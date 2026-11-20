# DeepSeek Harness

Install the local package from `integrations/dsh-frontdesk-bridge` in your DSH desktop profile, enable **Agent Frontdesk bridge** in **Settings → Plugins**, then restart DSH. Start Frontdesk and open **DeepSeek Harness** from the rail. Frontdesk talks only to that companion on loopback. DSH runs the turn and keeps its session log and settings.

The companion writes its connection information to `frontdesk-bridge.json` in the DSH data folder with mode 0600. The default data folder is `~/.dsh`. If the data folder is customized, set `DSH_HOME` to the same directory in both processes. If you move the connection file using the plugin's `stateFile` option, set `DSH_FRONTDESK_BRIDGE_FILE` on Frontdesk to that path.

| Action | Desktop interface | Behavior |
|---|---|---|
| Discover chats and projects | Session list and workspace snapshot | The coordinator queries summaries on demand, excluding blank and archived chats. Selecting a chat reads its native events. |
| Create and send | Session create and prompt | A known workspace is selected by ID. Follow the submitted request ID in the native log. |
| Steer and stop | Session prompt in steer mode and session cancel | An uncertain steer is reported to the user. A stop remains pending until the log records the outcome. |
| Change settings | Desktop model selection and permission preset | Re-read the relevant session settings before sending. |
| Answer a question | User question projection and answer | Single-choice questions support a web response. Other forms are displayed for the desktop app. |
| Usage | Desktop account service | Quota windows require both total and used amounts. |
| Attachments, file opening, desktop navigation, dictation | No adapter | Use the desktop app. |
| Coordinator | Target adapter | Codex and Antigravity can find, read and delegate to DSH. |
| Unread activity | Native assistant-message and turn-end events | Frontdesk uses the event times and skips pre-existing history as the sidebar fills in. Read positions are shared by Frontdesk windows through the server settings. DSH keeps its own completion reminder in its desktop window. |

On macOS the installed app supplies its icon at runtime. The web view renders replies as DSH appends messages to its native log. Windows desktop operation has not been validated.
