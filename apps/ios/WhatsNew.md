<!--
App Store "What's New" for the iPhone app. Write it in the change that bumps the version:
a `## <version>` section with one `### <locale>` per App Store language (zh-Hant, en-US),
listing what iPhone users notice. tools/asc-submit.py reads the released version's section;
a version without one gets a generic "Bug fixes and improvements" line. Delete old sections.
-->

## 2.6.0

### zh-Hant

- 新建立的 bot 預設會自動核准工具請求；想逐一確認的話，可以在 bot 設定裡改成「Ask me」。
- 多台電腦時，點電腦標題可以收合它的 bot；長按標題可以把整台電腦連同 bot 一起拖曳排序。
- 語音通話可以改用 OpenAI 或 Gemini 的即時語音：在通話的齒輪裡填入你自己的 API key 並挑選模型，就能直接插話、問 bot 現在在做什麼；key 加密存在你的電腦上，Mac 版也能語音通話。
- 設定畫面換上更乾淨的分組版面，每個選項都附上簡短說明。

### en-US

- New bots approve tool requests automatically. Switch a bot to "Ask me" in its settings to review each one.
- With several computers, tap a computer's heading to fold its bots away, or long-press it to drag the whole computer up or down.
- Voice calls can use OpenAI or Gemini realtime voice: add your own API key and pick a model in the call's settings to talk over replies and ask what the bot is doing. The key is stored encrypted on your computer, and the Mac app can make voice calls too.
- Settings get a cleaner grouped layout, with a short note under each option.
