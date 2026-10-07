<!--
App Store "What's New" for the iPhone app. Write it in the change that bumps the version:
a `## <version>` section with one `### <locale>` per App Store language (zh-Hant, en-US),
listing what iPhone users notice. tools/asc-submit.py reads the released version's section;
a version without one gets a generic "Bug fixes and improvements" line. Delete old sections.
-->

## 2.9.1

### zh-Hant

- 修正 iPad 外接鍵盤用注音等輸入法打字時，選好的字從輸入框消失、之後無法再輸入的問題。
- 在遠端畫面用 iPad 外接鍵盤打注音等輸入法時，現在看得到正在組字的文字和選字框。
- 鎖定畫面和動態島縮成小圓點時，工作中的 bot 也會動起來；鎖定畫面卡片的文字不再白底白字看不清楚。

### en-US

- Fixed text typed with Zhuyin or another input method on an iPad hardware keyboard vanishing from the message box and blocking further input.
- On the remote screen, text you're composing with Zhuyin or another input method on an iPad hardware keyboard now shows, along with its candidates.
- While a bot works, it now moves on the Lock Screen and in the smallest Dynamic Island too, and the Lock Screen card's text no longer disappears white on white.
