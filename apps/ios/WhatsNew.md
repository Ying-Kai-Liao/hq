<!--
App Store "What's New" for the iPhone app. Write it in the change that bumps the version:
a `## <version>` section with one `### <locale>` per App Store language (zh-Hant, en-US),
listing what iPhone users notice. tools/asc-submit.py reads the released version's section;
a version without one gets a generic "Bug fixes and improvements" line. Delete old sections.
-->

## 2.11.2

### zh-Hant

- 開發測試版本現在使用獨立的 App 與資料空間，可和正式版本並存。

- 憑證設定欄位保留清楚的標籤，並顯示尚未儲存連線憑證的狀態。
- 對話捲到底後繼續拖動時保留自然回彈，不再突然跳回底部或閃現跳至最新訊息按鈕。
- 改善跳至最新訊息的捲動動畫，避免長對話來回跳動，並可隨時用手勢中止。
- 調整對話氣泡與文字對比，讓閱讀更清楚。
- 對話列表摘要不再顯示粗體與程式碼的 Markdown 符號。

### en-US

- Development builds now use a separate app and data storage, so they can coexist with the production app.

- Credential fields keep their labels visible, with a clearer empty state for saved connections.
- Chats bounce naturally when dragged past the bottom, without snapping back or flashing the jump-to-latest button.
- Smoother jumps to the latest message, without back-and-forth movement in long chats; dragging interrupts immediately.
- Refined chat bubbles and text contrast for clearer reading.
- Conversation previews hide bold and code formatting markers.

## 2.10.0

### zh-Hant

- 開啟「使用電腦」的 bot 現在盡量在背景操作 app：直接按 app 裡的按鈕和欄位，不會搶走電腦上的滑鼠或把視窗拉到最前面。
- Windows 電腦上的 bot 現在也能使用電腦。

### en-US

- Bots with Use the computer on now work in apps in the background where they can: they press the app's own buttons and fields without taking the computer's pointer or bringing windows to the front.
- Bots on Windows computers can now use the computer too.
