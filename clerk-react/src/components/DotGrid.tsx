import { useEffect, useRef } from 'react'

type DotGridProps = {
  dotSize?: number
  gap?: number
  baseColor?: string
  activeColor?: string
  proximity?: number
  speedTrigger?: number
  shockRadius?: number
  shockStrength?: number
  maxSpeed?: number
  resistance?: number
  returnDuration?: number
}

type Dot = {
  x: number
  y: number
  ox: number
  oy: number
  vx: number
  vy: number
  a: number
}

export default function DotGrid({
  dotSize = 16,
  gap = 32,
  baseColor = '#f7f7f7',
  activeColor = '#ffffff',
  proximity = 150,
  speedTrigger = 100,
  shockRadius = 250,
  shockStrength = 5,
  maxSpeed = 5000,
  resistance = 750,
  returnDuration = 1.5,
}: DotGridProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dots: Dot[] = []
    const pointer = { x: -9999, y: -9999, px: -9999, py: -9999, speed: 0 }

    const buildDots = () => {
      const rect = canvas.getBoundingClientRect()
      const dpr = Math.max(window.devicePixelRatio || 1, 1)
      canvas.width = Math.floor(rect.width * dpr)
      canvas.height = Math.floor(rect.height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      dots.length = 0
      for (let y = gap / 2; y < rect.height; y += gap) {
        for (let x = gap / 2; x < rect.width; x += gap) {
          dots.push({ x, y, ox: x, oy: y, vx: 0, vy: 0, a: 0 })
        }
      }
    }

    const onMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect()
      pointer.x = e.clientX - rect.left
      pointer.y = e.clientY - rect.top
    }

    const onLeave = () => {
      pointer.x = -9999
      pointer.y = -9999
      pointer.speed = 0
    }

    let raf = 0
    let last = performance.now()

    const frame = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.033)
      last = now

      const dx = pointer.x - pointer.px
      const dy = pointer.y - pointer.py
      const speed = Math.sqrt(dx * dx + dy * dy) / Math.max(dt, 0.001)
      pointer.speed = Math.min(speed, maxSpeed)
      pointer.px = pointer.x
      pointer.py = pointer.y

      const returnEase = Math.max(returnDuration, 0.05)
      const k = resistance

      ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight)

      for (const d of dots) {
        const toOriginX = d.ox - d.x
        const toOriginY = d.oy - d.y
        d.vx += (toOriginX / returnEase) * dt
        d.vy += (toOriginY / returnEase) * dt

        const pdx = d.x - pointer.x
        const pdy = d.y - pointer.y
        const dist = Math.sqrt(pdx * pdx + pdy * pdy)

        if (dist < shockRadius && pointer.speed > speedTrigger) {
          const influence = (1 - dist / shockRadius) * shockStrength
          const n = Math.max(dist, 0.001)
          d.vx += (pdx / n) * influence * dt * (pointer.speed / speedTrigger)
          d.vy += (pdy / n) * influence * dt * (pointer.speed / speedTrigger)
        }

        const clamp = Math.min(1, proximity / Math.max(dist, 1))
        d.a = Math.max(0, Math.min(1, clamp))

        d.vx *= Math.exp(-k * dt / 1000)
        d.vy *= Math.exp(-k * dt / 1000)

        d.x += d.vx
        d.y += d.vy

        ctx.beginPath()
        ctx.arc(d.x, d.y, Math.max(1, dotSize / 8), 0, Math.PI * 2)
        ctx.fillStyle = blend(baseColor, activeColor, d.a)
        ctx.fill()
      }

      raf = requestAnimationFrame(frame)
    }

    buildDots()
    raf = requestAnimationFrame(frame)

    const ro = new ResizeObserver(buildDots)
    ro.observe(canvas)
    window.addEventListener('mousemove', onMove)
    canvas.addEventListener('mouseleave', onLeave)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      window.removeEventListener('mousemove', onMove)
      canvas.removeEventListener('mouseleave', onLeave)
    }
  }, [
    activeColor,
    baseColor,
    dotSize,
    gap,
    maxSpeed,
    proximity,
    resistance,
    returnDuration,
    shockRadius,
    shockStrength,
    speedTrigger,
  ])

  return <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
}

function blend(c1: string, c2: string, t: number) {
  const a = hexToRgb(c1)
  const b = hexToRgb(c2)
  if (!a || !b) return c2
  const r = Math.round(a.r + (b.r - a.r) * t)
  const g = Math.round(a.g + (b.g - a.g) * t)
  const bl = Math.round(a.b + (b.b - a.b) * t)
  return `rgb(${r}, ${g}, ${bl})`
}

function hexToRgb(hex: string) {
  const clean = hex.replace('#', '')
  const full = clean.length === 3 ? clean.split('').map((x) => x + x).join('') : clean
  if (full.length !== 6) return null
  const num = Number.parseInt(full, 16)
  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255,
  }
}
