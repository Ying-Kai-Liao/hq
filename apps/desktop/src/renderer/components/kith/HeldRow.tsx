import type { HeldRowModel } from '@shared/held-run'
import { Spinner } from '../Controls'
import { Icon } from '../Icon'
import './kith.css'

/** The held row inside an answered permission card (app-style/held-run). Values and callbacks only: the card owns the confirm and the call. */
export function HeldRow({ model, onStop }: { model: HeldRowModel; onStop: () => void }) {
  return (
    <div className="kc-held" title={model.tooltip} role="group" aria-label={`${model.title}. ${model.sentence}`}>
      <span className="kc-held-icon" aria-hidden>
        <Icon name={model.icon} size={14} />
      </span>
      <span className="kc-held-text kith-text-secondary">
        <span className="kc-held-title">{model.title}</span>
        <span className={`kc-held-sentence ${model.failed ? 'failed' : ''}`} aria-live="polite">{model.sentence}</span>
      </span>
      {model.button ? (
        <button className={`kc-held-stop kith-text-secondary ${model.stopping ? 'stopping' : ''}`} disabled={model.stopping} onClick={onStop} aria-label="Stop old run" title={model.tooltip}>
          <span className="kc-held-stop-label">{model.button}</span>
          {model.stopping ? <span className="kc-held-stop-spinner"><Spinner size={12} /></span> : null}
        </button>
      ) : null}
    </div>
  )
}

/** The transcript line after a Stop: "Stopped the old terminal run · 10:02", with the kind's icon. */
export function StoppedDivider({ text, icon }: { text: string; icon: string }) {
  return (
    <div className="kc-stopped kith-text-secondary" role="status">
      <Icon name={icon} size={11} />
      <span>{text}</span>
    </div>
  )
}
