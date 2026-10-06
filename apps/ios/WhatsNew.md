<!--
App Store "What's New" for the iPhone app. Write it in the change that bumps the version:
a `## <version>` section with one `### <locale>` per App Store language (zh-Hant, en-US),
listing what iPhone users notice. tools/asc-submit.py reads the released version's section;
a version without one gets a generic "Bug fixes and improvements" line. Delete old sections.
-->

## 2.7.4

### zh-Hant

- 未送出的文字會依 bot 和討論串自動保存，切換對話或重新開啟 app 都能接著寫。
- 配對後不再馬上跳出通知權限；改在設定頁的「開啟通知」一鍵打開，關掉了也會帶你到「設定」重新開啟。
- 登入已經有電腦的帳號時，會直接完成設定，不用再走一次配對引導。

### en-US

- Unsent text is saved separately for each bot and thread, so you can continue after switching chats or reopening the app.
- Pairing no longer asks for notifications right away. Turn them on from the setup page, which takes you to Settings if you turned them off.
- Signing in to an account that already has computers finishes setup without the pairing walkthrough.
