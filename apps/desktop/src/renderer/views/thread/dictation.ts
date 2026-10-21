import { useCallback, useEffect, useRef, useState } from 'react'
import { VoiceSettings } from '../call/voice'

/** The running dictation's stop: one recognizer at a time, and a call stops dictation first. */
let stopActive: (() => void) | null = null

export function stopDictation() {
  stopActive?.()
}

/** `said` after what's already in the box, with one space between. */
export function joinDictated(before: string, said: string) {
  if (!before.trim()) return said
  if (!said) return before
  return /\s$/.test(before) ? before + said : `${before} ${said}`
}

/**
 * Dictation into the composer with on-device speech (the speech helper; macOS). Words appear in
 * the box as they're recognized, after what was already typed; the mic again, or the recognizer
 * ending on a pause, stops it.
 */
export function useDictation(draft: string, setDraft: (text: string) => void) {
  const [listening, setListening] = useState(false)
  /** The box up to the words still being recognized. */
  const before = useRef('')
  const off = useRef<(() => void) | null>(null)
  const write = useRef(setDraft)
  write.current = setDraft

  const finish = useCallback(() => {
    off.current?.()
    off.current = null
    window.codync.speech.stop()
    setListening(false)
    if (stopActive === finish) stopActive = null
  }, [])

  const start = () => {
    stopActive?.()
    before.current = draft
    off.current = window.codync.speech.onEvent((e) => {
      if (e.type === 'partial' || e.type === 'final') write.current(joinDictated(before.current, e.text))
      if (e.type === 'final') before.current = joinDictated(before.current, e.text)
      if (e.type === 'stopped' || e.type === 'error') finish()
    })
    window.codync.speech.start(VoiceSettings.language() || null)
    stopActive = finish
    setListening(true)
  }

  // A composer that goes away (another chat) stops listening.
  useEffect(() => () => { if (off.current) finish() }, [finish])

  return { available: window.codync.speech.available, listening, toggle: () => (listening ? finish() : start()) }
}
