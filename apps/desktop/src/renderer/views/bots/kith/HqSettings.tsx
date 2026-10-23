import { hqSettings, PERMISSION_MODES, permissionLabel } from '@shared/bot-sections'
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
          {row.editable ? (
            <ChoicePicker
              selection={row.value}
              options={PERMISSION_MODES.some((m) => m.id === row.value) ? PERMISSION_MODES : [...PERMISSION_MODES, { id: row.value, label: permissionLabel(row.value), detail: '' }]}
              onChange={(mode) => { if (!kith.permissionSaving && mode !== row.value) void kith.setPermission(mode) }}
            />
          ) : (
            <Text tone="secondary" truncate>{row.value}</Text>
          )}
        </ValueRow>
      ))}
      {kith.permissionError ? <Text size="footnote" tone="danger" className="fade-in" role="alert">Permission not changed: {kith.permissionError}</Text> : null}
    </>
  )
}
