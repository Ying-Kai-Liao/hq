import { OPERATOR_TOOLS, type CallOperator } from './call-operator'
import { errorMessage, microphone, VoiceEngine } from './voice'

/**
 * OpenAI Realtime over WebRTC, this computer ↔ OpenAI directly: the microphone is a WebRTC audio
 * track, the model's voice plays from the remote track, and events (tools, replies) go over
 * `oai-events`. The user's key stays with the host, which mints the client secret; the host
 * never sees audio.
 */
export class OpenAIRealtimeEngine extends VoiceEngine {
  readonly provider = 'openai' as const
  private pc: RTCPeerConnection | null = null
  private events: RTCDataChannel | null = null
  private stream: MediaStream | null = null
  private audio: HTMLAudioElement | null = null
  /** A response is being generated; new replies wait for it to finish. */
  private responding = false
  private pending: string[] = []
  private dropTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private credential: () => Promise<string>,
    private op: CallOperator,
  ) {
    super()
  }

  async start() {
    try {
      this.stream = await microphone()
      if (this.ended) return this.release()
      const secret = await this.credential()
      if (this.ended) return
      await this.connect(secret)
    } catch (e) {
      if (!this.ended) this.fail(errorMessage(e))
    }
  }

  private async connect(secret: string) {
    const pc = new RTCPeerConnection({ bundlePolicy: 'max-bundle' })
    this.pc = pc
    const track = this.stream!.getAudioTracks()[0]
    if (!track) throw new Error("Couldn't start the call audio.")
    track.enabled = !this.muted
    pc.addTrack(track, this.stream!)
    const audio = new Audio()
    audio.autoplay = true
    this.audio = audio
    pc.ontrack = (e) => {
      audio.srcObject = e.streams[0] ?? new MediaStream([e.track])
    }
    pc.oniceconnectionstatechange = () => this.iceChanged(pc.iceConnectionState)
    const events = pc.createDataChannel('oai-events')
    events.onopen = () => this.opened()
    events.onmessage = (e) => typeof e.data === 'string' && this.received(e.data)
    this.events = events

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    const response = await fetch('https://api.openai.com/v1/realtime/calls', {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/sdp' },
      body: offer.sdp,
      signal: AbortSignal.timeout(15_000),
    })
    const body = await response.text()
    if (this.ended) return
    if (!response.ok) {
      let message: string | undefined
      try {
        message = (JSON.parse(body) as { error?: { message?: string } }).error?.message
      } catch {}
      throw new Error(message ?? `OpenAI answered ${response.status}.`)
    }
    await pc.setRemoteDescription({ type: 'answer', sdp: body })
    this.dropTimer = setTimeout(() => {
      if (!this.ended && this.phase === 'starting') this.fail("Couldn't reach OpenAI.")
    }, 15_000)
  }

  private release() {
    for (const t of this.stream?.getTracks() ?? []) t.stop()
    this.stream = null
  }

  end() {
    this.ended = true
    this.onActivityChanged?.(false)
    if (this.dropTimer) clearTimeout(this.dropTimer)
    this.events?.close()
    this.pc?.close()
    this.events = null
    this.pc = null
    this.release()
    if (this.audio) {
      this.audio.srcObject = null
      this.audio = null
    }
  }

  protected mutedChanged(on: boolean) {
    for (const t of this.stream?.getAudioTracks() ?? []) t.enabled = !on
    if (on) this.level = 0
  }

  interrupt() {
    if (this.phase !== 'speaking') return
    this.send({ type: 'response.cancel' })
    this.send({ type: 'output_audio_buffer.clear' })
    this.setPhase('listening')
  }

  speak(reply: string) {
    if (this.ended || this.phase === 'failed') return
    this.pending.push(this.op.reply(reply))
    this.flush()
  }

  announce(notice: string) {
    if (this.ended || this.phase === 'failed') return
    this.pending.push(this.op.notice(notice))
    this.flush()
  }

  // MARK: events

  private opened() {
    if (this.ended) return
    if (this.dropTimer) clearTimeout(this.dropTimer)
    this.send({
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions: this.op.instructions,
        tools: OPERATOR_TOOLS.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters })),
        audio: { input: { turn_detection: { type: 'semantic_vad' } } },
      },
    })
    this.setPhase('listening')
    this.flush()
  }

  private received(data: string) {
    if (this.ended) return
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(data) as Record<string, unknown>
    } catch {
      return
    }
    switch (msg.type) {
      case 'input_audio_buffer.speech_started':
        this.level = this.muted ? 0 : 0.7
        break
      case 'input_audio_buffer.speech_stopped':
        this.level = 0
        break
      case 'output_audio_buffer.started':
        this.setPhase('speaking')
        break
      case 'output_audio_buffer.stopped':
      case 'output_audio_buffer.cleared':
        if (this.phase === 'speaking') this.setPhase('listening')
        break
      case 'response.created':
        this.responding = true
        break
      case 'response.done':
        this.responding = false
        this.flush()
        break
      case 'response.function_call_arguments.done': {
        if (typeof msg.call_id !== 'string' || typeof msg.name !== 'string') return
        let args: Record<string, unknown> = {}
        try {
          if (typeof msg.arguments === 'string') args = JSON.parse(msg.arguments) as Record<string, unknown>
        } catch {}
        const output = this.op.call(msg.name, args)
        this.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: msg.call_id, output } })
        // An empty entry asks for a response once this one is done, so the model speaks the result.
        this.pending.push('')
        break
      }
      case 'error':
        console.error('realtime:', (msg.error as { message?: string } | undefined)?.message ?? '?')
        break
    }
  }

  private iceChanged(state: RTCIceConnectionState) {
    if (this.ended) return
    switch (state) {
      case 'connected':
      case 'completed':
        if (this.dropTimer) clearTimeout(this.dropTimer)
        break
      case 'disconnected':
        if (this.dropTimer) clearTimeout(this.dropTimer)
        this.dropTimer = setTimeout(() => !this.ended && this.fail('Lost the connection to OpenAI.'), 5000)
        break
      case 'failed':
        this.fail('Lost the connection to OpenAI.')
        break
    }
  }

  /** Hands waiting replies (and tool results, as empty entries) to the model once it's free. */
  private flush() {
    if (this.responding || !this.isActive || this.events?.readyState !== 'open' || !this.pending.length) return
    for (const text of this.pending) {
      if (text) this.send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })
    }
    this.pending = []
    this.responding = true
    this.send({ type: 'response.create' })
  }

  private send(event: unknown) {
    if (this.events?.readyState === 'open') this.events.send(JSON.stringify(event))
  }
}
