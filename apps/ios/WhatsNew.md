<!--
App Store "What's New" for the iPhone app. Write it in the change that bumps the version:
a `## <version>` section with one `### <locale>` per App Store language (zh-Hant, en-US),
listing what iPhone users notice. tools/asc-submit.py reads the released version's section;
a version without one gets a generic "Bug fixes and improvements" line. Delete old sections.
-->

## 2.18.1

### zh-Hant

- 記憶不再出現在聊天裡：bot 記下或改了什麼，都到 bot 詳細資料的「記憶」查看、修改或忘記。每個 bot 都會直接記，不再跳卡片詢問。
- 修正在記憶裡儲存或新增筆記時 App 會閃退的問題。
- 「新增記憶」視窗的內容改為從上方開始，不再空一大塊。
- 聊天裡只在開新對話時留一行說明；對話摘要和「保留這段對話」不再顯示。
- 斜線選單拿掉「New session」，要開新對話請用聊天選單裡的「New session」。

### en-US

- Memory stays out of the chat. Whatever a bot remembers or changes, you see, edit or forget it under Memory in the bot's details. Every bot remembers directly, with no cards to approve.
- Fixed the app closing when you saved or created a note in memory.
- The Add memory sheet now starts at the top instead of leaving a gap.
- The chat explains only a fresh conversation, in one line; summaries and kept conversations no longer show.
- New session left the / menu; start one from the chat's menu.

## 2.18.0

### zh-Hant

- 記憶改版：分成「關於你」（你所有的 bot 共用）和這個 bot 自己的記憶，都可以新增、編輯、釘選、封存或忘記，也能決定每個 bot 要不要使用共用的記憶。
- bot 記下一件事時，聊天裡會顯示出來，一鍵就能復原；設定成「先問我」的 bot 會改用卡片詢問，由你決定要不要記。
- bot 會在空檔時整理記憶，只採用你親口打的字，貼上或引用的內容不算；每次整理都列在 Dreams 裡，可以復原。
- 原本的記憶會自動搬過來。
- 對話太長時，bot 會先摘要較早的內容，摘要可以在聊天裡展開；摘要也不夠用時，會改用一張卡片開新對話，你可以先編輯它要帶過去的內容，或選擇保留原本的對話。
- bot 可以把較長的細節寫成筆記（每個主題一份），在記憶裡就能閱讀、編輯、刪除或還原任何一個版本；bot 改了筆記時，聊天裡會顯示改了哪些地方，一鍵就能復原。
- bot 的詳細資料重新整理成一頁：上方是 bot 的頭像和名字，下面分成「詳細資料」、「記憶」、「設定」三個分頁，設定改了就自動儲存；也能從這裡把 bot 分享成範本。
- 訊息框多了麥克風：用說的就能打字，在手機上辨識，按送出前都不會傳出去。

### en-US

- Memory, redone: what all your bots know about you, and what each bot knows on its own. Add, edit, pin, archive or forget any of it, and choose per bot whether it uses the shared memory.
- When a bot remembers something, the chat shows it with a one-tap undo. A bot set to ask first shows a card instead, and you decide.
- Between chats, bots tidy their memory using only words you typed yourself, not pasted or quoted text. Every run is listed under Dreams and can be undone.
- Your existing memory moves over automatically.
- When a chat runs long, the bot summarizes the earlier part, and you can open the summary in the chat. When that's no longer enough, a card offers a fresh conversation: edit what it carries over, or keep the current one.
- Bots can keep longer notes, one topic each. Read, edit, delete or bring back any version from memory, and when a bot changes a note, the chat shows what changed with a one-tap undo.
- A bot's details are one page now: its avatar and name on top, then Details, Memory and Settings tabs. Settings save as you edit, and you can share the bot as a template from here.
- A mic in the message box: say it instead of typing it. It's recognized on the phone, and nothing goes out until you send it.

## 2.17.5

### zh-Hant

- 對話中的連結加上底線，在淺色與深色模式下都更容易辨識與點選。

### en-US

- Links in conversations are now underlined, making them easier to recognize and tap in both light and dark mode.

## 2.17.2

### zh-Hant

- 在輸入框打 / 就會列出所有指令：快速模式、開新工作階段，以及 bot 的 skills，每一項都附上說明。快速模式改從這裡開關，不再放在 + 選單。
- Claude Code 等 agent 需要重新登入時，對話裡會出現登入卡片，點「Sign in」就能直接登入；登入後，剛才沒回覆的訊息會自動重送。

### en-US

- Type / in the composer to see every command with what it does: Fast mode, New session and the bot's skills. Fast mode now switches from here instead of the + menu.
- When Claude Code or another agent needs you to sign in again, a card in the chat lets you sign in right there, and the messages it couldn't answer go out again once you're signed in.
