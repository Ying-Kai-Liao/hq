import { useEffect, useState, type CSSProperties } from 'react'
import { CharacterAvatar, type Mood } from '../components/Avatar'
import { Button, Spinner } from '../components/Controls'
import { Icon } from '../components/Icon'
import { font } from '../lib/fonts'
import { useReduceMotion } from '../lib/theme'
import { useAccount } from '../store/account'
import googleLogo from '../assets/google.svg'

const deviceName = window.codync.platform === 'darwin' ? 'Mac' : 'computer'

/** First-run account choice. A restored session skips this screen as soon as it is back. */
export function AccountWelcomeView({ onContinue }: { onContinue: () => void }) {
  const account = useAccount()
  const reduce = useReduceMotion()
  const [beat, setBeat] = useState(reduce ? 4 : 0)

  useEffect(() => {
    if (account.isSignedIn) onContinue()
  }, [account.isSignedIn, onContinue])

  useEffect(() => {
    if (reduce) return setBeat(4)
    const timers = [150, 430, 710, 990].map((at, i) => setTimeout(() => setBeat(i + 1), at))
    return () => timers.forEach(clearTimeout)
  }, [reduce])

  if (!account.isReady) {
    // Keep first-run sign-in choices behind the persisted-session restore on launch.
    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14 }}>
        <Spinner size={24} />
        <div style={{ ...font('callout'), color: 'var(--secondary)' }}>Checking for a saved account…</div>
        <button style={{ color: 'var(--secondary)' }} onClick={onContinue}>
          Continue on this {deviceName}
        </button>
      </div>
    )
  }

  const rise = (shown: boolean): CSSProperties => ({
    opacity: shown ? 1 : 0,
    transform: shown ? 'none' : 'translateY(14px)',
    transition: 'opacity 0.6s cubic-bezier(0.34, 1.3, 0.64, 1), transform 0.6s cubic-bezier(0.34, 1.3, 0.64, 1)',
  })

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--background)' }}>
      <div style={{ minHeight: '100%', maxWidth: 480, margin: '0 auto', display: 'flex', flexDirection: 'column', padding: '0 24px 12px' }}>
        <div style={{ flex: 1, minHeight: 24 }} />
        <WelcomeCrew shown={beat >= 1} />
        <div style={{ flex: 1, minHeight: 24 }} />
        <div style={{ paddingBottom: 24 }}>
          <WelcomeChatGlimpse shown={beat >= 2} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, ...rise(beat >= 3) }}>
          <div style={{ fontSize: 34, fontWeight: 600, letterSpacing: -0.6, color: 'var(--text)', lineHeight: 1.15 }}>
            Your coding agents,
            <br />
            as teammates.
          </div>
          <div style={{ ...font('body'), color: 'var(--secondary)' }}>Give each one a name and a project. They work on your computer while you're away.</div>
        </div>
        <div style={{ flex: 1, minHeight: 32 }} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, ...rise(beat >= 4) }}>
          <Button onClick={onContinue} style={{ ...font('headline'), minHeight: 50, width: '100%' }}>
            Continue on this {deviceName}
          </Button>
          <Button onClick={() => void account.signIn('apple')} disabled={!account.isConfigured || account.isBusy} style={{ ...font('headline'), minHeight: 50, width: '100%' }}>
            {account.isBusy ? (
              <Spinner size={18} />
            ) : (
              <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Icon name="apple.logo" size={20} />
                Continue with Apple
              </span>
            )}
          </Button>
          <Button kind="secondary" onClick={() => void account.signIn('google')} disabled={!account.isConfigured || account.isBusy} style={{ ...font('headline'), minHeight: 50, width: '100%' }}>
            {account.isBusy ? (
              <Spinner size={18} />
            ) : (
              <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <img src={googleLogo} alt="" width={20} height={20} />
                Continue with Google
              </span>
            )}
          </Button>
          {!account.isConfigured ? (
            <div style={{ ...font('footnote'), color: 'var(--tertiary)' }}>Sign-in isn't configured in this build. You can still use Codync on this {deviceName}.</div>
          ) : null}
          {account.errorMessage ? <div style={{ ...font('footnote'), color: 'var(--warning)' }}>{account.errorMessage}</div> : null}
        </div>
      </div>
    </div>
  )
}

const crew: { shape: string; color: string; size: number; x: number; y: number; mood: Mood }[] = [
  { shape: 'blob', color: 'blue', size: 92, x: 0, y: 0, mood: 'working' },
  { shape: 'squircle', color: 'orange', size: 64, x: -104, y: -34, mood: 'idle' },
  { shape: 'teardrop', color: 'violet', size: 58, x: 100, y: -46, mood: 'working' },
  { shape: 'hex', color: 'green', size: 48, x: -76, y: 64, mood: 'idle' },
  { shape: 'cloud', color: 'magenta', size: 52, x: 84, y: 58, mood: 'needsInput' },
]

/** The animated bot group from the first iPhone onboarding screen. */
function WelcomeCrew({ shown }: { shown: boolean }) {
  const reduce = useReduceMotion()
  const [t, setT] = useState(0)
  useEffect(() => {
    if (reduce || !shown) return
    let frame = 0
    const tick = (now: number) => {
      setT(now / 1000)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [reduce, shown])
  return (
    <div aria-hidden style={{ position: 'relative', height: 170 }}>
      {crew.map((m, i) => (
        <div
          key={m.shape}
          style={{
            position: 'absolute', left: '50%', top: '50%',
            transform: `translate(calc(-50% + ${m.x}px), calc(-50% + ${m.y + (reduce ? 0 : Math.sin(t * 1.3 + i * 1.7) * 5)}px)) scale(${shown ? 1 : 0.3})`,
            opacity: shown ? 1 : 0,
            transition: `opacity 0.7s cubic-bezier(0.34, 1.56, 0.64, 1) ${i * 0.07}s, scale 0.7s cubic-bezier(0.34, 1.56, 0.64, 1) ${i * 0.07}s`,
          }}
        >
          <CharacterAvatar shape={m.shape} color={m.color} size={m.size} mood={m.mood} />
        </div>
      ))}
    </div>
  )
}

/** A short animated user and bot exchange, matching the iPhone onboarding preview. */
function WelcomeChatGlimpse({ shown }: { shown: boolean }) {
  const reduce = useReduceMotion()
  const [replied, setReplied] = useState(false)
  useEffect(() => {
    if (!shown) return
    const timer = setTimeout(() => setReplied(true), reduce ? 0 : 1600)
    return () => clearTimeout(timer)
  }, [shown, reduce])
  const rise: CSSProperties = { opacity: shown ? 1 : 0, transform: shown ? 'none' : 'translateY(14px)', transition: 'opacity 0.6s, transform 0.6s cubic-bezier(0.34, 1.3, 0.64, 1)' }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', ...rise }}>
        <span style={{ ...font('subheadline'), color: 'var(--text)', padding: '9px 14px', background: 'var(--bubble-user)', borderRadius: 18 }}>Fix the flaky login test</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, ...rise }}>
        <CharacterAvatar shape="blob" color="blue" size={28} mood={replied ? 'idle' : 'working'} />
        {replied ? (
          <span style={{ ...font('subheadline'), color: 'var(--text)', padding: '9px 14px', background: 'var(--bubble-agent)', borderRadius: 18, animation: 'bubble-in 0.45s cubic-bezier(0.34, 1.3, 0.64, 1) both', transformOrigin: 'bottom left' }}>
            Done. It raced the session refresh; tests pass on fix/login.
          </span>
        ) : (
          <span style={{ ...font('subheadline'), color: 'var(--tertiary)' }}>Working…</span>
        )}
      </div>
      <style>{'@keyframes bubble-in { from { opacity: 0; transform: scale(0.92) } }'}</style>
    </div>
  )
}
