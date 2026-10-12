<!--
App Store "What's New" for the iPhone app. Write it in the change that bumps the version:
a `## <version>` section with one `### <locale>` per App Store language (zh-Hant, en-US),
listing what iPhone users notice. tools/asc-submit.py reads the released version's section;
a version without one gets a generic "Bug fixes and improvements" line. Delete old sections.
-->

## 2.14.1

### zh-Hant

- 修正小工具頁面上圖示樣式的說明文字。
- 使用情況分析改為預設開啟，幫助我們更快發現 bug、把服務做得更好：只記錄用了哪些功能，從不包含你的訊息、程式碼或檔案。可隨時在「設定」關閉。
- 安裝的技能會自動在每個 bot 開啟，新 bot 也預設全開；不需要的可以在 bot 設定關掉。
- 在訊息開頭輸入「/」可以選這個 bot 的技能，讓它照那個技能做事。
- 點一下技能就能看完整說明，再決定要不要加入。
- 其他小幅改進。

### en-US

- Fixed the description of the icon style on the Widgets page.
- Usage analytics are now on by default, to help us spot bugs sooner and serve you better: only which features you use, never your messages, code or files. Turn them off anytime in Settings.
- Skills you install are now on for every bot, and new bots start with all of them; turn one off in a bot's settings.
- Type "/" at the start of a message to pick one of the bot's skills for that request.
- Tap a skill to read its full instructions before you add it.
- Other small improvements.
