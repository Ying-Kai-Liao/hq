import { useEffect, useState } from 'react'
import type { TraySummary } from '@shared/ipc'
import { isGroup, isWorking, needsInput, folderName, type Bot, type UsageWindow } from '@shared/models'
import { avatarImage, DEFAULT_IMAGE } from '@shared/crew'
import { drawBotIcon, iconBody, onIconsLoaded } from '../components/living-bots-art'
import { useModels } from '../lib/observable'
import { prefs, usePref } from '../lib/prefs'
import { isDark, palette } from '../lib/theme'
import type { AppModel } from '../store/app-model'
import { providerTint, resetDate, untilText, windowTitle } from './usage/usage-model'
import { mascotDataURL } from './usage/ProviderMascot'

const isMac = window.kith.platform === 'darwin'

/** Rendered icons by what they show and the appearance: nothing is redrawn while nothing changed. */
const cache = new Map<string, string>()

function canvasURL(key: string, width: number, height: number, draw: (ctx: CanvasRenderingContext2D) => void) {
  const full = `${key}|${isDark()}`
  const hit = cache.get(full)
  if (hit) return hit
  const ratio = 2
  const canvas = document.createElement('canvas')
  canvas.width = width * ratio
  canvas.height = height * ratio
  const ctx = canvas.getContext('2d')!
  ctx.scale(ratio, ratio)
  draw(ctx)
  const url = canvas.toDataURL('image/png')
  cache.set(full, url)
  return url
}

function avatarIcon(bot: Bot) {
  const name = (avatarImage(bot) ?? DEFAULT_IMAGE).name
  // The body loads once; until it has, the bot has no icon and the summary is sent again when it is ready.
  const body = iconBody(name, bot.avatarColor)
  if (!body) return null
  const key = `bot|${name}|${bot.avatarColor}|${bot.status}|${bot.unread > 0}`
  return canvasURL(key, 20, 20, (ctx) => {
    const dark = isDark()
    drawBotIcon(ctx, name, body, 20)
    const badge = needsInput(bot) ? palette(dark).warning : bot.unread > 0 ? (dark ? '#FFFFFF' : '#000000') : null
    if (badge) {
      const r = needsInput(bot) ? 3.6 : 2.8
      ctx.beginPath()
      ctx.arc(20 - r, 20 - r, r + 1, 0, Math.PI * 2)
      ctx.fillStyle = dark ? '#1e1e1e' : '#f2f2f2'
      ctx.fill()
      ctx.beginPath()
      ctx.arc(20 - r, 20 - r, r, 0, Math.PI * 2)
      ctx.fillStyle = badge
      ctx.fill()
    }
  })
}

/** A bot's line under its name: that it needs you, what it's doing, or its last message. */
export function botDetail(bot: Bot) {
  return needsInput(bot) ? 'Needs your response' : isWorking(bot) ? bot.activity || 'Working…' : (bot.lastMessage ?? folderName(bot))
}

/** One usage limit's bar in the provider's color: amber from 70%, red from 90%. */
function barIcon(providerId: string, window: UsageWindow) {
  const percent = Math.round(window.percent)
  return canvasURL(`bar|${providerId}|${percent}`, 60, 16, (ctx) => {
    const dark = isDark()
    const color = window.percent >= 90 ? palette(dark).danger : window.percent >= 70 ? palette(dark).warning : providerTint(providerId)
    ctx.fillStyle = dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)'
    ctx.beginPath()
    ctx.roundRect(0, 5.5, 60, 5, 2.5)
    ctx.fill()
    if (window.percent > 0) {
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.roundRect(0, 5.5, Math.max(5, 60 * Math.min(1, window.percent / 100)), 5, 2.5)
      ctx.fill()
    }
  })
}

function usageLine(w: UsageWindow) {
  const reset = resetDate(w)
  return `${windowTitle(w)} · ${Math.round(w.percent)}%${reset ? ` · resets in ${untilText(reset)}` : ''}`
}

/** Sends what the menu bar shows whenever the stores change. */
export function useTraySummary(app: AppModel) {
  const stores = [...app.stores.values()]
  useModels(stores)
  const [, iconsLoaded] = useState(0)
  useEffect(() => onIconsLoaded(() => iconsLoaded((n) => n + 1)), [])
  const [textSize] = usePref(prefs.textSize)
  const [iconStyle] = usePref(prefs.usageIconStyle)
  useEffect(() => {
    const timer = setTimeout(() => {
      const local = app.local
      const roster = app.roster.filter((i) => !isGroup(i.bot))
      const status = app.approvals.length
        ? 'A device asks for access'
        : app.botRequests.length
          ? 'A bot asks to join'
          : app.needsAttention
          ? 'A bot needs you'
          : app.working > 0
            ? `${app.working} bot${app.working === 1 ? '' : 's'} working`
            : 'Connected'
      const screen = local?.screen
      const summary: TraySummary = {
        status,
        canPair: !!local,
        approval: app.approvals[0]?.request.deviceName ?? null,
        botRequest: app.botRequests[0] ? (app.botRequests[0].bot.ownerName ?? app.botRequests[0].bot.name) : null,
        bots: roster.map((i) => ({
          ref: `${i.ref.computerId}/${i.ref.botId}`,
          name: app.computers.length > 1 ? `${i.bot.name} · ${i.computer.name}` : i.bot.name,
          detail: botDetail(i.bot),
          working: isWorking(i.bot),
          avatar: avatarIcon(i.bot),
        })),
        usage: (local?.usage.providers ?? []).map((p) => ({
          name: p.name,
          icon: mascotDataURL(p, 16, iconStyle, isDark()),
          lines: p.windows.map((w) => ({ title: usageLine(w), bar: barIcon(p.id, w) })),
        })),
        screen: screen
          ? {
              enabled: screen.enabled,
              subtitle: screenSubtitle(app),
              error: app.screenError,
            }
          : null,
        version: local?.hello?.version ?? null,
        needsAttention: app.needsAttention,
        textSize,
        usageIconStyle: iconStyle,
      }
      window.kith.app.setTraySummary(summary)
    }, 150)
    return () => clearTimeout(timer)
  })
}

function screenSubtitle(app: AppModel) {
  const local = app.local
  const screen = local?.screen
  if (!local || !screen || !screen.enabled) return `Control this ${isMac ? 'Mac' : 'computer'} from your iPhone`
  if (app.screenNeedsApproval) return 'Needs approval in System Settings'
  if (!screen.connected) return 'Starting Kith Screen…'
  if (!screen.capture || !screen.input) return 'Needs permission'
  if (screen.viewers > 0) return screen.viewers === 1 ? 'Your phone is viewing' : `${screen.viewers} viewers`
  const bot = screen.agentBot ? local.bots.get(screen.agentBot) : null
  if (bot) return `${bot.name} is using it`
  const display = screen.displays.find((d) => d.main)?.name ?? screen.displays[0]?.name
  return display ? `Ready · ${display}` : 'Ready'
}
