import { CALL_MODELS, callModelLabel, hqSettings, PERMISSION_MODES, permissionLabel } from '@shared/bot-sections'
import { ChoicePicker, ValueRow } from '../../../components/Controls'
import { Text } from '../../../components/Text'
import type { KithInfoStore } from '../../../store/kith-info-store'

/**
 * An hq bot's permission, model, effort and Fast mode, once. hq holds them: the permission is written through to hq and
 * shown as hq reports it, the others hq has no setting for, so they are read-only and say "Set in Kith".
 */
export function HqSettings({ kith }: { kith: KithInfoStore }) {
  const rows = hqSettings(kith.info)
  return (
    <>
      {rows.map((row) => (
        <ValueRow key={row.key} label={row.label} detail={row.hint}>
          {row.editable && row.key === 'callModel' ? (
            <ChoicePicker
              selection={row.value}
              options={CALL_MODELS.some((m) => m.id === row.value) ? CALL_MODELS : [...CALL_MODELS, { id: row.value, label: callModelLabel(row.value) }]}
              onChange={(model) => { if (!kith.callModelSaving && model !== row.value) void kith.setCallModel(model) }}
            />
          ) : row.editable ? (
            <ChoicePicker
              selection={row.value}
              options={PERMISSION_MODES.some((m) => m.id === row.value) ? PERMISSION_MODES : [...PERMISSION_MODES, { id: row.value, label: permissionLabel(row.value) }]}
              onChange={(mode) => { if (!kith.permissionSaving && mode !== row.value) void kith.setPermission(mode) }}
            />
          ) : (
            <Text tone="secondary" truncate>{row.value}</Text>
          )}
        </ValueRow>
      ))}
      {kith.callModelError ? <Text size="footnote" tone="danger" className="fade-in" role="alert">Call model not changed: {kith.callModelError}</Text> : null}
      {kith.permissionError ? <Text size="footnote" tone="danger" className="fade-in" role="alert">Permission not changed: {kith.permissionError}</Text> : null}
    </>
  )
}
