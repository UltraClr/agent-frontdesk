<div align="center">

<img src="src/client/public/assets/logo/logo-128.png" width="84" alt="Agent Frontdesk logo">

# Agent Frontdesk

**一个网页，用上你电脑里所有的桌面版 AI。**<br>
想加新的 AI，把一段提示词发给它，它自己接进来。

[![CI](https://github.com/Phz-06/agent-frontdesk/actions/workflows/ci.yml/badge.svg)](https://github.com/Phz-06/agent-frontdesk/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Platform: macOS · Windows 11](https://img.shields.io/badge/platform-macOS%20%C2%B7%20Windows%2011-lightgrey.svg)
![Node 22.16+](https://img.shields.io/badge/node-%E2%89%A5%2022.16-brightgreen.svg)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-orange.svg)](CONTRIBUTING.md)

[快速开始](#快速开始) · [接入新的 AI](#接入新的-ai) · [工作原理](#工作原理) · [未来计划](#未来计划) · [English](README.md)

<table>
<tr>
<td width="50%">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/frontdesk-zh-dark.png">
  <img src="docs/images/frontdesk-zh-light.png" alt="左边一栏是几个 AI 的头像和它们刚说的话，中间是项目和聊天，右边是正在进行的对话" width="100%">
</picture>
</td>
<td width="50%">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/frontdesk-preview-zh-dark.png">
  <img src="docs/images/frontdesk-preview-zh-light.png" alt="一个 Codex 聊天，回复里提到的 README 在右边打开了预览" width="100%">
</picture>
</td>
</tr>
<tr>
<td align="center"><sub>几个 AI 同时在跑，头像旁边是它们刚说的话</sub></td>
<td align="center"><sub>回复里的文件点一下就在右边预览，也能直接回到桌面应用</sub></td>
</tr>
</table>

</div>

## 为什么做这个

我们手上有好几家 AI 的订阅，每家一个桌面应用。干活的时候要在几个窗口之间来回切，还得记着刚才是谁在跑、跑到哪一步了，很麻烦。

Agent Frontdesk 把这些桌面应用放进同一个网页。干活的还是各家的桌面应用，用的是你自己的账号和订阅，网页只负责把消息送过去、把进度拿回来。两边是同一个会话，随时可以切回桌面版接着聊。

## 能做什么

- 左边一栏排着所有 AI，谁在跑、谁有新回复、额度还剩多少都看得到，头像旁边会冒出它刚说的话
- 每个 AI 的侧栏先显示最近 3 个未读会话，再显示桌面置顶、项目和最近聊天。点搜索框下方的「全部会话」可以切换视图，选择会按 AI 保存在当前浏览器。点 Agent 头像上的「!」角标或在列表中选「待你处理」，可以找到桌面正在等你回答、审批或确认计划的会话。打开阅读后，等待项会保留到请求处理完毕。
- 打开已有的聊天接着聊，或者在某个项目里开一个新的
- 发消息、插话、排队、停止。一个 AI 在跑的时候切去看别的，不会打断它
- 改模型、推理强度和权限，带图片和文件，语音输入
- 在一个聊天里引用另一个 AI 的聊天：工作台把那个聊天整理好，作为附件卡片附在你的消息上（也可以转成文字修改）；聊天太长时较早的轮次会精简
- AI 提的问题和要你确认的操作，直接在网页上回答
- 回复按各家桌面版的样子显示，代码、公式、图表、工具步骤、计划清单都在
- 回复里提到的文件，点一下就在右边打开预览，也可以在 Finder 或资源管理器里显示
- 任何一个聊天都能一键在桌面应用里打开，回到同一个会话接着用
- AI 可以随时开关、改名、排序、换头像，有浅色和深色，中文和英文

## 快速开始

需要 macOS 或 Windows 11 和 [Node.js](https://nodejs.org) 22.16 以上，不用另外安装别的：操作桌面应用窗口的辅助程序在你的电脑上现场编译，macOS 用 Xcode 命令行工具，Windows 用系统自带的 C# 编译器（.NET Framework 4）。

```sh
git clone https://github.com/Phz-06/agent-frontdesk.git
cd agent-frontdesk
npm ci
npm start
```

打开 <http://127.0.0.1:4100>。电脑上装了哪个桌面应用，哪个 AI 就会出现在左边一栏里，之后可以在栏里的 **+** 中开关。

目前已经接好的有 Codex、Claude 和 Antigravity，用之前先把对应的桌面应用打开并登录。

在 macOS 上，给 Codex 和 Claude 发消息需要辅助功能权限：在「系统设置 → 隐私与安全性 → 辅助功能」里允许你运行 `npm start` 的那个终端应用，然后重新启动 Frontdesk。Windows 11 没有要授予的权限，但 Frontdesk 要和桌面应用以相同的权限运行（都以管理员身份，或都不是）：Windows 允许程序读取更高权限应用的窗口，但不允许操作它。桌面应用的界面语言建议先用英文。

Claude 的模型列表、额度和语音输入还要登录一次 Claude Code，用和桌面版相同的账号。没登录时页面会给出要运行的命令，在终端跑一次就行。

端口被占用时用 `PORT=4200 npm start`（Windows PowerShell 下用 `$env:PORT=4200; npm start`）。

## Windows 上会遇到的情况

在 macOS 上，Frontdesk 按桌面版窗口里的按钮时，那个窗口不会拿到键盘焦点。Windows 不允许这样做：Frontdesk 往 Claude 或 Codex 的窗口里填消息、按发送，那个窗口都会短暂拿走焦点。我们把这段时间压得尽量短，事后也会把一切放回原样，但你可能还是会注意到：

- **发消息时在别的程序里打字。** 发一条消息，焦点会被拿走 2–3 次，每次 20–90 毫秒。如果你是在 Frontdesk 里打字，它会等你停顿后再动手；在别的程序里，用输入法拼到一半的字可能会被打断，也可能丢一个按键。
- **改模型或推理强度。** 桌面版的菜单只在它拿着焦点时才能用，所以大约半秒内你打的字会进到桌面版里。
- **全屏。** 前台的程序独占全屏时，Frontdesk 会等你离开它再发；无边框全屏可能会卡一下。
- **屏幕角落的几个像素。** 操作期间，桌面版窗口会挪到屏幕外，只在角落留几个像素，结束后放回原处。如果中途服务器被关掉，下次启动时会自动放回。
- Codex 的普通消息、插话、停止和大多数换模型走它自己的通道，不受影响。新建 Codex 聊天，以及给 Codex 还没打开过的聊天换模型，会和 Claude 一样经过它的窗口。

如果你知道怎么在 Windows 上操作 Chromium / Electron 窗口而不让它拿到焦点，欢迎来聊。我们试过什么、测到了什么，都写在 [docs/windows.md](docs/windows.md)。

### 总控

DeepSeek Harness 可以加入侧栏，由总控按需查找会话、读取进展或代发消息。在 DSH 桌面配置中安装 `integrations/dsh-frontdesk-bridge` 下的本地包，在「设置 → 插件」中启用「Agent Frontdesk bridge」，然后重启 DSH。[DSH 接入说明](docs/skins/dsh/progress.md)

点 Agent 栏左上角的机器人图标，进入最近使用的总控会话。可以选择 Codex 或 Antigravity 担任总控，各自的项目都位于数据根目录的 `agent-frontdesk/<引擎>-controller/` 下。Codex 首次使用时，点「打开桌面初始化草稿」，在桌面确认目录并发送草稿。工作台会核对原生会话与目录，以后可以直接在网页派发任务。

下面的 Agent 图标打开各自的普通会话。你可以对总控说「找整理访谈的会话，问它记录齐了没有，等它回复后告诉写周报的会话」。总控按需检索 Codex、Antigravity 和 Claude 的编码会话，目标不明确时会请你选择。侧栏显示派发与回传进度。关闭网页后，正在运行的 Frontdesk 仍会跟进，桌面审批在目标会话中处理。

要并行运行独立实例，启动前将 `BRIDGE_COORDINATOR_PROFILE` 设为自选名称（例如 `test`），并通过 `PORT` 选择空闲端口。该实例的总控目录位于 `agent-frontdesk/profiles/<名称>/`。若也要隔离设置，为各实例指定不同的 `BRIDGE_SETTINGS_FILE`。

在侧栏点「记住会话」，告诉总控你关心的项目、话题或任务。总控可以按会话正在做的事留一句说明，也可以使用你给的别名。派过任务的会话会自动记住。以后直接说「让整理访谈的那个会话补上昨天的记录」，总控会找回原会话。有多个匹配时会先让你选。每个总控的列表单独保存，重启后仍可使用。本地工具用 `track` 记住会话、`workers` 查看列表、`untrack` 取消登记。展开派发记录可查看原指令、目标的回复或投递错误。目标桌面确认收到后，点「打开目标会话」可定位到那一轮。你要求收到回复后继续处理时，工具通过 `send` 的 `followUp: true` 唤起总控接着做。无法关联到原回复的记录可在总控对话底部查看。

#### 群聊

在总控侧栏点「新建群聊」，或者请总控把已找到的会话拉进群。可选 Agent 新建群主会话，也可指定已有会话当群主。Codex 新建群主需要时会提示打开桌面初始化草稿。初始化失败后可以在原群改选群主。不同总控共用群目录。

建群后可从「管理成员」添加已有会话、创建专用成员，或把成员移出群聊。选中成员作为收件人可直接提问，回复会进入这个群。选「群主」可发起多步讨论或总结。结论附会话链接，可单独汇报给当前总控；群里出现普通回复只更新群记录。

群主沿用自己的桌面会话。需要汇总成员意见时，可以直接请群主查看成员回复，也可以用「回复这条」带上一条指定摘录。成员收到各自的问题和相关摘录。同一个原生会话加入两个群时，会保留它在两个群收到的任务。

每个群同时推进一项群主主持的任务。打开「查看任务进度」可以看回执和等待中的审批，无需向桌面发消息。新增要求时选「补充当前任务」，改目标时选「替换当前任务」。「停止后续派发」保留已发送轮次的回执。需要停止正在执行的轮次时，可打开它的原会话。群主默认读取当前任务的成员回复，需要带上以前的发言时使用「回复这条」。

#### 用微信给总控发消息

在运行 Frontdesk 的电脑上打开一个已经初始化的总控，点侧栏底部的「微信」，生成二维码后用自己的微信扫码确认。如果微信显示数字验证码，在弹窗内填入。微信私聊里的文字会送入绑定的桌面会话。总控回复、对应协作结果和等待操作提醒会回到该私聊。可以关闭网页，保持 Frontdesk 服务和相关桌面引擎运行即可。

每个 Frontdesk 实例配置绑定一个微信私聊和一个总控会话。切换网页里的总控不会改变微信的绑定。入口仅接收扫码账号的私聊文本，审批和执行计划仍通过桌面流程处理。可在「微信」弹窗断开，凭证和待回传状态保存在本机 `~/.config/agent-frontdesk/weixin/` 下。连接使用 [腾讯 iLink](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol_zh_CN.md) 长轮询。

## 接入新的 AI

Frontdesk 的目标是所有桌面版 AI，所以接入这件事交给 AI 自己做。点左边一栏里的 **+**，复制里面的提示词，发给你想接入的那个 AI。它会照着[接入手册](skills/add-desktop-engine/SKILL.md)给自己写一个插件：读自己的数据，选好发消息的通道，声明自己能做什么。

页面不用它管。侧栏、对话、输入框、卡片、文件预览、排队和额度都是共用的，新接入的 AI 直接就有。插件要实现的内容都在 [`src/shared/contract.ts`](src/shared/contract.ts) 这一个文件里。

## 工作原理

Frontdesk 是跑在你电脑上的一个小服务。它读各家桌面应用留在本机的记录来显示历史和进度。发消息时走桌面应用自己的通道：应用有接口的用接口，没有的在 macOS 通过辅助功能（在 Windows 11 通过 UI Automation）在后台操作应用的窗口，填好消息、按下发送，不会把窗口抢到前台。在 Windows 上，应用窗口每次都会短暂拿走键盘焦点，Frontdesk 会立刻把焦点还给你，并把窗口放回原处（见 [Windows 上会遇到的情况](#windows-上会遇到的情况)）。全程不发任何按键，也不碰剪贴板。

```
 浏览器 ──▶ Frontdesk 服务 ──▶ 每个 AI 一个插件 ──▶ 桌面应用
                           ◀── 桌面应用的本机记录
```

| AI | 历史从哪读 | 消息怎么发 |
| --- | --- | --- |
| Codex | Codex 本机的 app-server | Codex 自己的消息队列和窗口间通道（改模型也走它），新建聊天在 macOS 用辅助功能 / 在 Windows 用 UIA |
| Claude | Claude Code 的会话记录 | macOS 辅助功能 / Windows UIA |
| Antigravity | 它的本地数据库和会话记录 | 它本机的 language server |

一轮对话有没有完成，以桌面应用自己的记录为准。桌面应用更新后这些通道可能会变，我们会跟着更新。

更细的说明在 [docs/architecture.md](docs/architecture.md)。

## 配置

都是可选的，标准安装位置 Frontdesk 自己会找。

<details>
<summary>环境变量</summary>

| 变量 | 用途 | 默认 |
| --- | --- | --- |
| `HOST` / `PORT` | 服务监听的地址 | `127.0.0.1` / `4100` |
| `HTTPS_PORT` | 自签名证书的 HTTPS 端口，给其他设备用麦克风，`0` 关闭 | `HOST` 不是本机地址时为 `PORT + 1` |
| `BRIDGE_DEFAULT_CWD` | 新聊天的默认工作目录 | 你的 home 目录 |
| `BRIDGE_UPLOADS_DIR` | 附件存放位置 | 项目里的 `uploads/` |
| `BRIDGE_EXPORTS_DIR` | 引用的聊天太长、消息里做了精简时，完整记录写成 Markdown 的存放位置（保留 30 天） | 项目里的 `exports/` |
| `BRIDGE_SETTINGS_FILE` | 哪些 AI 开着、它们的名字和顺序存在哪 | 项目里的 `.frontdesk.json` |
| `BRIDGE_COORDINATOR_PROFILE` | 区分不同实例的总控、群聊和微信绑定 | 无名称的默认配置 |
| `BRIDGE_PLUGIN_DIR` | 从哪个目录加载插件 | `dist/server/plugins` |
| `BRIDGE_MODEL_CATALOG` | 给列不出自己模型的 AI 用的模型 ID JSON 文件 | 无 |
| `BRIDGE_DICTATION_ENGINE` | 语音输入先试哪个 AI 的识别，用不了时换其他 AI 的或浏览器的 | `claude` |
| `CODEX_BIN` / `CODEX_HOME` | Codex 可执行文件和数据目录 | 优先桌面版自带的 CLI，其次 `PATH`。数据目录默认 `~/.codex`。 |
| `CLAUDE_BIN` / `CLAUDE_HOME` | Claude Code 可执行文件和会话目录 | 从 `PATH` 或 Claude 的应用数据里找 / `~/.claude` |
| `CLAUDE_DESKTOP_HOME` | Claude 桌面应用的数据目录 | `~/Library/Application Support/Claude`（Windows 为 `%LOCALAPPDATA%\Claude-Data\claude_<id>`，没有时为 `%APPDATA%\Claude`） |
| `AGENTAPI_BIN` / `ANTIGRAVITY_HOME` | Antigravity 的命令行工具和数据目录 | `~/.gemini/antigravity` |
| `DSH_HOME` | DeepSeek Harness 数据目录。使用自定义目录时，在 DSH 桌面端和 Frontdesk 中都要设置 | `~/.dsh` |
| `DSH_FRONTDESK_BRIDGE_FILE` | DSH 桥接连接文件，两个进程使用同一路径 | DSH 数据目录下的 `frontdesk-bridge.json` |
| `DSH_APP_ASAR` / `DSH_APP_ICON` | 非标准安装位置的 DeepSeek Harness 应用归档和图标 | macOS 的应用包 |
| `WORKBUDDY_HOME` | WorkBuddy 会话数据目录 | `~/.workbuddy` |
| `CHATGPT_APP_ASAR` / `CLAUDE_APP_ASAR` / `ANTIGRAVITY_APP_ICON` | 从这些已安装的应用里读图标、角色和字体 | macOS 在 `/Applications` 下，Windows 在 `%LOCALAPPDATA%\Programs` 或 MSIX 下 |

</details>

## 安全与隐私

- 服务只监听本机，没有登录，不要把它暴露到公网
- 聊天都留在你的电脑上，没有遥测，也没有我们的服务器
- 语音输入和额度用的是 Claude Code 自己的登录信息，只在服务端读取
- 在 macOS 上，辅助功能权限给的是运行 Frontdesk 的那个终端（Windows 使用 UI Automation，无需系统级辅助功能授权）

报告漏洞见 [SECURITY.md](SECURITY.md)。

## 未来计划

- 接入更多桌面版 AI
- 桌面应用用中文等其他界面语言时也能完整使用
- 加上登录，在手机上远程查看和发消息

## 开发

```sh
npm run dev      # 页面热更新在 PORT，服务端在 PORT+1
npm test
npm run check    # 类型检查加构建
```

欢迎提 issue 和 PR，见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可

[MIT](LICENSE)。Agent Frontdesk 是独立项目，与 OpenAI、Anthropic、Google 没有关联，各产品名称是其所有者的商标。
