import { useEffect, useRef, useState } from 'react'

const tips = [
  'Our brownies will have everyone wondering: where is your waist??',
  'The macros fit your cut!',
  '105 kcal and 9.2g protein per brownie 💪',
  'Halal-friendly and made for your macros',
  'Freshly baked, not mass-produced — that\'s the whole point',
  'Pro tip: airfry me at 170°C for 2-3 min if I\'ve gone fudgy in the fridge',
  'Sweetened with an allulose-stevia blend — go easy if you\'re new to me 😅',
  'Crystallisation can occur after refrigeration; reheat at 170°C for 2–3 minutes',
  'New drops every Friday evening. Gone fast. Just saying 🍫💬',
]

type BuffyProps = {
  greeting?: string
}

export function Buffy({ greeting }: BuffyProps) {
  const [tipIndex, setTipIndex] = useState(0)
  const [showBubble, setShowBubble] = useState(false)
  const [left, setLeft] = useState(12)
  const [bubbleLeft, setBubbleLeft] = useState(14)
  const hideTimerRef = useRef<number | null>(null)
  const buffyRef = useRef<HTMLButtonElement>(null)
  const pageTip = greeting || document.body.dataset.buffyGreeting

  useEffect(() => {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    const isMobileViewport = () => window.innerWidth <= 820

    if (reducedMotion || isMobileViewport()) {
      const mobileLeft = 12
      setLeft(mobileLeft)
      return
    }

    const wander = () => {
      if (showBubble) return
      if (isMobileViewport()) {
        setLeft(12)
        return
      }
      const buffyWidth = Math.min(92, window.innerWidth * 0.28)
      const padding = 14
      const rightReserve = 220
      const minLeft = padding
      const maxLeft = Math.max(
        minLeft,
        window.innerWidth - buffyWidth - rightReserve,
      )
      const clamped = minLeft + Math.random() * Math.max(0, maxLeft - minLeft)
      setLeft(clamped)
    }

    const onResize = () => {
      if (isMobileViewport()) setLeft(12)
    }

    const interval = window.setInterval(wander, 7000)
    window.addEventListener('resize', onResize)
    wander()

    return () => {
      window.clearInterval(interval)
      window.removeEventListener('resize', onResize)
    }
  }, [showBubble])

  const handleClick = () => {
    setTipIndex((i) => i + 1)

    const padding = 12
    const maxBubbleWidth = Math.min(260, window.innerWidth - padding * 2)
    if (buffyRef.current) {
      const r = buffyRef.current.getBoundingClientRect()
      const desired = Math.min(r.left, window.innerWidth - maxBubbleWidth - padding)
      setBubbleLeft(Math.max(padding, desired))
    } else {
      setBubbleLeft(padding)
    }

    setShowBubble(true)
    if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current)
    hideTimerRef.current = window.setTimeout(() => setShowBubble(false), 5200)
  }

  return (
    <>
      <button
        ref={buffyRef}
        id="buffy"
        onClick={handleClick}
        style={{ left: `${left}px` }}
        aria-label="Buffy the Brownie — tap for a tip"
      >
        <img src="/buffy.png" alt="" />
      </button>
      {showBubble && (
        <div
          id="buffy-bubble"
          role="status"
          style={{ left: `${bubbleLeft}px`, display: 'block' }}
        >
          {tipIndex === 1 && pageTip
            ? pageTip
            : tips[(tipIndex - 1 - (pageTip ? 1 : 0) + tips.length) % tips.length]}
        </div>
      )}
    </>
  )
}

export function FloatingOrderCTA() {
  return (
    <a className="cta floating-cta" href="/order">
      Order Now 🍫
    </a>
  )
}

export function BrownieRain() {
  useEffect(() => {
    const prefersReduced =
      window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (prefersReduced) return

    const container = document.getElementById('rain-container')
    if (!container) return

    const imageSrc = '/BBB%20packaged%20protein%20brownie.png'
    const count = Math.min(5, Math.max(3, Math.floor(window.innerWidth / 170)))
    const drops: HTMLImageElement[] = []

    for (let i = 0; i < count; i++) {
      const s = document.createElement('img')
      s.className = 'rain-item'
      s.src = imageSrc
      s.alt = ''
      s.style.left = `${Math.round(5 + Math.random() * 80)}%`
      s.style.animationDelay = `${Math.random() * 0.5}s`
      s.style.width = `${Math.min(84, Math.max(60, Math.floor(window.innerWidth / 8)))}px`
      container.appendChild(s)
      drops.push(s)
    }

    const timeout = window.setTimeout(() => {
      drops.forEach((d) => d.remove())
    }, 2200)

    return () => window.clearTimeout(timeout)
  }, [])

  return null
}
