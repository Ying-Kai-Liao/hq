<!--
App Store "What's New" for the iPhone app. Write it in the change that bumps the version:
a `## <version>` section with one `### <locale>` per App Store language (zh-Hant, en-US),
listing what iPhone users notice. tools/asc-submit.py reads the released version's section;
a version without one gets a generic "Bug fixes and improvements" line. Delete old sections.
-->

## 2.18.0

### zh-Hant

- 記憶改版：分成「關於你」（你所有的 bot 共用）和這個 bot 自己的記憶，都可以新增、編輯、釘選、封存或忘記，也能決定每個 bot 要不要使用共用的記憶。
- bot 記下一件事時，聊天裡會顯示出來，一鍵就能復原；設定成「先問我」的 bot 會改用卡片詢問，由你決定要不要記。
- bot 會在空檔時整理記憶，只採用你親口打的字，貼上或引用的內容不算；每次整理都列在 Dreams 裡，可以復原。
- 原本的記憶會自動搬過來。

### en-US

- Memory, redone: what all your bots know about you, and what each bot knows on its own. Add, edit, pin, archive or forget any of it, and choose per bot whether it uses the shared memory.
- When a bot remembers something, the chat shows it with a one-tap undo. A bot set to ask first shows a card instead, and you decide.
- Between chats, bots tidy their memory using only words you typed yourself, not pasted or quoted text. Every run is listed under Dreams and can be undone.
- Your existing memory moves over automatically.

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
