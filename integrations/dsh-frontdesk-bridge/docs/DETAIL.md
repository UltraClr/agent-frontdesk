# Agent Frontdesk bridge

Install the local package from `integrations/dsh-frontdesk-bridge` in the **desktop** DSH profile and enable **Agent Frontdesk bridge** in Settings → Plugins. Restart DeepSeek Harness to load it. Start Frontdesk and choose **DeepSeek Harness** in the agent rail. If previously disabled, turn it on with the rail’s add button.

The companion uses DSH's session and workspace services inside the running desktop process. A short-lived local key and loopback port are shared with Frontdesk through its own private connection file. The accepted operations are listed in the UI adapter’s channel table under `docs/skins/dsh/progress.md`. Disabling the companion closes its listener. A custom profile may set `DSH_FRONTDESK_BRIDGE_FILE` to the same path in both processes.
