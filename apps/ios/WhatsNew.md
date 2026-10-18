<!--
App Store "What's New" for the iPhone app. Write it in the change that bumps the version:
a `## <version>` section with one `### <locale>` per App Store language (zh-Hant, en-US),
listing what iPhone users notice. tools/asc-submit.py reads the released version's section;
a version without one gets a generic "Bug fixes and improvements" line. Delete old sections.
-->

## 2.19.0

### zh-Hant

- 指向專案資料夾的 Claude Code bot 也改用 Codync 的記憶，不再用 Claude Code 自己的記憶；專案相關的事會記在 bot 自己的筆記裡。
- 想讓 Claude Code 也保留自己的記憶，可以在 bot 的「記憶」→「This bot」打開「Claude Code's own memory」（預設關閉）。旁邊的資訊按鈕會說明可能出現的問題，例如同一件事記兩次、兩邊記的內容不一致；打開後，可以在「Claude Code」分頁唯讀查看它的筆記。
- 電腦上的 Codync 太舊、還看不了新版記憶時，記憶頁會直接提示你更新電腦上的 Codync。
- 開新 session 時，聊天裡不再多出一行說明。

### en-US

- Claude Code bots in project folders now use Codync's memory too, instead of Claude Code's own, and keep what they learn about a project in their own notes.
- To let Claude Code keep its own memory as well, turn on "Claude Code's own memory" under Memory → This bot (off by default). Its info button explains the catch: things remembered twice, and two memories that can disagree. Once it's on, read its notes in the Claude Code tab.
- When the Codync on your computer is too old for the new memory, the Memory page now asks you to update it.
- Starting a new session no longer adds a line to the chat.
