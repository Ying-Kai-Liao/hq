"""Slack: one app in Socket Mode (no public URL), a slack/<workspace> profile granted to the bridge with
SLACK_BOT_TOKEN (xoxb-) and SLACK_APP_TOKEN (xapp-, connections:write). Channels the app is in and DMs with it are
rooms; a task is a Slack thread. `@agent` as plain text picks the agent (Slack has one bot user per app, so no
autocomplete); mentioning the app or a DM addresses kith; commands start with ! (Slack keeps / for its own): !link CODE,
!agents, !default, !stop, !whoami. Agents post under their display name (chat:write.customize).

The app needs: bot scopes app_mentions:read, channels:history, groups:history, im:history, chat:write,
chat:write.customize, files:read, files:write, reactions:write; events message.channels, message.groups, message.im;
Interactivity on (the Stop and pick buttons); Socket Mode on.
"""
import asyncio
import os
import re

from slack_sdk.socket_mode.aiohttp import SocketModeClient
from slack_sdk.socket_mode.response import SocketModeResponse
from slack_sdk.web.async_client import AsyncWebClient

from .core import STATE_DIR, Adapter, Incoming, chunks, display_name, log

REACT = {'stop': 'octagonal_sign', 'redo': 'repeat'}


class Slack(Adapter):
    platform = 'slack'
    footer = ('\n\n(From Slack: this thread is your task. Your final answer is posted here automatically; Markdown '
              'works. Send images and files with kith-send; files the user sent are listed as paths. Helpers you call '
              'post status with `kith-send --as <their name>`.)')

    async def start(self):
        self.web = AsyncWebClient(token=self.secrets['SLACK_BOT_TOKEN'])
        me = await self.web.auth_test()
        self.my_id, team = me['user_id'], me.get('team', '')
        sm = SocketModeClient(app_token=self.secrets['SLACK_APP_TOKEN'], web_client=self.web)
        dropped = asyncio.Event()

        async def on(client, req):
            await client.send_socket_mode_response(SocketModeResponse(envelope_id=req.envelope_id))
            try:
                if req.type == 'events_api' and req.payload.get('event', {}).get('type') == 'message':
                    m = await self.incoming(req.payload['event'])
                    if m:
                        await self.core.handle(self, m)
                elif req.type == 'interactive' and req.payload.get('type') == 'block_actions':
                    await self.button(req.payload)
            except Exception as e:  # noqa: BLE001  one bad message must not stop the app
                log(f'{self.conn}: event failed: {type(e).__name__}: {e}')
        sm.socket_mode_request_listeners.append(on)
        await sm.connect()
        log(f'{self.conn}: in {team} as <@{self.my_id}>')
        self.core.resume(self)
        try:
            while not dropped.is_set():
                await asyncio.sleep(60)
                if not await sm.is_connected():
                    await asyncio.sleep(30)   # the client reconnects by itself; give it time before giving up
                    if not await sm.is_connected():
                        raise ConnectionError('socket mode disconnected')
        finally:
            await sm.close()

    async def incoming(self, e):
        if e.get('bot_id') or e.get('subtype') not in (None, 'file_share', 'thread_broadcast') or not e.get('user'):
            return None   # bots (kith's own posts too), edits, joins
        ch, ts = e['channel'], e['ts']
        private = e.get('channel_type') == 'im'
        text = e.get('text') or ''
        addressed = private or f'<@{self.my_id}>' in text
        text = re.sub(rf'\s*<@{self.my_id}>\s*', ' ', text).strip()
        text = re.sub(r'^\s*!', '/', text)   # !link CODE, !agents ...: the core's /commands
        text = re.sub(r'<(https?://[^|>]+)\|([^>]+)>', r'[\2](\1)', text)
        text = re.sub(r'<(https?://[^|>]+)>', r'\1', text).replace('&lt;', '<').replace('&gt;', '>').replace('&amp;', '&')
        thread = f'{self.conn}:{ch}:{e["thread_ts"]}' if e.get('thread_ts') else None
        if not (private or addressed or thread in self.core.st['threads']
                or re.search(r'(?<![\w@])@[\w-]+', text) or self.core.st['rooms'].get(f'{self.conn}:{ch}', {}).get('default')):
            return None
        return Incoming(uid=e['user'], text=text, room=f'{self.conn}:{ch}', thread=thread, private=private,
                        origin={'channel': ch, 'ts': ts, 'thread_ts': e.get('thread_ts')}, addressed=addressed,
                        files=await self.download(e), ref={'channel': ch, 'ts': ts})

    async def download(self, e):
        got = []
        for f in e.get('files') or []:
            url = f.get('url_private_download') or f.get('url_private')
            if not url:
                continue
            try:
                folder = STATE_DIR / 'attachments' / self.conn.replace('/', '-') / e['ts']
                folder.mkdir(parents=True, exist_ok=True)
                dest = folder / os.path.basename(f.get('name') or f['id'])
                import aiohttp
                async with aiohttp.ClientSession() as s, s.get(url, headers={
                        'Authorization': f'Bearer {self.secrets["SLACK_BOT_TOKEN"]}'}) as r:
                    r.raise_for_status()
                    dest.write_bytes(await r.read())
                got.append(str(dest))
            except Exception as ex:  # noqa: BLE001
                log(f'{self.conn}: file not downloaded: {type(ex).__name__}: {ex}')
        return got

    async def button(self, p):
        act = (p.get('actions') or [{}])[0]
        uid, ch = p['user']['id'], p['channel']['id']
        ts = p['container'].get('message_ts')
        if act.get('action_id') == 'kith-stop':
            said = await self.core.stop_pressed(self, act['value'], uid)
            if said == 'not yours':
                await self.web.chat_postEphemeral(channel=ch, user=uid, text='Only the person who started this can stop it.')
            else:
                await self.web.chat_update(channel=ch, ts=ts, text='stopping…', blocks=[self.small('stopping…')])
        elif act.get('action_id', '').startswith('kith-pick'):
            pid, agent = act['value'].split(':', 1)
            if await self.core.picked(self, pid, agent, uid):
                await self.web.chat_update(channel=ch, ts=ts, text=f'→ {agent}', blocks=[self.small(f'→ {agent}')])
            else:
                await self.web.chat_postEphemeral(channel=ch, user=uid, text='That question is someone else\'s.')

    @staticmethod
    def small(text):
        return {'type': 'context', 'elements': [{'type': 'mrkdwn', 'text': text}]}

    async def reply(self, m, text):
        o = m.origin
        await self.web.chat_postMessage(channel=o['channel'], text=text,
                                        thread_ts=None if m.private and not o.get('thread_ts') else o.get('thread_ts') or o['ts'])

    async def open_thread(self, m, agent, title):
        o = m.origin
        root = o.get('thread_ts') or o['ts']
        return f'{self.conn}:{o["channel"]}:{root}', {'channel': o['channel'], 'thread_ts': root}

    async def post(self, conv, agent, text, ctx=None):
        if ctx is not None:
            text += f'\n\n_context {ctx:.0f}%_'
        for part in chunks(text, 11000):   # a markdown block holds 12,000
            try:
                await self.web.chat_postMessage(channel=conv['channel'], thread_ts=conv['thread_ts'], text=part[:3000],
                                                username=display_name(agent),
                                                blocks=[{'type': 'markdown', 'text': part}])
            except Exception:  # noqa: BLE001  an older workspace without markdown blocks: plain text
                await self.web.chat_postMessage(channel=conv['channel'], thread_ts=conv['thread_ts'], text=part,
                                                username=display_name(agent))

    async def send_files(self, conv, agent, files, caption=''):
        ups = [{'file': f, 'filename': os.path.basename(f)} for f in files if os.path.isfile(f)]
        if ups:
            await self.web.files_upload_v2(channel=conv['channel'], thread_ts=conv['thread_ts'], file_uploads=ups,
                                           initial_comment=f'*{display_name(agent)}* {caption}'.strip())

    async def status(self, conv, agent, wid):
        r = await self.web.chat_postMessage(
            channel=conv['channel'], thread_ts=conv['thread_ts'], text='working…', username=display_name(agent),
            blocks=[self.small('working…'), {'type': 'actions', 'elements': [{
                'type': 'button', 'text': {'type': 'plain_text', 'text': 'Stop'}, 'action_id': 'kith-stop',
                'value': wid}]}])
        return {'channel': r['channel'], 'ts': r['ts'], 'wid': wid}

    async def status_text(self, handle, text):
        if not handle:
            return
        blocks = [self.small(text)]
        if 'restarting' not in text:
            blocks.append({'type': 'actions', 'elements': [{'type': 'button', 'text': {
                'type': 'plain_text', 'text': 'Stop'}, 'action_id': 'kith-stop', 'value': handle['wid']}]})
        try:
            await self.web.chat_update(channel=handle['channel'], ts=handle['ts'], text=text, blocks=blocks)
        except Exception:  # noqa: BLE001  cosmetic
            pass

    async def status_end(self, conv, agent, handle, ended):
        if ended == 'stopped':
            if handle:
                await self.web.chat_update(channel=handle['channel'], ts=handle['ts'], text='stopped',
                                           blocks=[self.small('stopped')])
            else:
                await self.web.chat_postMessage(channel=conv['channel'], thread_ts=conv['thread_ts'], text='stopped',
                                                username=display_name(agent))
        elif handle:
            await self.web.chat_delete(channel=handle['channel'], ts=handle['ts'])

    async def react(self, m, what):
        if m.ref:
            try:
                await self.web.reactions_add(channel=m.ref['channel'], timestamp=m.ref['ts'], name=REACT[what])
            except Exception:  # noqa: BLE001  cosmetic
                pass

    async def ask(self, m, pid, options):
        o = m.origin
        buttons = [{'type': 'button', 'text': {'type': 'plain_text', 'text': a}, 'action_id': f'kith-pick-{a}',
                    'value': f'{pid}:{a}'} for a in options]
        await self.web.chat_postMessage(channel=o['channel'], thread_ts=o.get('thread_ts') or o['ts'],
                                        text='Who should take this?',
                                        blocks=[{'type': 'section', 'text': {'type': 'mrkdwn', 'text': 'Who should take this?'}}]
                                        + [{'type': 'actions', 'elements': buttons[i:i + 5]} for i in range(0, len(buttons), 5)])
