import { MAX_FULL, type Tier } from '@shared/living-bots'

// What is shared by every living bot in one window: a single IntersectionObserver that freezes the ones
// off screen, the cap on how many run the full tier, and the pause while the window is hidden.
// No per-avatar timers or frames: the avatars animate with CSS and are only switched here, on events.

export interface Slot {
  el: HTMLElement
  /** The tier its size asks for. */
  tier: Tier
  visible: boolean
  /** Starts its loops again at their mount phase (`all`: the blinks too). */
  rephase: (all: boolean) => void
}

const slots = new Map<Element, Slot>()
let observer: IntersectionObserver | null = null
let queued = false

function apply(slot: Slot, tier: Tier) {
  const was = slot.el.dataset.eff
  if (was === tier) return
  slot.el.dataset.eff = tier
  // Coming back on screen: add the animations again as if they had never stopped.
  if (was === 'static' && tier !== 'static') slot.rephase(true)
  else if (was === 'blink' && tier === 'full') slot.rephase(false)
}

/** Decides every avatar's running tier: off screen is frozen, then the first MAX_FULL in reading order run full. */
function settle() {
  queued = false
  const full: { slot: Slot; top: number; left: number }[] = []
  for (const slot of slots.values()) {
    if (!slot.visible) apply(slot, 'static')
    else if (slot.tier === 'full') {
      const rect = slot.el.getBoundingClientRect()
      full.push({ slot, top: Math.round(rect.top), left: rect.left })
    } else apply(slot, slot.tier)
  }
  full.sort((a, b) => a.top - b.top || a.left - b.left)
  full.forEach(({ slot }, i) => apply(slot, i < MAX_FULL ? 'full' : 'blink'))
}

export function scheduleSettle() {
  if (queued) return
  queued = true
  queueMicrotask(settle)
}

function resume() {
  const running = [...slots.values()].filter((s) => s.visible && s.el.dataset.eff !== 'static')
  const tiers = running.map((s) => s.el.dataset.eff as Tier)
  for (const slot of running) {
    slot.el.dataset.eff = 'static'
    slot.rephase(true)
  }
  void document.body.offsetWidth // one style pass for all: the animations really restart
  running.forEach((slot, i) => (slot.el.dataset.eff = tiers[i]))
}

function install() {
  if (observer) return
  observer = new IntersectionObserver((records) => {
    for (const record of records) {
      const slot = slots.get(record.target)
      if (slot) slot.visible = record.isIntersecting
    }
    scheduleSettle()
  })
  document.addEventListener('visibilitychange', () => {
    const root = document.documentElement
    if (document.visibilityState === 'hidden') root.dataset.kbPaused = ''
    else {
      delete root.dataset.kbPaused
      resume()
    }
  })
}

/** Puts an avatar under the window's watch; returns the way out. */
export function watch(slot: Slot) {
  install()
  slots.set(slot.el, slot)
  observer!.observe(slot.el)
  scheduleSettle()
  return () => {
    slots.delete(slot.el)
    observer!.unobserve(slot.el)
    scheduleSettle()
  }
}
