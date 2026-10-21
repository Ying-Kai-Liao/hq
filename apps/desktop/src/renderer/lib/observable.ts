import { useCallback, useRef, useSyncExternalStore } from 'react'

/** A model object views follow: `changed()` re-renders every view that uses it. */
export class Observable {
  #listeners = new Set<() => void>()
  #version = 0
  #scheduled = false

  /** Coalesced to one notification per microtask, like SwiftUI's batched updates. */
  protected changed() {
    if (this.#scheduled) return
    this.#scheduled = true
    queueMicrotask(() => {
      this.#scheduled = false
      this.#version++
      for (const listener of [...this.#listeners]) listener()
    })
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => void this.#listeners.delete(listener)
  }

  getVersion = () => this.#version
}

/** Re-renders the component when `model` changes; returns it for convenience. */
export function useModel<T extends Observable | null | undefined>(model: T): T {
  useSyncExternalStore(
    model ? model.subscribe : noopSubscribe,
    model ? model.getVersion : zero,
  )
  return model
}

const noopSubscribe = () => () => {}
const zero = () => 0

/** Re-renders on a change to any of `models` (a list whose length may change). */
export function useModels(models: Observable[]) {
  const key = useRef<{ models: Observable[]; version: number }>({ models, version: 0 })
  key.current.models = models
  useSyncExternalStore(
    useCallback((cb: () => void) => {
      const offs = key.current.models.map((m) => m.subscribe(() => {
        key.current.version++
        cb()
      }))
      return () => offs.forEach((off) => off())
    }, [models.length, ...models]),
    () => key.current.version,
  )
}
