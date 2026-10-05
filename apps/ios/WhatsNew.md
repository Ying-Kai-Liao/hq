<!--
App Store "What's New" for the iPhone app. Write it in the change that bumps the version:
a `## <version>` section with one `### <locale>` per App Store language (zh-Hant, en-US),
listing what iPhone users notice. tools/asc-submit.py reads the released version's section;
a version without one gets a generic "Bug fixes and improvements" line. Delete old sections.
-->

## 2.7.0

### zh-Hant

- Mac 和 Linux 的 Codync 換成全新的桌面版 app，配對、聊天和通話都跟以前一樣；iPhone 這邊不用做任何事。
- 語音通話預設改用各家最新的模型（例如 OpenAI 的 gpt-transcribe，辨識更準、更認得 bot 的名字），之後有新模型推出也會自動換上，不用等 app 更新。
- 回覆串流更順：文字平穩地一路浮現，畫面穩穩跟著最新內容；往上捲就停在你在看的地方，按下箭頭回到最新。
- 進聊天室先顯示最新的訊息，往上捲再接上更早的；更新 app 之後也不用等對話重新載入。
- 回覆裡的表格、分隔線、巢狀清單和行內程式碼都會正確排版。
- 開啟 app 時會有 bot 動畫陪你等連線，畫面出現時新訊息已經同步好了。

### en-US

- Codync for Mac and Linux is now one new desktop app. Pairing, chats and calls work as before; nothing changes on your iPhone.
- Voice calls now default to each provider's newest models (such as OpenAI's gpt-transcribe: more accurate, and better at your bots' names), and move to newer ones as they come out, without an app update.
- Smoother streaming: replies flow in steadily and the chat glides along with them; scroll up and it stays where you're reading, with an arrow back to the latest.
- A chat opens on its newest messages and brings in earlier ones as you scroll up, and no longer reloads after an app update.
- Tables, dividers, nested lists and inline code in replies are now formatted properly.
- Opening the app now shows an animated bot while it connects, so new messages are already in when the list appears.
