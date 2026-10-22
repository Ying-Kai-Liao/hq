"""Telegram: a bot of kith's own (a telegram/<name> profile granted to the bridge). Private chats and groups are rooms.
`@agent …` or `/agent …` picks the agent; a reply to a message of a task continues it; anything else goes to the
room's default (/default; the owner's DM starts with KITH_BRIDGE_DM_DEFAULT, default personal), or the bot asks who
should take it. In a group the bot sees only commands, mentions of it and replies to it (Telegram's privacy mode), so
talk to it with /agent, @bot or a reply. Files come in as paths and go out with kith-send; answers are Markdown,
shown as Telegram formatting. /link CODE, /whoami, /agents, /default, /stop.
"""
import asyncio
import html
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

from .core import STATE_DIR, Adapter, Incoming, agents, chunks, cmd_name, description, display_name, log

REACT = {'stop': '🫡', 'redo': '✍'}   # Telegram allows only its own short list of reaction emoji


def tg_html(md):
    """Markdown as the HTML subset Telegram shows: bold, italic, code, pre, links, quotes; tables as pre."""
    out = []
    for i, p in enumerate(re.split(r'(```[^\n]*\n.*?```)', md, flags=re.S)):
        if i % 2:
            m = re.match(r'```([^\n]*)\n(.*?)```', p, re.S)
            lang, code = m.group(1).strip(), html.escape(m.group(2).rstrip())
            out.append(f'<pre><code class="language-{html.escape(lang)}">{code}</code></pre>' if lang
                       else f'<pre>{code}</pre>')
        else:
            out.append(_inline(p))
    return ''.join(out)


def _inline(t):
    keep = []

    def stash(s):
        keep.append(s)
        return f'\x00{len(keep) - 1}\x00'
    t = re.sub(r'(?:^\|.*\|[ \t]*(?:\n|$)){2,}', lambda m: stash(f'<pre>{html.escape(m.group(0).rstrip())}</pre>\n'),
               t, flags=re.M)
    t = re.sub(r'`([^`\n]+)`', lambda m: stash(f'<code>{html.escape(m.group(1))}</code>'), t)
    t = re.sub(r'\[([^\]\n]+)\]\((https?://[^)\s]+)\)',
               lambda m: stash(f'<a href="{html.escape(m.group(2))}">{html.escape(m.group(1))}</a>'), t)
    t = html.escape(t, quote=False)
    t = re.sub(r'^#{1,6}\s+(.+)$', r'<b>\1</b>', t, flags=re.M)
    t = re.sub(r'^(\s*)[-*+] ', r'\1• ', t, flags=re.M)
    t = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', t)
    t = re.sub(r'(?<!\w)__(.+?)__(?!\w)', r'<b>\1</b>', t)
    t = re.sub(r'(?<![\w*])\*(?![\s*])([^*\n]+?)(?<!\s)\*(?![\w*])', r'<i>\1</i>', t)
    t = re.sub(r'(?<!\w)_(?![\s_])([^_\n]+?)(?<!\s)_(?!\w)', r'<i>\1</i>', t)
    t = re.sub(r'~~(.+?)~~', r'<s>\1</s>', t)
    t = re.sub(r'(?:^&gt; ?.*(?:\n|$))+', lambda m: '<blockquote>' + re.sub(r'^&gt; ?', '', m.group(0).rstrip('\n'),
                                                                             flags=re.M) + '</blockquote>\n', t, flags=re.M)
    return re.sub(r'\x00(\d+)\x00', lambda m: keep[int(m.group(1))], t)


class Telegram(Adapter):
    platform = 'telegram'
    quiet = 300   # a poll returns within 70 s, a failed one is retried after at most 30 s
    footer = ('\n\n(From Telegram: your final answer is posted here automatically; Markdown shows as formatting. '
              'Send images and files with kith-send; files the user sent are listed as paths. Helpers you call post '
              'status with `kith-send --as <their name>`.)')

    def call(self, method, files=None, **params):
        data = {k: json.dumps(v) if isinstance(v, (dict, list)) else str(v) for k, v in params.items()}
        if files:
            boundary = uuid.uuid4().hex
            body = b''
            for k, v in data.items():
                body += f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
            for k, path in files.items():
                name = os.path.basename(path).replace('"', '')
                body += (f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"; filename="{name}"\r\n'
                         f'Content-Type: application/octet-stream\r\n\r\n').encode() + open(path, 'rb').read() + b'\r\n'
            body += f'--{boundary}--\r\n'.encode()
            req = urllib.request.Request(self.api + method, data=body,
                                         headers={'Content-Type': f'multipart/form-data; boundary={boundary}'})
        else:
            req = urllib.request.Request(self.api + method, data=urllib.parse.urlencode(data).encode())
        with urllib.request.urlopen(req, timeout=120 if files else 70) as r:
            return json.loads(r.read().decode())

    async def tg(self, method, **params):
        return await asyncio.to_thread(self.call, method, **params)

    async def send(self, chat, text, to=None, **extra):
        """-> the sent message, or None (logged)."""
        if to:
            extra['reply_parameters'] = {'message_id': to, 'allow_sending_without_reply': True}
        try:
            return (await self.tg('sendMessage', chat_id=chat, text=text, **extra))['result']
        except urllib.error.HTTPError as e:
            if extra.get('parse_mode'):   # formatting Telegram can't parse: the caller sends it plain
                raise
            log(f'{self.conn}: send failed: {e.code} {e.read().decode(errors="replace")[:200]}')
        except Exception as e:  # noqa: BLE001
            log(f'{self.conn}: send failed: {type(e).__name__}: {e}')
        return None

    async def start(self):
        self.api = f'https://api.telegram.org/bot{self.secrets["TELEGRAM_BOT_TOKEN"]}/'
        me = (await self.tg('getMe'))['result']
        self.me, self.my_id = me['username'], me['id']
        log(f'{self.conn}: as @{self.me}')
        try:   # the / menu: one command per agent, plus kith's own
            commands = [{'command': cmd_name(a), 'description': description(a)[:250]} for a in agents()][:90]
            commands += [{'command': 'agents', 'description': 'the agents you can use'},
                         {'command': 'default', 'description': 'which agent answers messages without @agent here'},
                         {'command': 'stop', 'description': 'stop the agent working on this (reply to its message)'},
                         {'command': 'whoami', 'description': 'who you are in kith'}]
            await self.tg('setMyCommands', commands=commands)
        except Exception as e:  # noqa: BLE001  the menu is a convenience
            log(f'{self.conn}: commands not set: {type(e).__name__}')
        self.core.resume(self)
        offset = self.cs.get('offset', 0)   # Telegram keeps what came while the bridge was away (24 h) until confirmed
        while True:
            self.alive = time.monotonic()
            try:
                res = await self.tg('getUpdates', offset=offset, timeout=50,
                                    allowed_updates=['message', 'callback_query'])
            except urllib.error.HTTPError as e:
                if e.code in (401, 404):
                    raise   # the token is wrong or revoked: let the bridge back off
                log(f'{self.conn}: poll failed: {e.code}' + (' (another program reads this bot\'s updates)'
                                                              if e.code == 409 else ''))
                await asyncio.sleep(30 if e.code == 409 else 15)
                continue
            except Exception as e:  # noqa: BLE001  a network blip: wait and poll again
                log(f'{self.conn}: poll failed: {type(e).__name__}')
                await asyncio.sleep(15)
                continue
            for u in res.get('result', []):
                self.alive = time.monotonic()
                # before handling it: the save that queues its work also confirms it, so a restart never answers twice
                offset = self.cs['offset'] = u['update_id'] + 1
                try:
                    if u.get('message'):
                        m = await self.incoming(u['message'])
                        if m:
                            await self.core.handle(self, m)
                    elif u.get('callback_query'):
                        await self.button(u['callback_query'])
                except Exception as e:  # noqa: BLE001  one bad message must not stop the bot
                    log(f'{self.conn}: message failed: {type(e).__name__}: {e}')
            if res.get('result'):
                self.core.save()

    async def incoming(self, m):
        sender, chat = m.get('from') or {}, m.get('chat') or {}
        if sender.get('is_bot') or not sender.get('id') or m.get('sender_chat'):
            return None   # bots, and anonymous admins or channels posting as the group: no person behind them
        text = m.get('text') or m.get('caption') or ''
        private, cid, mid = chat.get('type') == 'private', chat['id'], m['message_id']
        other = re.match(r'\s*/\w+@(\w+)', text)
        if other and other.group(1).lower() != self.me.lower():
            return None   # a command for another bot in the group
        addressed = private or text.lstrip().startswith('/') or f'@{self.me}'.lower() in text.lower()
        text = re.sub(rf'@{re.escape(self.me)}\b', '', text, flags=re.I).strip()
        replied = m.get('reply_to_message') or {}
        thread, quoted = None, ''
        if replied:
            thread = self.core.replied_thread(self, cid, replied['message_id'])
            addressed = addressed or (replied.get('from') or {}).get('id') == self.my_id
            if not thread:
                quoted = replied.get('text') or replied.get('caption') or ''
        if not (private or addressed or thread):
            return None
        return Incoming(uid=str(sender['id']), text=text, room=f'{self.conn}:{cid}', thread=thread,
                        origin={'chat': cid, 'message': mid}, private=private, addressed=addressed, quoted=quoted,
                        files=await self.download(m), ref={'chat': cid, 'message': mid}, sent=m.get('date'))

    async def download(self, m):
        got = []
        kinds = [('photo', (m.get('photo') or [None])[-1]), ('document', m.get('document')), ('audio', m.get('audio')),
                 ('voice', m.get('voice')), ('video', m.get('video')), ('video_note', m.get('video_note'))]
        for kind, f in kinds:
            if not f:
                continue
            try:
                path = (await self.tg('getFile', file_id=f['file_id']))['result']['file_path']
                folder = STATE_DIR / 'attachments' / self.conn.replace('/', '-') / str(m['message_id'])
                folder.mkdir(parents=True, exist_ok=True)
                dest = folder / (f.get('file_name') or f'{kind}{os.path.splitext(path)[1]}')
                url = self.api.replace('/bot', '/file/bot', 1) + path
                await asyncio.to_thread(urllib.request.urlretrieve, url, dest)
                got.append(str(dest))
            except Exception as e:  # noqa: BLE001  over Telegram's 20 MB for bots, or gone
                log(f'{self.conn}: file not downloaded: {type(e).__name__}: {e}')
        return got

    async def button(self, q):
        data, msg = q.get('data') or '', q.get('message') or {}
        cid = (msg.get('chat') or {}).get('id')
        said = ''
        if data.startswith('stop:'):
            said = await self.core.stop_pressed(self, data[5:], str(q['from']['id']))
            if said == 'stopping':
                await self.edit(cid, msg.get('message_id'), '<i>stopping…</i>')
        elif data.startswith('pick:') and data.count(':') == 2:
            _, pid, agent = data.split(':')
            if await self.core.picked(self, pid, agent, str(q['from']['id'])):
                await self.edit(cid, msg.get('message_id'), f'→ {html.escape(agent)}')
            else:
                said = 'not yours'
        try:
            await self.tg('answerCallbackQuery', callback_query_id=q['id'],
                          **({'text': 'Only the person who asked can do that.'} if said == 'not yours' else {}))
        except Exception:  # noqa: BLE001
            pass

    async def edit(self, chat, mid, text, markup=None):
        try:
            await self.tg('editMessageText', chat_id=chat, message_id=mid, text=text, parse_mode='HTML',
                          **({'reply_markup': markup} if markup else {}))
        except Exception:  # noqa: BLE001  cosmetic
            pass

    async def reply(self, m, text):
        await self.send(m.origin['chat'], text, m.origin.get('message'))

    async def open_thread(self, m, agent, title):
        key = f'{self.conn}:{m.origin["chat"]}:{m.origin["message"]}'
        self.core.link_reply(self, m.origin['chat'], m.origin['message'], key)
        return key, {'chat': m.origin['chat'], 'reply_to': m.origin['message']}

    def follow(self, conv, m):
        self.core.link_reply(self, conv['chat'], m.origin['message'], conv['key'])
        return {**conv, 'reply_to': m.origin['message']}   # the answer replies to the newest message

    async def post(self, conv, agent, text, ctx=None):
        if ctx is not None:
            text += f'\n\n_context {ctx:.0f}%_'
        head = f'<b>{html.escape(display_name(agent))}</b>\n'
        for i, part in enumerate(chunks(text, 3000)):   # 4096 after formatting
            try:
                sent = await self.send(conv['chat'], (head if i == 0 else '') + tg_html(part), conv.get('reply_to'),
                                       parse_mode='HTML')
            except urllib.error.HTTPError:
                sent = await self.send(conv['chat'], (f'{display_name(agent)}\n' if i == 0 else '') + part,
                                       conv.get('reply_to'))
            if sent:
                self.core.link_reply(self, conv['chat'], sent['message_id'], conv['key'])
        self.core.save()

    async def send_files(self, conv, agent, files, caption=''):
        caption = f'{display_name(agent)}: {caption}' if caption else display_name(agent)
        for f in files:
            if not os.path.isfile(f):
                continue
            photo = f.lower().endswith(('.png', '.jpg', '.jpeg', '.webp')) and os.path.getsize(f) < 10_000_000
            method, field = ('sendPhoto', 'photo') if photo else ('sendDocument', 'document')
            try:
                sent = (await self.tg(method, files={field: f}, chat_id=conv['chat'], caption=caption[:1000],
                                      reply_parameters={'message_id': conv.get('reply_to'),
                                                        'allow_sending_without_reply': True}))['result']
                self.core.link_reply(self, conv['chat'], sent['message_id'], conv['key'])
            except Exception as e:  # noqa: BLE001
                log(f'{self.conn}: file not sent: {type(e).__name__}: {e}')
            caption = ''   # on the first one only
        self.core.save()

    async def status(self, conv, agent, wid):
        stop = {'inline_keyboard': [[{'text': 'Stop', 'callback_data': f'stop:{wid}'}]]}
        sent = await self.send(conv['chat'], 'working…', conv.get('reply_to'), reply_markup=stop,
                               disable_notification=True)
        return {'chat': conv['chat'], 'message_id': sent['message_id'], 'stop': stop} if sent else None

    async def status_text(self, handle, text):
        if handle:
            await self.edit(handle['chat'], handle['message_id'], html.escape(text),
                            None if 'restarting' in text else handle['stop'])

    async def status_end(self, conv, agent, handle, ended):
        if ended == 'stopped':
            if handle:
                await self.edit(handle['chat'], handle['message_id'], '<i>stopped</i>')
            else:
                await self.send(conv['chat'], 'stopped', conv.get('reply_to'), disable_notification=True)
        elif handle:
            try:
                await self.tg('deleteMessage', chat_id=handle['chat'], message_id=handle['message_id'])
            except Exception:  # noqa: BLE001  cosmetic
                pass

    async def react(self, m, what):
        if m.ref:
            try:
                await self.tg('setMessageReaction', chat_id=m.ref['chat'], message_id=m.ref['message'],
                              reaction=[{'type': 'emoji', 'emoji': REACT[what]}])
            except Exception:  # noqa: BLE001  cosmetic
                pass

    async def ask(self, m, pid, options):
        rows = [[{'text': a, 'callback_data': f'pick:{pid}:{a}'} for a in options[i:i + 3]]
                for i in range(0, len(options), 3)]
        await self.send(m.origin['chat'], 'Who should take this?', m.origin.get('message'),
                        reply_markup={'inline_keyboard': rows})

    async def typing(self, conv):
        while True:
            try:
                await self.tg('sendChatAction', chat_id=conv['chat'], action='typing')
            except Exception:  # noqa: BLE001  cosmetic
                pass
            await asyncio.sleep(5)
