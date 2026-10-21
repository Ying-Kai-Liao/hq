// Routines (kit Routine.swift, RoutineScheduleDraft.swift). The host hydrates, compiles,
// validates and describes schedules; the app only keeps form values.

export interface RoutineTrigger {
  type: string
  seconds?: number | null
  at?: number | null
  expression?: string | null
  timeZone?: string | null
  source?: string | null
  event?: string | null
  filters?: Record<string, string> | null
}

export interface Routine {
  id: string
  botId: string
  name: string
  instruction: string
  triggers: RoutineTrigger[]
  enabled: boolean
  createdAt: number
  updatedAt: number
  triggerDescriptions: string[]
  nextRunAt?: number | null
  timeoutSeconds?: number | null
  lastError?: string | null
}

export interface RoutineRun {
  id: string
  routineId: string
  botId: string
  status: string
  createdAt: number
  finishedAt?: number | null
  detail?: string | null
  rootId?: string | null
}

export const isActiveRun = (run: RoutineRun) => ['pending', 'starting', 'running', 'recovering'].includes(run.status)

export interface RoutineListing {
  routines: Routine[]
  runs: RoutineRun[]
}

/** `url` is public through the Codync cloud (null while the cloud is off), `localUrl` works on the host itself. */
export interface RoutineWebhook {
  url?: string | null
  localUrl: string
  key: string
  connected: boolean
}

/** Form values only. */
export interface RoutineScheduleDraft {
  kind: string
  amount: string
  unit: number
  calendarStyle: string
  weekday: number
  selectedDays: number[]
  monthDay: number
  minuteStep: number
  hour: number
  minute: number
  at: number
  expression: string
  zone: string
  original: RoutineTrigger[]
}

export const emptyDraft = (): RoutineScheduleDraft => ({
  kind: 'cron',
  amount: '1',
  unit: 3600,
  calendarStyle: 'daily',
  weekday: 1,
  selectedDays: [],
  monthDay: 1,
  minuteStep: 15,
  hour: 9,
  minute: 0,
  at: 0,
  expression: '',
  zone: '',
  original: [],
})

export const sameDraft = (a: RoutineScheduleDraft | null, b: RoutineScheduleDraft | null) => !!a && !!b && JSON.stringify(a) === JSON.stringify(b)

export interface RoutineSchedulePreview {
  draft: RoutineScheduleDraft
  triggers: RoutineTrigger[]
  summary: string
  nextRunAt?: number | null
  warning?: string | null
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))
