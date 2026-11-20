# WorkBuddy desktop adapter

Verified against WorkBuddy 5.11.3 on macOS. Restart Frontdesk with its normal launcher to load the adapter. Set `WORKBUDDY_HOME` to use a different local data folder.

| Operation | Channel and evidence |
|---|---|
| List projects and chats | Read-only SQLite queries over WorkBuddy's workspace and local session records. Includes empty workspaces and omits deleted chats. |
| Read a chat or search from the coordinator | Native JSONL selected by session ID. The reader extracts the visible text from WorkBuddy's prompt envelope and uses the native session status for the latest outcome. |
| Open a chat | WorkBuddy's own `workbuddy://chat/{id}` desktop link. If the link cannot be opened, use the WorkBuddy sidebar. |
| Send or start a chat | Send in WorkBuddy. Normal paste and a single press of its desktop Send button produced one test reply. The background accessibility fill left Send disabled. No public or cross-window send channel for the installed consumer app was verified. |
| Steer, stop, change settings, answer cards, open files | Use the WorkBuddy desktop app. No corresponding Frontdesk controls are enabled. |

The one-message desktop test returned `OK` and was used to verify the history reader. Frontdesk uses no WorkBuddy credentials or model endpoints. Quota, past attachments and cards, and Windows are unverified.
