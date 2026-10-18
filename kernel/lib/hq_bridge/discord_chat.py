"""Discord: one bot in one server. Every agent has its own channel in the `hq` category (a room whose default is that
agent); any other channel is a room too, answered when an agent or the bot is mentioned, or once it has a default
(/default <agent>). A task is a thread; agents post in it through the channel's webhook under their display name,
and hq-send (HQ_DISCORD_WEBHOOK_URL, HQ_DISCORD_THREAD_ID) posts there too. Each agent has a mentionable role of the
same name, so @ autocompletes; when the bot can't manage roles, a plain-text @agent works the same. DMs with the bot
work like a room with a default (the owner's: HQ_BRIDGE_DM_DEFAULT).

Server: HQ_DISCORD_GUILD (name or ID) when the bot is in more than one.
"""
import asyncio
import os
import re

import discord

from .core import STATE_DIR, Adapter, Incoming, agents, chunks, description, display_name, log

WORKING, STOPPED = '-# working…', '-# stopped'   # Discord subtext: small and grey


class Discord(Adapter):
    platform = 'discord'
    footer = ('\n\n(From Discord: this thread is your task. Your final answer is posted here automatically; use '
              'hq-send for images and files. Helpers you call post status with `hq-send --as <their name>`.)')

    async def start(self):
        intents = discord.Intents.default()
        intents.message_content = True
        self.client = client = discord.Client(intents=intents)
        self.hooks: dict[int, discord.Webhook] = {}
        self.roles: dict[int, str] = {}      # role id → agent
        self.guild = None
        self.cs.setdefault('hooks', {})
        ready = asyncio.Event()

        @client.event
        async def on_ready():
            squash = lambda x: re.sub(r'\s+', '', x).lower()
            want = squash(os.environ.get('HQ_DISCORD_GUILD', '')) if self.conn == 'discord/hq' else ''
            guilds = [g for g in client.guilds if not want or want in (squash(g.name), str(g.id))]
            if len(guilds) != 1:
                log(f'{self.conn}: expected one server, found {[g.name for g in client.guilds]}; set HQ_DISCORD_GUILD')
                await client.close()
                return
            self.guild = guilds[0]
            await self.setup()
            if not ready.is_set():   # on_ready fires again after reconnects
                ready.set()
                self.core.resume(self)
                asyncio.create_task(self.rescan())

        @client.event
        async def on_message(msg):
            if msg.author.bot or msg.webhook_id:
                return
            try:
                m = await self.incoming(msg)
                if m:
                    await self.core.handle(self, m)
            except Exception as e:  # noqa: BLE001  one bad message must not stop the bot
                log(f'{self.conn}: message failed: {type(e).__name__}: {e}')

        @client.event
        async def on_interaction(it):
            cid = (it.data or {}).get('custom_id', '')
            if cid.startswith('hq-stop:'):
                said = await self.core.stop_pressed(self, cid.split(':', 1)[1], str(it.user.id))
                if said == 'not yours':
                    return await it.response.send_message('Only the person who started this can stop it.',
                                                          ephemeral=True)
                await it.response.edit_message(content='-# finished' if said == 'finished' else '-# stopping…',
                                               view=None)
            elif cid.startswith('hq-pick:'):
                _, pid, agent = cid.split(':', 2)
                ok = await self.core.picked(self, pid, agent, str(it.user.id))
                if ok:
                    await it.response.edit_message(content=f'→ {agent}', view=None)
                else:
                    await it.response.send_message('That question is someone else\'s, or already answered.',
                                                   ephemeral=True)

        await client.start(self.secrets['DISCORD_BOT_TOKEN'])

    async def setup(self):
        g = self.guild
        category = discord.utils.get(g.categories, name='hq') or await g.create_category('hq')
        for agent in agents():
            ch = discord.utils.get(g.text_channels, name=agent)
            if ch is None:
                ch = await g.create_text_channel(agent, category=category, topic=description(agent))
            await self.hook(ch)
        if g.me.guild_permissions.manage_roles:
            for agent in agents():
                role = discord.utils.get(g.roles, name=agent)
                if role is None:
                    role = await g.create_role(name=agent, mentionable=True, reason='hq: @agent autocompletes')
                self.roles[role.id] = agent
        elif 'roles' not in self.cs:
            self.cs['roles'] = 'none'
            log(f'{self.conn}: no Manage Roles permission, so no @agent roles; plain @agent works the same')
        self.core.save()
        log(f'{self.conn}: ready in {g.name}: {", ".join(agents())}')

    async def rescan(self):
        # New agents (from the builder or hq-new) get their channel within a minute, no restart needed.
        while True:
            await asyncio.sleep(60)
            try:
                have = {c.name for c in self.guild.text_channels}
                if set(agents()) - have or (self.guild.me.guild_permissions.manage_roles
                                            and set(agents()) - set(self.roles.values())):
                    await self.setup()
            except Exception as e:  # noqa: BLE001  a failed rescan must never take the bridge down
                log(f'{self.conn}: rescan failed: {e}')

    async def hook(self, channel):
        """The channel's webhook, made once: agents post through it under their own names."""
        if channel.id in self.hooks:
            return self.hooks[channel.id]
        url = self.cs['hooks'].get(str(channel.id))
        if not url:
            wh = next((w for w in await channel.webhooks() if w.name == 'hq'), None) \
                or await channel.create_webhook(name='hq')
            url = self.cs['hooks'][str(channel.id)] = wh.url
            self.core.save()
        self.hooks[channel.id] = discord.Webhook.from_url(url, client=self.client)
        return self.hooks[channel.id]

    async def incoming(self, msg):
        ch = msg.channel
        me = self.client.user.id
        text = msg.content or ''
        addressed = bool(re.search(rf'<@!?{me}>', text))
        text = re.sub(rf'\s*<@!?{me}>\s*', ' ', text).strip()
        for rid in re.findall(r'<@&(\d+)>', text):   # an agent's role: the same as typing @agent
            if int(rid) in self.roles:
                text = text.replace(f'<@&{rid}>', f'@{self.roles[int(rid)]}')
                addressed = True
        if any(f'@{a}' in text for a in agents()):
            addressed = True
        if msg.reference and msg.reference.message_id:
            ref = msg.reference.resolved
            if isinstance(ref, discord.Message) and (ref.webhook_id or ref.author.id == me):
                addressed = True
        if isinstance(ch, discord.DMChannel):
            room, thread, private, room_agent = f'{self.conn}:dm:{ch.id}', None, True, None
            ref_id = msg.reference.message_id if msg.reference else None
            thread = self.core.replied_thread(self, ch.id, ref_id) if ref_id else None
            origin = {'dm': ch.id, 'message': msg.id}
        elif isinstance(ch, discord.Thread) and ch.parent:
            room, thread, private = f'{self.conn}:{ch.parent.id}', f'{self.conn}:{ch.id}', False
            room_agent = ch.parent.name if ch.parent.name in agents() else None
            origin = {'thread': ch.id, 'channel': ch.parent.id, 'message': msg.id}
            if thread not in self.core.st['threads'] and not addressed:
                return None   # someone else's thread, not talking to hq
        elif isinstance(ch, discord.TextChannel):
            room, thread, private = f'{self.conn}:{ch.id}', None, False
            room_agent = ch.name if ch.name in agents() else None
            origin = {'channel': ch.id, 'message': msg.id}
        else:
            return None
        files = []
        ours = addressed or private or room_agent or thread in self.core.st['threads'] \
            or self.core.st['rooms'].get(room, {}).get('default')
        if msg.attachments and ours:   # only for messages hq may act on
            folder = STATE_DIR / 'attachments' / self.conn.replace('/', '-') / str(msg.id)
            folder.mkdir(parents=True, exist_ok=True)
            for a in msg.attachments:
                p = folder / a.filename
                await a.save(p)
                files.append(str(p))
        admin = self.guild is not None and msg.author.id == self.guild.owner_id
        return Incoming(uid=str(msg.author.id), text=text, room=room, origin=origin, thread=thread,
                        private=private, addressed=addressed or private, room_agent=room_agent, admin=admin,
                        files=files, ref=msg)

    async def where(self, conv):
        cid = conv.get('thread') or conv.get('dm') or conv.get('channel')
        return self.client.get_channel(int(cid)) or await self.client.fetch_channel(int(cid))

    async def reply(self, m, text):
        if m.ref is not None:
            await m.ref.reply(text)
        else:
            await (await self.where(m.origin)).send(text)

    async def open_thread(self, m, agent, title):
        o = m.origin
        if o.get('thread'):          # a thread hq didn't start: the task lives in it as it is
            return f'{self.conn}:{o["thread"]}', {'thread': o['thread'], 'channel': o['channel']}
        if o.get('dm'):              # no threads in a DM: a reply to the agent's message continues the task
            return f'{self.conn}:dm:{o["dm"]}:{o["message"]}', {'dm': o['dm']}
        msg = m.ref if m.ref is not None else await (await self.where(o)).fetch_message(int(o['message']))
        th = await msg.create_thread(name=title, auto_archive_duration=1440)
        return f'{self.conn}:{th.id}', {'thread': th.id, 'channel': o['channel']}

    async def post(self, conv, agent, text, ctx=None):
        text = text + (f'\n-# context {ctx:.0f}%' if ctx is not None else '')
        if conv.get('dm'):
            ch = await self.where(conv)
            for i, part in enumerate(chunks(text, 1900)):
                sent = await ch.send((f'**{display_name(agent)}**\n' if i == 0 else '') + part)
                self.core.link_reply(self, conv['dm'], sent.id, conv['key'])
            self.core.save()
            return
        hook, thread = await self.hook(await self.where({'channel': conv['channel']})), await self.where(conv)
        for part in chunks(text):
            await hook.send(part, username=display_name(agent), thread=thread, wait=True)

    async def send_files(self, conv, agent, files, caption=''):
        fs = [discord.File(f) for f in files if os.path.isfile(f)][:10]
        if conv.get('dm'):
            await (await self.where(conv)).send(f'**{display_name(agent)}** {caption}'.strip(), files=fs)
            return
        hook = await self.hook(await self.where({'channel': conv['channel']}))
        await hook.send(caption or discord.utils.MISSING, files=fs, username=display_name(agent),
                        thread=await self.where(conv), wait=True)

    def stop_button(self, wid):
        view = discord.ui.View(timeout=None)
        view.add_item(discord.ui.Button(label='Stop', style=discord.ButtonStyle.secondary,
                                        custom_id=f'hq-stop:{wid}'))   # handled in on_interaction: survives restarts
        return view

    async def status(self, conv, agent, wid):
        if conv.get('dm'):
            return await (await self.where(conv)).send(WORKING, view=self.stop_button(wid))
        # from the agent itself, as small grey text; the webhook is the bot's, so its button works
        hook = await self.hook(await self.where({'channel': conv['channel']}))
        return await hook.send(WORKING, username=display_name(agent), thread=await self.where(conv),
                               view=self.stop_button(wid), wait=True)

    async def status_text(self, handle, text):
        if handle is not None:
            try:
                await handle.edit(content=f'-# {text}', **({'view': None} if 'restarting' in text else {}))
            except Exception:  # noqa: BLE001  cosmetic
                pass

    async def status_end(self, conv, agent, handle, ended):
        if ended == 'stopped' and handle is not None:
            await handle.edit(content=STOPPED, view=None)
        elif ended == 'stopped':
            await self.post(conv, agent, STOPPED)
        elif handle is not None:
            await handle.delete()

    async def react(self, m, what):
        if m.ref is not None:
            try:
                await m.ref.add_reaction({'stop': '🛑', 'redo': '🔁'}[what])
            except Exception:  # noqa: BLE001  cosmetic
                pass

    async def ask(self, m, pid, options):
        view = discord.ui.View(timeout=None)
        for a in options[:25]:
            view.add_item(discord.ui.Button(label=a, style=discord.ButtonStyle.secondary,
                                            custom_id=f'hq-pick:{pid}:{a}'))
        if m.ref is not None:
            await m.ref.reply('Who should take this?', view=view)
        else:
            await (await self.where(m.origin)).send('Who should take this?', view=view)

    async def typing(self, conv):
        ch = await self.where(conv)
        async with ch.typing():
            await asyncio.Event().wait()

    def env(self, conv, agent):
        if conv.get('dm'):
            return {}   # no webhooks in a DM: hq-send goes through the outbox
        url = self.cs['hooks'].get(str(conv['channel']))
        return {'HQ_DISCORD_WEBHOOK_URL': url, 'HQ_DISCORD_THREAD_ID': str(conv['thread'])} if url else {}
