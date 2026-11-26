'use client'
// PURPOSE: Decorative "On Duty" background: an ASCII light funnel (horn-shaped lines, tapered beam, character ribbons) on canvas.
import { useEffect, useRef } from 'react'

// Tuned from the supplied "Funnel" preset (recoloured to the app palette below; speed 3, scramble .08, burst ~6s).
// Motion is deliberately aperiodic: drifting row speeds, random comets and flares, incommensurate waves.
// ponytail: calibration knobs; adjust here rather than adding props until a second use appears.
const GLYPHS = 'ABCDEFGHJKMNPRSXZ0123456789'
const LINES = 30, POWER = 2.2, SPEED = 0.07, SCRAMBLE = 0.08, FPS = 30, SEGMENTS = 22
const ORIGIN = 0.22 // where the funnel leaves the beam, as a fraction of card width
const RIBBONS = [
  { off: -0.68, rows: [-3.5, 3.5], beam: false },
  { off: 0, rows: [-8, 8], beam: true },
  { off: 0.68, rows: [-3.5, 3.5], beam: false },
]
const PER_ROW = 26
const MAX_COMETS = 5

// App palette (styles.css): orange #ff6330, orange-light #ff8c52, peach #fcd6c7. Swap these to retheme the whole effect.
type Rgb = readonly [number, number, number]
const PALETTE = {
  base: [255, 99, 48] as Rgb,    // lines, haze
  hot: [255, 140, 82] as Rgb,    // line tips, glare edge
  warm: [255, 190, 140] as Rgb,  // beam thread
  peach: [252, 214, 199] as Rgb, // beam core, glare
  white: [255, 245, 238] as Rgb, // comet heads, beam tip
  char: '#ff8c52', charHot: '#fff1ea',
}
const rgba = ([r, g, b]: Rgb, a: number) => `rgba(${r},${g},${b},${a})`

const rand = (seed: number) => { const x = Math.sin(seed * 12.9898) * 43758.5453; return x - Math.floor(x) }
const between = (a: number, b: number) => a + Math.random() * (b - a)

export function DutyStreams() {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    let w = 0, h = 0, raf = 0, last = 0, prev = 0

    // Film grain: one small noise tile, tiled as a pattern.
    const tile = document.createElement('canvas'); tile.width = tile.height = 96
    const tctx = tile.getContext('2d')!
    const noise = tctx.createImageData(96, 96)
    for (let i = 0; i < noise.data.length; i += 4) { const v = Math.random() * 255; noise.data[i] = noise.data[i + 1] = noise.data[i + 2] = v; noise.data[i + 3] = 255 }
    tctx.putImageData(noise, 0, 0)
    const grain = ctx.createPattern(tile, 'repeat')

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      w = canvas.clientWidth; h = canvas.clientHeight
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    // Lines keep a fixed look but each sways at its own slow, unrelated rate.
    const lines = Array.from({ length: LINES }, (_, i) => {
      const u = (i / (LINES - 1)) * 2 - 1
      return { off: Math.sign(u) * Math.abs(u) ** 1.15 * 1.35, bright: 0.35 + 0.65 * rand(i + 1), width: 0.5 + rand(i + 50),
        sway: 0.15 + 0.45 * rand(i + 90), phase: rand(i + 130) * Math.PI * 2 }
    })
    // Each ribbon row flows at its own speed, which itself wanders; letters keep their spacing so they never pile up.
    const rows = RIBBONS.flatMap((ribbon, r) => ribbon.rows.map((px, j) => ({
      ribbon, px, phase: Math.random(), speedSeed: r * 7 + j * 3 + 1,
      glyphs: Array.from({ length: PER_ROW }, () => GLYPHS[Math.floor(Math.random() * GLYPHS.length)]!),
    })))
    // Comets: short bright streaks sent along random lines at random moments.
    type Comet = { line: number, u: number, speed: number, length: number }
    const comets: Comet[] = []
    let nextComet = 0, burstAt = -10, nextBurst = between(3, 6)

    const ox = () => w * ORIGIN
    const span = () => w * 1.02 - ox()
    const yAt = (off: number, u: number) => h / 2 + off * h * 0.55 * u ** POWER
    const slope = (off: number, u: number) => (off * h * 0.55 * POWER * u ** (POWER - 1)) / span()
    const lineOff = (i: number, time: number) => { const l = lines[i]!; return l.off * (1 + 0.035 * Math.sin(time * l.sway + l.phase)) }
    const path = (off: number, from: number, to: number) => {
      ctx.beginPath()
      for (let s = 0; s <= SEGMENTS; s++) { const u = from + (to - from) * (s / SEGMENTS); const x = ox() + span() * u, y = yAt(off, u); s ? ctx.lineTo(x, y) : ctx.moveTo(x, y) }
    }

    const step = (time: number, dt: number) => {
      for (const row of rows) {
        // Two unrelated slow waves per row, so the speed never settles into a loop.
        const drift = 1 + 0.35 * Math.sin(time * 0.23 + row.speedSeed) + 0.2 * Math.sin(time * 0.61 + row.speedSeed * 1.7)
        row.phase = (row.phase + dt * SPEED * drift) % 1
        for (let i = 0; i < PER_ROW * SCRAMBLE * 0.2; i++) row.glyphs[Math.floor(Math.random() * PER_ROW)] = GLYPHS[Math.floor(Math.random() * GLYPHS.length)]!
      }
      if (time >= nextComet && comets.length < MAX_COMETS) {
        comets.push({ line: Math.floor(Math.random() * LINES), u: 0, speed: between(0.55, 1.3), length: between(0.08, 0.18) })
        nextComet = time + between(0.15, 0.9)
      }
      for (const c of comets) c.u += dt * c.speed
      for (let i = comets.length - 1; i >= 0; i--) if (comets[i]!.u - comets[i]!.length > 1) comets.splice(i, 1)
      if (time >= nextBurst) { burstAt = time; nextBurst = time + between(4, 9) }
    }

    const draw = (time: number) => {
      const ignite = Math.exp(-(time - burstAt) * 2.5)
      const pulse = (0.85 + 0.09 * Math.sin(time * 1.3) + 0.06 * Math.sin(time * 3.7 + 1)) * (1 + 0.5 * ignite)
      const cy = h / 2
      ctx.globalCompositeOperation = 'source-over'
      ctx.globalAlpha = 1
      ctx.clearRect(0, 0, w, h)
      ctx.globalCompositeOperation = 'lighter'

      // Green haze filling the right half.
      const haze = ctx.createRadialGradient(w, cy, 0, w, cy, w * 0.8)
      haze.addColorStop(0, rgba(PALETTE.hot, .32)); haze.addColorStop(0.45, rgba(PALETTE.base, .1)); haze.addColorStop(1, rgba(PALETTE.base, 0))
      ctx.fillStyle = haze; ctx.globalAlpha = Math.min(1, pulse); ctx.fillRect(0, 0, w, h)

      // Funnel lines: soft glow pass, then a core whose thickness and brightness vary per line.
      const fade = ctx.createLinearGradient(ox(), 0, w, 0)
      fade.addColorStop(0, rgba(PALETTE.base, 0)); fade.addColorStop(0.3, rgba(PALETTE.base, .55)); fade.addColorStop(1, rgba(PALETTE.hot, 1))
      ctx.strokeStyle = fade
      lines.forEach((line, i) => {
        path(lineOff(i, time), 0, 1)
        ctx.globalAlpha = 0.09 * line.bright * (1 + ignite); ctx.lineWidth = 5; ctx.stroke()
        ctx.globalAlpha = Math.min(1, 0.85 * line.bright * (1 + 0.4 * ignite)); ctx.lineWidth = line.width; ctx.stroke()
      })

      // Comets: a bright head with a fading tail, riding their line outward.
      for (const c of comets) {
        const head = Math.min(1, c.u), tail = Math.max(0, c.u - c.length)
        if (head <= tail) continue
        const off = lineOff(c.line, time)
        const x0 = ox() + span() * tail, x1 = ox() + span() * head
        const streak = ctx.createLinearGradient(x0, 0, x1, 0)
        streak.addColorStop(0, rgba(PALETTE.hot, 0)); streak.addColorStop(1, rgba(PALETTE.white, 1))
        ctx.strokeStyle = streak
        path(off, tail, head)
        ctx.globalAlpha = 0.35 * Math.min(1, head * 3); ctx.lineWidth = 4; ctx.stroke()
        ctx.globalAlpha = 0.95 * Math.min(1, head * 3); ctx.lineWidth = 1.4; ctx.stroke()
      }

      // Beam: a thin warm thread on the left widening into a white-cyan core on the right.
      const beam = ctx.createLinearGradient(0, 0, w, 0)
      beam.addColorStop(0, rgba(PALETTE.warm, .55)); beam.addColorStop(0.55, rgba(PALETTE.warm, .9)); beam.addColorStop(0.85, rgba(PALETTE.peach, 1)); beam.addColorStop(1, rgba(PALETTE.white, 1))
      ctx.fillStyle = beam
      for (const [half, alpha] of [[9, 0.12], [4, 0.35], [1.6, 0.95]] as const) {
        ctx.globalAlpha = Math.min(1, alpha * pulse)
        ctx.beginPath(); ctx.moveTo(0, cy - half * 0.25); ctx.lineTo(w, cy - half); ctx.lineTo(w, cy + half); ctx.lineTo(0, cy + half * 0.25); ctx.closePath(); ctx.fill()
      }
      // Elliptical glare where the beam meets the right edge.
      ctx.save(); ctx.translate(w, cy); ctx.scale(1, 0.32)
      const glare = ctx.createRadialGradient(0, 0, 0, 0, 0, w * 0.5)
      glare.addColorStop(0, rgba(PALETTE.white, .95)); glare.addColorStop(0.25, rgba(PALETTE.peach, .5)); glare.addColorStop(0.6, rgba(PALETTE.hot, .12)); glare.addColorStop(1, rgba(PALETTE.hot, 0))
      ctx.fillStyle = glare; ctx.globalAlpha = Math.min(1, 0.8 * pulse); ctx.fillRect(-w * 0.5, -w * 0.5, w, w)
      ctx.restore()

      // Character ribbons: tight strings riding a line, rotated to its curve, small and dim near the origin.
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      for (const row of rows) {
        const { ribbon } = row
        for (let k = 0; k < PER_ROW; k++) {
          const u = (k / PER_ROW + row.phase) % 1
          if (u < 0.12) continue
          const x = ox() + span() * u
          const y = yAt(ribbon.off, u) + row.px * (0.35 + 0.65 * u)
          const eased = Math.min(1, (u - 0.12) / 0.35)
          ctx.globalAlpha = Math.min(0.9, eased * 0.7 * (1 + 0.4 * ignite))
          ctx.fillStyle = ribbon.beam && u > 0.65 ? PALETTE.charHot : PALETTE.char
          ctx.font = `700 ${(3.5 + 4.5 * u).toFixed(1)}px ui-monospace, SFMono-Regular, Consolas, monospace`
          ctx.save(); ctx.translate(x, y); ctx.rotate(Math.atan(slope(ribbon.off, u))); ctx.fillText(row.glyphs[k]!, 0, 0); ctx.restore()
        }
      }

      // Light film grain over everything.
      if (grain) { ctx.globalCompositeOperation = 'overlay'; ctx.globalAlpha = 0.08; ctx.fillStyle = grain; ctx.fillRect(0, 0, w, h) }
      ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1
    }

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop)
      if (now - last < 1000 / FPS) return
      // Clamp the step so a backgrounded tab does not jump everything forward on return.
      const dt = Math.min(0.1, prev ? (now - prev) / 1000 : 0)
      last = prev = now
      step(now / 1000, dt)
      draw(now / 1000)
    }
    resize()
    const observer = new ResizeObserver(() => { resize(); draw(performance.now() / 1000) })
    observer.observe(canvas)
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) draw(2.5) // one still frame
    else raf = requestAnimationFrame(loop)
    return () => { cancelAnimationFrame(raf); observer.disconnect() }
  }, [])
  return <canvas ref={ref} className="duty-canvas" aria-hidden="true" />
}
