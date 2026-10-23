// Dev-only token gallery (`npm run tokens`): the redesign's colours, type ramp, sky and glass, in the
// scheme the system is set to. Not part of the app build.
import { createRoot } from 'react-dom/client'
import '../styles/theme.css'

const colours = ['ink', 'muted', 'muted-on-sky', 'line', 'panel', 'accent', 'accent-dark', 'attention', 'attention-bg', 'positive', 'negative', 'night', 'glass-tint']
const radii = ['chip', 'row-tool', 'card', 'sheet', 'glass-pill']
const ramp = [
  ['agent-name', 'Nunito 800 16 / 1.2', 'Marlo the researcher'],
  ['top-bar', 'Inter 600 16', 'Crew'],
  ['body', 'Inter 400 15 / 1.45', 'Looked through the inbox and found three threads that need a reply today.'],
  ['secondary', 'Inter 400 13', 'Updated 4 minutes ago'],
  ['label', 'Inter 700 11, 0.06em', 'NEEDS YOUR OK'],
  ['code', 'JetBrains Mono 400 12', 'kith serve --port 8787'],
] as const

const section = { padding: '0 var(--kith-gutter)', marginBottom: 28 }
const heading = { color: 'var(--kith-muted)', marginBottom: 10 }

function Gallery() {
  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--kith-ground)', color: 'var(--kith-ink)' }}>
      <div style={{ position: 'relative', minHeight: 420, overflow: 'hidden' }}>
        <div className="kith-sky-home" />
        <div style={{ position: 'relative', padding: '32px var(--kith-gutter)' }}>
          <div className="kith-text-agent-name" style={{ fontSize: 28 }}>Kith tokens</div>
          <div className="kith-text-secondary" style={{ color: 'var(--kith-muted-on-sky)', marginTop: 4 }}>sky-home over the ground</div>
          <div className="kith-glass" style={{ marginTop: 40, height: 'var(--kith-chat-box)', borderRadius: 'var(--kith-radius-glass-pill)', display: 'flex', alignItems: 'center', padding: '0 20px' }}>
            <span className="kith-text-body" style={{ color: 'var(--kith-muted)' }}>Message a crew member (glass pill)</span>
          </div>
          <div style={{ display: 'flex', gap: 12, marginTop: 16, alignItems: 'center' }}>
            <div className="kith-glass" style={{ width: 'var(--kith-top-button)', height: 'var(--kith-top-button)', borderRadius: 'var(--kith-radius-chip)' }} />
            <div className="kith-glass kith-text-top-bar" style={{ height: 'var(--kith-top-button)', borderRadius: 'var(--kith-radius-chip)', padding: '0 18px', display: 'flex', alignItems: 'center' }}>Glass chip</div>
            <div className="kith-bot-shadow" style={{ width: 'var(--kith-bot-avatar)', height: 'var(--kith-bot-avatar)', borderRadius: '50%', background: 'var(--kith-accent)' }} />
          </div>
        </div>
      </div>

      <div style={{ position: 'relative', height: 220, overflow: 'hidden', marginBottom: 28 }}>
        <div className="kith-sky-header" />
        <div className="kith-text-top-bar" style={{ position: 'relative', padding: '16px var(--kith-gutter)' }}>sky-header, fades out by 170px</div>
      </div>

      <div style={section}>
        <div className="kith-text-label" style={heading}>COLOURS</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 10 }}>
          {colours.map((c) => (
            <div key={c}>
              <div style={{ height: 48, borderRadius: 'var(--kith-radius-row-tool)', background: `var(--kith-${c})`, boxShadow: 'inset 0 0 0 1px var(--kith-line)' }} />
              <div className="kith-text-secondary" style={{ marginTop: 4 }}>{c}</div>
            </div>
          ))}
        </div>
      </div>

      <div style={section}>
        <div className="kith-text-label" style={heading}>TYPE RAMP</div>
        {ramp.map(([name, spec, sample]) => (
          <div key={name} style={{ padding: 'var(--kith-row-v) 0', borderBottom: '1px solid var(--kith-line)' }}>
            <div className="kith-text-secondary" style={{ color: 'var(--kith-muted)' }}>{name} · {spec}</div>
            <div className={`kith-text-${name}`}>{sample}</div>
          </div>
        ))}
      </div>

      <div style={section}>
        <div className="kith-text-label" style={heading}>RADII</div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {radii.map((r) => (
            <div key={r} style={{ width: 96, height: 64, background: 'var(--kith-panel)', borderRadius: `var(--kith-radius-${r})`, boxShadow: 'inset 0 0 0 1px var(--kith-line)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <span className="kith-text-secondary">{r}</span>
            </div>
          ))}
        </div>
        <div className="kith-text-body" style={{ marginTop: 14, padding: 12, borderRadius: 'var(--kith-radius-card)', background: 'var(--kith-attention-bg)', color: 'var(--kith-attention)' }}>Needs you: attention on attention-bg</div>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Gallery />)
