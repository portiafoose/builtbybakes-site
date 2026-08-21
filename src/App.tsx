import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import {
  Link,
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useSearchParams,
  type NavigateOptions,
} from 'react-router-dom'
import {
  BBB,
  bbbGrossUp,
  bbbOrdersOpen,
  validEmail,
  validSGPhone,
  type ReviewItem,
} from './lib/bbbConfig'
import {
  stripeConfigured,
  stripeCreateCheckoutSession,
  stripeRetrieveCheckoutSession,
} from './lib/stripe'
import {
  bbbWeekContaining,
  downloadOrdersExcel,
  ordersInRange,
  type OrderExportRange,
} from './lib/excel'

import { Buffy } from './components/Buffy'
import {
  contactEndpointConfigured,
  sendContactForm,
  type ContactFormPayload,
} from './lib/contact'
import {
  ADMIN_SESSION_KEY,
  adminDeleteOrdersBefore,
  adminGateway,
  adminResetSoldForNewWeek,
  adminSaveBanner,
  adminUpdateMaxBrownies,
  clearAdminSession,
  getActiveBanner,
  getActiveWeeklyLimit,
  getAdminSession,
  listActivePromos,
  paidConfirmInsertOrder,
  setAdminSession as saveAdminSession,
  verifyAdminLogin,
  type OrderRow,
  type PromoCodeRow,
  type PromoDef,
  type SalesBannerRow,
  type WeeklyLimitsRow,
} from './lib/supabase'
import './App.css'

const navItems = [
  { to: '/product', label: 'Our Brownies' },
  { to: '/about', label: 'About BBB' },
  { to: '/order', label: 'Order Now' },
]

const SALES_BANNER_KEY_PREFIX = 'bbb.banner-dismissed.v2'
const SALES_BANNER_FALLBACK_TEXT =
  '🎉 OPENING SALE: 10% OFF all brownies! 🎉  Use code BAKEDBYGAINS10 when you order — mention it in notes or on WhatsApp to redeem. Limited time only!     '

/**
 * Lightweight deterministic hash for turning a banner message string into a
 * stable localStorage key suffix. NOT cryptographic — used only so two
 * different campaign messages get two separate dismissal flags. If the admin
 * edits the banner at all (even 1 char) this hash changes → the banner
 * re-appears for all users. Same exact message re-saved = same hash → users
 * who dismissed it previously are not re-bothered.
 */
function bannerMessageHash(message: string): string {
  const s = message.trim() || 'fallback-default-banner'
  let h1 = 0xdeadbeef ^ s.length
  let h2 = 0x41c6ce57 ^ s.length
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761) >>> 0
    h2 = Math.imul(h2 ^ ch, 1597334677) >>> 0
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) >>> 0
  h2 = Math.imul(h2 ^ (h2 >>> 13), 3266489909) >>> 0
  const top = (h2 & 0x001fffff).toString(16)
  const bot = h1.toString(16)
  return (top + bot).padStart(14, '0')
}

function getDismissalStorageKey(message: string | null): string {
  return SALES_BANNER_KEY_PREFIX + '.' + bannerMessageHash(message ?? SALES_BANNER_FALLBACK_TEXT)
}

function SalesBanner() {
  const [visible, setVisible] = useState(false)
  const [bannerText, setBannerText] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    void (async () => {
      const live = await getActiveBanner()
      if (cancelled) return

      let msg: string
      if (live.kind === 'show') {
        msg = live.message
      } else if (live.kind === 'hidden') {
        // Admin explicitly set Active=Off or schedule is outside window.
        // NEVER fall back to default text — hide banner entirely, clear
        // any old banner state so we don't accidentally show stale data.
        setBannerText(null)
        setVisible(false)
        return
      } else {
        // kind === 'error' — transient SQL/network issue. Fall back to the
        // hardcoded opening-sale copy so the shop still has a banner on
        // transient infra blips.
        msg = SALES_BANNER_FALLBACK_TEXT
      }

      // Per-message dismissal, SESSION-ONLY (sessionStorage, NOT localStorage).
      // Behaviour:
      //   · User clicks × → banner hidden for the REMAINDER of THIS tab session
      //   · User reloads the page / opens new tab / comes back tomorrow →
      //     sessionStorage is cleared / not shared → banner reappears
      //   · Admin edits the banner even 1 char → new per-message key → banner
      //     comes back immediately within the same session too
      let dismissed = false
      const storageKey = getDismissalStorageKey(msg)
      try {
        dismissed = sessionStorage.getItem(storageKey) === '1'
      } catch {
        /* storage unavailable — treat as not dismissed */
      }

      setBannerText(msg)
      if (!dismissed) {
        setVisible(true)
      } else {
        // User already dismissed THIS exact banner message. Hide it but
        // still set bannerText so React can reconcile the DOM without flash.
        setVisible(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  const dismiss = () => {
    const storageKey = getDismissalStorageKey(bannerText)
    try {
      // Session-only: reload / new tab = banner shows again automatically.
      sessionStorage.setItem(storageKey, '1')
    } catch {
      /* ignore */
    }
    setVisible(false)
  }

  if (!visible || !bannerText) return null

  // Always repeat the message 16 times inside the marquee. Seamless CSS keyframe
  // slides track -100%/16 so the 17th copy (which is copy 1, repeated) starts
  // exactly where copy 1 was → no jump, no visible seam. A 16-wide repeat
  // guarantees NO EMPTY GAPS even if the banner copy is just 1 word on a 4K
  // 3840-px-wide screen. a11y: only first span is read by screen readers.
  const spans = Array.from({ length: 16 }, (_, i) => (
    <span
      key={i}
      className="sales-banner__text"
      aria-hidden={i === 0 ? undefined : true}
    >
      {bannerText}
    </span>
  ))

  return (
    <div className="sales-banner" role="region" aria-label="Sales promotion">
      <div className="sales-banner__track" aria-hidden="false">
        {spans}
      </div>
      <button
        type="button"
        className="sales-banner__close"
        aria-label="Dismiss sales banner"
        onClick={dismiss}
      >
        ×
      </button>
    </div>
  )
}

function FloatingOrderCTA() {
  const location = useLocation()
  const onOrderPage = location.pathname === '/order'
  if (onOrderPage) return null
  return (
    <Link className="button button--primary floating-order-cta" to="/order">
      Order Now 🍫
    </Link>
  )
}

type BannerLiveStatusBoxProps = {
  message: string
  active: boolean
  start: string
  end: string
}

/**
 * Mirrors the EXACT same date/active math the storefront uses inside
 * getActiveBanner() so the admin sees, BEFORE leaving the banner tab,
 * whether their current draft will render on the storefront RIGHT NOW
 * if they click Save → refresh. No need to flip tabs to test.
 */
function BannerLiveStatusBox(props: BannerLiveStatusBoxProps): ReactElement {
  const { message, active, start, end } = props
  const status = useMemo(() => {
    const startIso = start ? new Date(start).toISOString() : null
    const endIso = end ? new Date(end).toISOString() : null
    const startMs = startIso ? new Date(startIso).getTime() : -Infinity
    const endMs = endIso ? new Date(endIso).getTime() : Infinity
    const now = Date.now()
    if (startIso && endIso && startMs > endMs) {
      return {
        level: 'bad',
        title: '⚠ Invalid schedule',
        body: 'End date must be AFTER start date. This banner will stay hidden.',
      } as const
    }
    if (!message.trim()) {
      return {
        level: 'warn',
        title: 'Message is empty',
        body: 'Add a message above, save, and the storefront will show it once active + in window.',
      } as const
    }
    if (!active) {
      return {
        level: 'warn',
        title: '🔕 OFF — banner hidden',
        body: 'Active toggle is OFF. Toggle it ON (pill to right) to display, regardless of the schedule.',
      } as const
    }
    if (startIso && startMs > now) {
      const diffMin = Math.round((startMs - now) / 60000)
      return {
        level: 'warn',
        title: '⏳ SCHEDULED — not live yet',
        body: `Banner will go live on ${new Date(startIso).toLocaleString()} (${diffMin >= 60
          ? `in ~${Math.round(diffMin / 60)} h`
          : `in ${diffMin} min`}). Until then the storefront shows nothing.`,
      } as const
    }
    if (endIso && endMs < now) {
      const diffMin = Math.round((now - endMs) / 60000)
      return {
        level: 'warn',
        title: '⌛ EXPIRED — already hidden',
        body: `Banner was live until ${new Date(endIso).toLocaleString()} (${diffMin >= 60
          ? `~${Math.round(diffMin / 60)} h ago`
          : `${diffMin} min ago`}). Either extend the End date or clear it to make it run indefinitely.`,
      } as const
    }
    return {
      level: 'good',
      title: '✅ LIVE NOW — banner would show',
      body: startIso || endIso
        ? `Active + inside the schedule window right now. Schedule: ${
            startIso ? new Date(startIso).toLocaleString() : 'immediately'
          } → ${endIso ? new Date(endIso).toLocaleString() : 'indefinitely'}.`
        : 'Active and no schedule set — shown continuously until the toggle is flipped OFF.',
    } as const
  }, [message, active, start, end])

  const bg =
    status.level === 'good'
      ? '#eefaf0'
      : status.level === 'warn'
        ? '#fff8e1'
        : '#fbeae4'
  const border =
    status.level === 'good'
      ? '1px solid #b7dfc1'
      : status.level === 'warn'
        ? '1px solid #e6d388'
        : '1px solid #efb7a6'
  const accent =
    status.level === 'good'
      ? '#1f6a36'
      : status.level === 'warn'
        ? '#7b5a10'
        : '#a9361f'

  return (
    <div
      style={{
        gridColumn: '1 / -1',
        padding: '14px 16px',
        borderRadius: 12,
        background: bg,
        border,
        display: 'flex',
        gap: 14,
        alignItems: 'flex-start',
        flexWrap: 'wrap',
      }}
    >
      <div style={{ flex: '0 0 auto', fontWeight: 800, color: accent, fontSize: 14 }}>
        {status.title}
      </div>
      <p className="body" style={{ flex: '1 1 320px', margin: 0, color: accent }}>
        {status.body}
      </p>
    </div>
  )
}

function SiteHeader() {
  const [drawerOpen, setDrawerOpen] = useState(false)
  const closeDrawer = () => setDrawerOpen(false)
  const location = useLocation()

  useEffect(() => {
    closeDrawer()
  }, [location.pathname])

  useEffect(() => {
    document.body.style.overflow = drawerOpen ? 'hidden' : ''
    return () => {
      document.body.style.overflow = ''
    }
  }, [drawerOpen])

  return (
    <>
      <header className="site-header-nav">
        <div className="site-header-inner">
          <Link className="brand-link" to="/product" onClick={closeDrawer}>
            <img
              src="/logo-wordmark.png"
              alt="Built By Bakes"
              className="brand-img"
            />
            <span className="brand-copy">
              <strong>Built By Bakes</strong>
              <span>Protein brownies built for your gains</span>
            </span>
          </Link>

          <button
            type="button"
            className="drawer-toggle"
            aria-expanded={drawerOpen}
            aria-controls="site-navigation"
            aria-label="Open navigation"
            onClick={() => setDrawerOpen(true)}
          >
            <span className="drawer-bars" aria-hidden="true">
              <i></i>
              <i></i>
              <i></i>
            </span>
            <span className="drawer-toggle-label">Menu</span>
          </button>

          <nav id="site-navigation" className="site-nav desktop-nav" aria-label="Primary">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  isActive ? 'nav-link nav-link--active' : 'nav-link'
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>

      <div
        className={`drawer-backdrop ${drawerOpen ? 'drawer-backdrop--open' : ''}`}
        onClick={closeDrawer}
        aria-hidden="true"
      />
      <aside
        className={`nav-drawer ${drawerOpen ? 'nav-drawer--open' : ''}`}
        id="site-navigation-drawer"
        aria-hidden={!drawerOpen}
        aria-label="Primary navigation (mobile)"
      >
        <div className="drawer-head">
          <Link className="brand-link brand-link--drawer" to="/product" onClick={closeDrawer}>
            <img
              src="/logo-wordmark.png"
              alt="Built By Bakes"
              className="brand-img"
            />
            <span className="brand-copy">
              <strong>Built By Bakes</strong>
              <span>Protein brownies built for your gains</span>
            </span>
          </Link>
          <button
            type="button"
            className="drawer-close"
            aria-label="Close navigation"
            onClick={closeDrawer}
          >
            ×
          </button>
        </div>
        <nav className="drawer-links">
          {navItems.map((item, i) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                isActive ? 'drawer-link drawer-link--active' : 'drawer-link'
              }
              onClick={closeDrawer}
            >
              <span className="drawer-link-index">
                0{i + 1}
              </span>
              <span className="drawer-link-label">{item.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="drawer-foot">
          <Link
            to="/order"
            className="button button--primary button--large"
            onClick={closeDrawer}
          >
            Order Now 🍫
          </Link>
          <div className="drawer-contact">
            <a href={`https://wa.me/${BBB.WHATSAPP}`} target="_blank" rel="noopener noreferrer">
              WhatsApp +65 9740 1751
            </a>
            <a href={`mailto:${BBB.CORP_EMAIL}`}>builtbybakes.sg@gmail.com</a>
          </div>
        </div>
      </aside>
    </>
  )
}

function MacroBig() {
  return (
    <div className="macro-big">
      <div>
        <b>105</b>
        <span>kcal</span>
      </div>
      <div>
        <b>9.2g</b>
        <span>protein</span>
      </div>
      <div>
        <b>9g</b>
        <span>carbs</span>
      </div>
      <div>
        <b>4.6g</b>
        <span>fat</span>
      </div>
    </div>
  )
}

function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        <div className="social-links footer-links">
          <a href={BBB.INSTAGRAM} target="_blank" rel="noopener noreferrer">
            Instagram
          </a>
          <a href={BBB.TELEGRAM} target="_blank" rel="noopener noreferrer">
            Telegram
          </a>
          <a href={BBB.TIKTOK} target="_blank" rel="noopener noreferrer">
            TikTok
          </a>
        </div>
        <p className="body" style={{ margin: '14px 0' }}>
          <Link
            className="cta secondary"
            to="/collaborate"
            style={{ display: 'inline-flex' }}
          >
            Corporate Orders
          </Link>
        </p>
        <p className="body">Baked with love in Singapore.</p>
      </div>
    </footer>
  )
}

function VideoReviewCarousel({ items }: { items: ReviewItem[] }) {
  const [active, setActive] = useState(0)
  const [hover, setHover] = useState<number | null>(null)
  const [lightbox, setLightbox] = useState<number | null>(null)
  const timerRef = useRef<number | null>(null)
  const lbVideoRef = useRef<HTMLVideoElement | null>(null)
  const thumbsRef = useRef<Array<HTMLVideoElement | null>>([])

  useEffect(() => {
    thumbsRef.current = thumbsRef.current.slice(0, items.length)
  }, [items.length])

  useEffect(() => {
    if (hover !== null || lightbox !== null || items.length <= 1) {
      if (timerRef.current) {
        window.clearInterval(timerRef.current)
        timerRef.current = null
      }
      return
    }
    timerRef.current = window.setInterval(() => {
      setActive((i) => (i + 1) % items.length)
    }, 4000)
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current)
    }
  }, [hover, lightbox, items.length])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightbox(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    const v = thumbsRef.current[active]
    if (v && v !== document.activeElement) {
      try {
        v.muted = true
        v.loop = true
        v.playsInline = true
        const p = v.play()
        if (p && typeof p.catch === 'function') p.catch(() => {})
      } catch {
        /* ignore autoplay blocks */
      }
    }
  }, [active])

  const openLB = (idx: number) => {
    setLightbox(idx)
  }

  useEffect(() => {
    if (lightbox === null) {
      if (lbVideoRef.current) {
        try {
          lbVideoRef.current.pause()
        } catch {
          /* ignore */
        }
      }
      return
    }
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = ''
    }
  }, [lightbox])

  const toggleLBVideo = () => {
    const v = lbVideoRef.current
    if (!v) return
    if (v.paused) {
      const p = v.play()
      if (p && typeof p.catch === 'function') p.catch(() => {})
    } else {
      v.pause()
    }
  }

  return (
    <>
      <div
        className="video-carousel"
        onMouseLeave={() => setHover(null)}
      >
        {items.map((item, i) => (
          <button
            key={i}
            className={`video-card ${active === i ? 'video-card--active' : ''} ${
              hover === i ? 'video-card--hover' : ''
            } ${hover !== null && hover !== i ? 'video-card--dim' : ''}`}
            onMouseEnter={() => setHover(i)}
            onClick={() => openLB(i)}
            aria-label={`Open review video: ${item.credit || 'Customer video'}`}
          >
            <div className="video-card__wrap">
              <video
                ref={(el) => {
                  thumbsRef.current[i] = el
                }}
                src={item.src}
                muted
                loop
                playsInline
                preload="metadata"
                poster=""
              />
              <span className="video-card__play">▶</span>
            </div>
            <figcaption />
          </button>
        ))}
      </div>

      {lightbox !== null && (
        <div
          className="video-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label="Review video"
          onClick={(e) => {
            if (e.target === e.currentTarget) setLightbox(null)
          }}
        >
          <button
            className="video-lightbox__close"
            type="button"
            aria-label="Close video"
            onClick={() => setLightbox(null)}
          >
            ×
          </button>
          <button
            className="video-lightbox__frame"
            type="button"
            onClick={toggleLBVideo}
            aria-label="Play or pause video"
          >
            <video
              ref={lbVideoRef}
              key={lightbox}
              src={items[lightbox]?.src}
              controls
              playsInline
              controlsList="nodownload"
            />
          </button>
        </div>
      )}
    </>
  )
}

function ProductPage() {
  const reviews: ReviewItem[] =
    BBB.REVIEW_ITEMS && BBB.REVIEW_ITEMS.length
      ? BBB.REVIEW_ITEMS
      : BBB.VIDEOS && BBB.VIDEOS.length
        ? BBB.VIDEOS.map((v) => ({ ...v, type: 'video' } as ReviewItem))
        : []

  const videos = reviews.filter(
    (r) => r.type === 'video' || (r.src && r.src.toLowerCase().endsWith('.mp4')),
  )

  const showcaseRef = useRef<HTMLImageElement>(null)

  useEffect(() => {
    const ph = showcaseRef.current
    if (!ph) return
    if ('IntersectionObserver' in window) {
      const observer = new IntersectionObserver(
        (entries, obs) => {
          entries.forEach((e) => {
            if (e.isIntersecting) {
              e.target.classList.add('in-view')
              obs.unobserve(e.target)
            }
          })
        },
        { threshold: 0.35 },
      )
      observer.observe(ph)
      return () => observer.disconnect()
    } else {
      ph.classList.add('in-view')
    }
  }, [])

  return (
    <div className="page-stack">
      <section className="card hero-section">
        <div className="hero-copy">
          <p className="eyebrow">105 kcal · 9.2g protein · fresh-baked in SG</p>
          <h1>Fresh-baked protein brownies that still taste like a proper treat.</h1>
          <div className="hero-actions">
            <Link className="button button--primary" to="/order">
              Order Now 🍫
            </Link>
            <Link className="button button--secondary" to="/about">
              About The Brand
            </Link>
          </div>
        </div>

        <aside className="hero-panel">
          <p className="section-label">The product</p>
          <h2 style={{ marginTop: '4px', marginBottom: '14px' }}>The Fudgy Sea Salt Protein Brownie</h2>
          <img
            ref={showcaseRef}
            className="photo photo-anim"
            src="/BBB%20packaged%20protein%20brownie.png"
            alt="The Fudgy Sea Salt Protein Brownie in packaging"
            style={{ marginBottom: '14px' }}
          />
          <div className="badge-row">
            <span className="halal-badge">Halal Friendly</span>
            <span className="low-sugar-badge">Low in Sugar</span>
          </div>
          <div style={{ margin: '14px 0' }}>
            <MacroBig />
          </div>
          <p className="body">
            Dark, fudgy, and loaded with chocolate, finished off with a sprinkle of flakey
            sea salt — BBB's fudgy sea salt protein brownie is a healthier, macro-friendly
            way to indulge.
          </p>
        </aside>
      </section>

      <article className="card section-card">
        <p className="section-label">Good to know</p>
        <ul className="snow">
          <li>Halal Friendly</li>
          <li>
            Sweetened with an allulose–stevia blend, which may cause digestive
            discomfort in some individuals.
          </li>
          <li>Allergens: Our kitchen handles eggs, dairy, and wheat.</li>
          <li>
            Crystallisation can occur within a few hours and/or refrigeration — for peak
            enjoyment, reheat in a preheated airfryer or oven at 170°C for 2–3 minutes.
          </li>
          <li>
            Storage details: Best eaten as soon as possible. Can be kept on the counter
            for a day, and in the fridge for up to 3 days.
          </li>
        </ul>
      </article>

      <section className="card" id="reviews-card">
        <p className="section-label">Reviews</p>
        <h2>Customer Reviews</h2>
        {videos.length > 0 ? (
          <VideoReviewCarousel items={videos} />
        ) : reviews.length > 0 ? (
          <div className="review-gallery" id="review-gallery">
            {reviews.map((item, i) => (
              <figure className="review-card" key={i}>
                {item.type === 'video' ||
                (item.src && item.src.toLowerCase().endsWith('.mp4')) ? (
                  <video src={item.src} controls playsInline preload="metadata" />
                ) : (
                  <img src={item.src} alt="Customer review photo" />
                )}
                <figcaption>{item.credit || ''}</figcaption>
              </figure>
            ))}
          </div>
        ) : (
          <p className="body" style={{ textAlign: 'center' }}>
            Customer stories are coming soon — follow @builtbybakes.sg for the latest
            drops.
          </p>
        )}
      </section>

      <section className="page-cta">
        <Link className="button button--primary button--large" to="/order">
          Start Your Order
        </Link>
      </section>
    </div>
  )
}

function AboutPage() {
  return (
    <div className="page-stack">
      <article className="card section-card">
        <p className="section-label">Our story</p>
        <h2>Handcrafted in small batches every week.</h2>
        <p className="body">
          Every brownie is handcrafted in small batches, released in limited quantities
          every Friday evening for the following week. When they're gone, they're gone.
        </p>
      </article>

      <section className="card section-card">
        <p className="section-label">Community</p>
        <h2>Follow along and join Buffy Insiders.</h2>
        <p className="body">
          Follow @builtbybakes.sg on Instagram and join our Telegram for preorder drops,
          fresh-bake news, and Buffy Insiders updates — including exclusive test bakes and
          early access.
        </p>
        <p style={{ marginTop: '14px' }}>
          <Link className="cta" to="/feedback">
            Leave a review &amp; join Buffy Insiders
          </Link>
        </p>
      </section>
    </div>
  )
}

type Fulfilment = 'Self-collect' | 'Delivery'
type PayMethod = 'paynow' | 'card'

function OrderPage() {
  const open = bbbOrdersOpen()
  const stripeOn = stripeConfigured()
  const [params] = useSearchParams()
  const checkoutCancelled = params.get('checkout') === 'cancelled'

  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [qty, setQty] = useState(BBB.QUANTITIES[0])
  const [paymethod, setPaymethod] = useState<PayMethod>('paynow')
  const [fulfilment, setFulfilment] = useState<Fulfilment>('Self-collect')
  const collection = fulfilment === 'Delivery' ? 'Delivery' : 'Self-collect at Bras Basah MRT (Thursday, 7pm)'
  void collection
  const [address, setAddress] = useState('')
  const [notes, setNotes] = useState('')
  const [hearAbout, setHearAbout] = useState('')
  const [phoneErr, setPhoneErr] = useState(false)
  const [emailErr, setEmailErr] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [stripeErr, setStripeErr] = useState<string | null>(null)
  const [stockErr, setStockErr] = useState<string | null>(null)
  const [promoCode, setPromoCode] = useState('')
  const [promoApplied, setPromoApplied] = useState(false)
  const [promoMsg, setPromoMsg] = useState<string | null>(null)

  const FALLBACK_PROMOS: Record<string, PromoDef> = {
    BAKEDBYGAINS10: { pct: 0.1, label: '10% off (Opening Sale)' },
  }

  const [promosFromSupabase, setPromosFromSupabase] = useState<Record<string, PromoDef> | null>(null)
  const [stockCap, setStockCap] = useState<{ max: number; sold: number } | null>(null)

  useEffect(() => {
    void listActivePromos().then((m) => setPromosFromSupabase(m))
    void getActiveWeeklyLimit().then((r) => {
      if (r) setStockCap({ max: r.max, sold: r.sold })
    })
  }, [])

  const VALID_PROMOS: Record<string, PromoDef> =
    promosFromSupabase && Object.keys(promosFromSupabase).length > 0
      ? promosFromSupabase
      : FALLBACK_PROMOS

  const orderRef = useMemo(() => {
    return (
      'BBB-' +
      new Date().toISOString().slice(5, 10).replace('-', '') +
      '-' +
      Math.random().toString(36).slice(2, 5).toUpperCase()
    )
  }, [])

  const maxAllowedQty = useMemo(() => {
    if (!stockCap) return Infinity
    const remaining = Math.max(0, stockCap.max - stockCap.sold)
    return remaining
  }, [stockCap])

  const applyPromo = (raw: string) => {
    const code = raw.trim().toUpperCase()
    if (!code) {
      setPromoApplied(false)
      setPromoMsg(null)
      return
    }
    const def = VALID_PROMOS[code]
    if (def) {
      setPromoApplied(true)
      if (def.fixed != null) {
        setPromoMsg(`✓ ${def.label} applied — $${def.fixed.toFixed(2)} off brownies`)
      } else if (def.pct != null) {
        setPromoMsg(`✓ ${def.label} applied — ${Math.round(def.pct * 100)}% off brownies`)
      } else if (def.unit_price != null) {
        setPromoMsg(`✓ ${def.label} applied — brownies @ $${def.unit_price.toFixed(2)} each`)
      } else {
        setPromoMsg(`✓ ${def.label} applied`)
      }
    } else {
      setPromoApplied(false)
      setPromoMsg('✗ Promo code not recognised.')
    }
  }

  const { currentTotal, totalDisplay, subtotal, deliveryFee, discount, transactionFee } =
    useMemo(() => {
      const delivery = fulfilment === 'Delivery'
      const subtotalVal = qty * BBB.UNIT_PRICE
      const promoDef = promoApplied
        ? VALID_PROMOS[promoCode.trim().toUpperCase()]
        : null
      let discountVal = 0
      if (promoDef) {
        if (promoDef.fixed != null) discountVal = Math.min(subtotalVal, promoDef.fixed)
        else if (promoDef.pct != null) discountVal = subtotalVal * promoDef.pct
        else if (promoDef.unit_price != null) {
          discountVal = Math.max(0, (BBB.UNIT_PRICE - promoDef.unit_price) * qty)
        }
      }
      const discountedSubtotal = subtotalVal - discountVal
      const deliveryVal = delivery ? BBB.DELIVERY_FEE : 0
      const base = discountedSubtotal + deliveryVal
      const total = bbbGrossUp(base, paymethod)
      const fee = total - base

      const lines: ReactElement[] = [
        <div className="fee-line" key="brownies">
          <span>{qty} × brownies</span>
          <span>${subtotalVal.toFixed(2)}</span>
        </div>,
      ]
      if (discountVal > 0.004 && promoDef) {
        lines.push(
          <div className="fee-line fee-line--discount" key="discount">
            <span>Promo — {promoDef.label}</span>
            <span>-${discountVal.toFixed(2)}</span>
          </div>,
        )
      }
      if (delivery) {
        lines.push(
          <div className="fee-line" key="delivery">
            <span>Delivery</span>
            <span>${deliveryVal.toFixed(2)}</span>
          </div>,
        )
      }
      if (fee > 0.004) {
        lines.push(
          <div className="fee-line" key="fee">
            <span>{paymethod === 'card' ? 'Card processing fee' : 'Paynow QR processing fee'}</span>
            <span>${fee.toFixed(2)}</span>
          </div>,
        )
      }

      return {
        currentTotal: total,
        totalDisplay: `$${total.toFixed(2)}`,
        subtotal: subtotalVal,
        deliveryFee: deliveryVal,
        discount: discountVal,
        transactionFee: fee,
      }
    }, [qty, fulfilment, paymethod, promoApplied, promoCode, VALID_PROMOS])

  const validSGPhone_ = (v: string) => validSGPhone(v)
  const validEmail_ = (v: string) => validEmail(v)

  const handleSubmit = async (ev: React.FormEvent) => {
    ev.preventDefault()
    setStripeErr(null)
    setStockErr(null)
    const phoneOk = validSGPhone_(phone)
    const emailOk = validEmail_(email)
    setPhoneErr(!phoneOk)
    setEmailErr(!emailOk)
    if (!phoneOk || !emailOk) return

    if (!stripeOn) {
      setStripeErr(
        'Stripe is not configured — admin needs to set VITE_STRIPE_SECRET_KEY and VITE_STRIPE_PUBLISHABLE_KEY before checkout can be used.',
      )
      return
    }

    // 1) Display-only capacity check. If the current in-stock count is already
    //    past what the admin wants, block the submission rather than letting the
    //    user all the way through Stripe and failing on ReceiptPage. NOTE: this
    //    is NOT a reservation! Stock decrement happens ONLY on ReceiptPage AFTER
    //    confirmed paid Stripe transaction, so "payments that don't go through
    //    never eat into capacity / never create a pending order row".
    if (maxAllowedQty < qty) {
      setStockErr(
        `Only ${maxAllowedQty} brownie${maxAllowedQty === 1 ? '' : 's'} left this week. ${
          maxAllowedQty > 0 ? 'Please choose a smaller quantity.' : 'This week batch is fully claimed.'
        }`,
      )
      return
    }

    setSubmitting(true)

    const collection = fulfilment === 'Delivery' ? 'Delivery' : 'Self-collect at Bras Basah MRT (Thursday, 7pm)'
    const thanksParams = new URLSearchParams({
      type: 'order',
      ref: orderRef,
      qty: String(qty),
      ful: collection,
      total: currentTotal.toFixed(2),
      method: paymethod,
    })
    // Stripe replaces the literal {CHECKOUT_SESSION_ID} placeholder with the
    // real session id after the payment succeeds (quickstart docs pattern).
    const successUrl =
      window.location.origin + '/receipt?' + thanksParams.toString() + '&session_id={CHECKOUT_SESSION_ID}'
    const cancelUrl = window.location.origin + '/order?checkout=cancelled#order-form'

    try {
      const promoDef = promoApplied
        ? VALID_PROMOS[promoCode.trim().toUpperCase()]
        : null

      // To keep Stripe Checkout page totals identical to what the user saw on
      // the order page: bake any promo discount DIRECTLY into the brownie unit
      // price, and add the transaction fee as its OWN visible line item.
      // This guarantees sum(line_items) === currentTotal, with no hidden math.
      const discountedSubtotal = Math.max(0, subtotal - discount)
      const unitAfterDiscount = qty > 0 ? discountedSubtotal / qty : 0
      const promoLabel =
        promoApplied && promoDef?.label
          ? ` · ${promoDef.label}`
          : ''
      const brownieName =
        discount > 0.004
          ? `Brownies @ $${unitAfterDiscount.toFixed(2)} SGD each${promoLabel}`
          : `Brownies (${BBB.UNIT_PRICE.toFixed(2)} SGD each)`
      const lineItems = [
        {
          name: brownieName,
          description: `${qty} piece${qty === 1 ? '' : 's'} · Built By Bakes protein brownies${promoLabel}`,
          unitAmountSGD: Number(unitAfterDiscount.toFixed(2)),
          quantity: qty,
          imageUrl: window.location.origin + '/brownie.png',
        },
      ]
      const totalLineItems: Array<{ name: string; amountSGD: number }> = []
      if (fulfilment === 'Delivery' && deliveryFee > 0) {
        totalLineItems.push({
          name: 'Singapore delivery',
          amountSGD: deliveryFee,
        })
      }
      if (transactionFee > 0.004) {
        totalLineItems.push({
          name:
            paymethod === 'card'
              ? 'Card processing fee'
              : 'Paynow QR processing fee',
          amountSGD: Number(transactionFee.toFixed(2)),
        })
      }
      const hearTrim = hearAbout.trim()
      const notesCombined = [notes.trim(), hearTrim ? `Source: ${hearTrim}` : ''].filter(Boolean).join('\n')
      const orderPayload = {
        ref: orderRef,
        name: name.trim(),
        phone: phone.trim(),
        email: email.trim(),
        qty,
        method: paymethod,
        fulfilment,
        collection,
        address: fulfilment === 'Delivery' ? address.trim() : '',
        notes: notesCombined,
        hearAbout: hearTrim,
        subtotal: Number(subtotal.toFixed(2)),
        deliveryFee: Number(deliveryFee.toFixed(2)),
        discount: Number(discount.toFixed(2)),
        promoCodeApplied: promoApplied ? promoCode.trim().toUpperCase() : '',
        total: Number(currentTotal.toFixed(2)),
      }

      const session = await stripeCreateCheckoutSession({
        method: paymethod,
        lineItems,
        totalLineItems,
        referenceNumber: orderRef,
        customerName: name.trim(),
        customerEmail: email.trim(),
        customerPhone: phone.trim(),
        successUrl,
        cancelUrl,
        promoCodeName: promoDef?.label || undefined,
        discountAmountSGD: discount || undefined,
        sourceChannel: hearTrim || undefined,
        orderPayload,
      })

      // NO order row and NO stock reservation here. If the user cancels,
      // abandons, or payment fails, nothing is written to the DB. Orders
      // table + weekly_limits.sold_brownies are ONLY written on the
      // ReceiptPage AFTER Stripe confirms payment_status === paid.

      // Hard redirect to Stripe's hosted checkout page.
      window.location.assign(session.sessionUrl)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setStripeErr(message || 'Order submission failed — please try again.')
      setSubmitting(false)
    }
  }

  return (
    <div className="page-stack">
      <section className="card feature-section">
        <div className="section-heading">
          <p className="section-label">Before you order</p>
          <h2>Drop rhythm + fulfilment notes.</h2>
        </div>
        <div className="feature-grid">
          <article>
            <h3>Friday drops</h3>
            <p>
              Weekly drops open Friday evening for the week ahead — limited quantities,
              first-served. <b>Orders close Tuesday night</b> for the following week's
              bake.
            </p>
          </article>
          <article>
            <h3>Self-collect</h3>
            <p>
              Collections at Bras Basah MRT <b>(Thursday, 7pm)</b>.
            </p>
          </article>
          <article>
            <h3>Delivery</h3>
            <p>
              Opt for delivery at <b>flat $12 courier fee</b>.
            </p>
          </article>
        </div>
      </section>

      {!open ? (
        <div className="closed-banner" id="closed-banner">
          {BBB.CLOSED_NOTE}
        </div>
      ) : stockCap && stockCap.sold >= stockCap.max ? (
        <div className="closed-banner" id="closed-banner">
          {BBB.CLOSED_NOTE}
        </div>
      ) : (
        <section className="order-layout">
          <form
            id="order-form"
            onSubmit={handleSubmit}
            className="card order-form"
            encType="multipart/form-data"
          >
            <div className="form-grid">
              <label>
                <span>Full name</span>
                <input
                  name="name"
                  type="text"
                  required
                  autoComplete="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your full name"
                />
              </label>

              <label>
                <span>Contact number</span>
                <input
                  name="phone"
                  type="tel"
                  required
                  autoComplete="tel"
                  placeholder="e.g. 9123 4567"
                  value={phone}
                  onChange={(e) => {
                    setPhone(e.target.value)
                    if (phoneErr) setPhoneErr(!validSGPhone(e.target.value))
                  }}
                  onBlur={(e) => setPhoneErr(!validSGPhone(e.target.value))}
                  aria-invalid={phoneErr || undefined}
                />
                {phoneErr && (
                  <p className="err">
                    Enter a valid SG number.
                  </p>
                )}
              </label>

              <label>
                <span>Email</span>
                <input
                  name="email"
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value)
                    if (emailErr) setEmailErr(!validEmail(e.target.value))
                  }}
                  onBlur={(e) => setEmailErr(!validEmail(e.target.value))}
                  placeholder="you@example.com"
                  aria-invalid={emailErr || undefined}
                />
                {emailErr && (
                  <p className="err">
                    Enter a valid email.
                  </p>
                )}
              </label>

              <label>
                <span>Quantity</span>
                <select
                  name="quantity"
                  required
                  value={qty}
                  onChange={(e) => setQty(Number(e.target.value))}
                >
                  {BBB.QUANTITIES.filter((q) => !stockCap || q <= stockCap.max - stockCap.sold).map((q) => (
                    <option key={q} value={q}>
                      {q} brownies — ${(q * BBB.UNIT_PRICE).toFixed(2)}
                    </option>
                  ))}
                  {stockCap && BBB.QUANTITIES.every((q) => q > stockCap.max - stockCap.sold) && (
                    <option value={BBB.QUANTITIES[0]} disabled>
                      Sold out for the week
                    </option>
                  )}
                </select>
                {stockCap && qty > stockCap.max - stockCap.sold && (
                  <p className="err">
                    Only {Math.max(0, stockCap.max - stockCap.sold)} brownies remaining this week — pick a smaller
                    size or try again next drop.
                  </p>
                )}
              </label>

              <label>
                <span>Payment method</span>
                <select
                  name="payment-method"
                  required
                  value={paymethod}
                  onChange={(e) => setPaymethod(e.target.value as PayMethod)}
                >
                  <option value="paynow">Paynow QR</option>
                  <option value="card">Card</option>
                </select>
                {!stripeOn && (
                  <span className="hint">
                    Stripe keys are not configured yet. Using static PayNow QR and manual
                    card capture.
                  </span>
                )}
              </label>

              <label>
                <span>Collection Method</span>
                <select
                  name="fulfilment"
                  required
                  value={fulfilment}
                  onChange={(e) => setFulfilment(e.target.value as Fulfilment)}
                >
                  <option value="Self-collect">Self-collect</option>
                  <option value="Delivery">Delivery</option>
                </select>
              </label>
            </div>

            {fulfilment === 'Delivery' ? (
              <label>
                <span>Delivery address</span>
                <input
                  name="delivery-address"
                  type="text"
                  placeholder="Block / street / unit / postal"
                  required
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                />
              </label>
            ) : null}

            <div className="corp-callout">
              🍫 Ordering <b>200+ brownies</b> for an office or event? Skip this form —
              contact us directly{' '}
              <Link to="/collaborate">here</Link>.
            </div>

            <label>
              <span>Promo code (optional)</span>
              <div className="promo-row">
                <input
                  name="promo"
                  type="text"
                  autoComplete="off"
                  placeholder=""
                  value={promoCode}
                  onChange={(e) => setPromoCode(e.target.value)}
                  onBlur={(e) => applyPromo(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      applyPromo(promoCode)
                    }
                  }}
                />
                <button
                  type="button"
                  className="button button--secondary"
                  onClick={() => applyPromo(promoCode)}
                >
                  Apply
                </button>
              </div>
              {promoMsg && (
                <p
                  className={
                    promoApplied ? 'hint promo-hint promo-hint--ok' : 'err promo-hint'
                  }
                  style={{ marginTop: '6px', marginBottom: 0 }}
                >
                  {promoMsg}
                </p>
              )}
            </label>

            <label>
              <span>How did you hear about us?</span>
              <select
                id="order-hear-about"
                name="order_hear_about"
                value={hearAbout}
                onChange={(e) => setHearAbout(e.target.value)}
              >
                <option value="">Select an option</option>
                <option value="Rednote">Rednote</option>
                <option value="Instagram">Instagram</option>
                <option value="TikTok">TikTok</option>
                <option value="Word of mouth">Word of mouth</option>
                <option value="Others">Others</option>
              </select>
            </label>

            <label>
              <span>Order notes (optional)</span>
              <textarea
                name="order-notes"
                rows={3}
                placeholder=""
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </label>

            {stockErr && (
              <div
                className="err"
                role="alert"
                style={{
                  padding: '12px 14px',
                  borderRadius: '14px',
                  background: '#fff5e5',
                  color: '#7a4710',
                  border: '1px solid #f6d89c',
                  fontSize: '0.88rem',
                  lineHeight: 1.5,
                }}
              >
                <b style={{ display: 'block', marginBottom: '4px' }}>
                  Weekly capacity reached.
                </b>
                {stockErr}
              </div>
            )}

            {checkoutCancelled && (
              <div
                style={{
                  padding: '12px 14px',
                  borderRadius: '14px',
                  background: '#fff8e1',
                  color: '#71471b',
                  border: '2px solid #f1d88a',
                  fontSize: '0.88rem',
                  lineHeight: 1.5,
                }}
                role="status"
              >
                <b>Checkout was cancelled.</b> Your order details are preserved — choose the same
                or a different payment method then try again.
              </div>
            )}

            {stripeErr && (
              <div
                className="err"
                role="alert"
                style={{
                  padding: '12px 14px',
                  borderRadius: '14px',
                  background: '#fdecec',
                  color: '#861d1d',
                  fontSize: '0.88rem',
                  lineHeight: 1.5,
                }}
              >
                <b style={{ display: 'block', marginBottom: '4px' }}>
                  Order submission failed:
                </b>
                {stripeErr}
              </div>
            )}
          </form>

          <aside className="order-sidebar">
            <section className="card section-card">
              <p className="section-label">Order summary</p>
              <div className="summary-list">
                <div>
                  <span>Brownies</span>
                  <strong>
                    {qty} × SGD {BBB.UNIT_PRICE.toFixed(2)}
                  </strong>
                </div>
                <div>
                  <span>Subtotal</span>
                  <strong>SGD {(qty * BBB.UNIT_PRICE).toFixed(2)}</strong>
                </div>
                <div>
                  <span>Delivery</span>
                  <strong>
                    SGD {fulfilment === 'Delivery' ? BBB.DELIVERY_FEE.toFixed(2) : '0.00'}
                  </strong>
                </div>
                {discount > 0.004 && (
                  <div>
                    <span style={{ color: '#205a2e' }}>Promo discount</span>
                    <strong style={{ color: '#205a2e' }}>
                      -SGD {discount.toFixed(2)}
                    </strong>
                  </div>
                )}
                {transactionFee > 0.004 && (
                  <div>
                    <span>Transaction fee</span>
                    <strong>SGD {transactionFee.toFixed(2)}</strong>
                  </div>
                )}
                <div className="summary-total">
                  <span>Total</span>
                  <strong>{totalDisplay}</strong>
                </div>
              </div>
            </section>

            <button
              form="order-form"
              className="button button--primary button--large"
              type="submit"
              style={{ width: '100%' }}
              disabled={submitting}
            >
              {submitting ? 'Taking you to checkout…' : 'Proceed to checkout'}
            </button>
          </aside>
        </section>
      )}
    </div>
  )
}

function CollaboratePage() {
  const [name, setName] = useState('')
  const [company, setCompany] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [type, setType] = useState<
    'Corporate / Bulk Order' | 'Brand Collaboration' | 'Other'
  >('Corporate / Bulk Order')
  const [message, setMessage] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [resultMsg, setResultMsg] = useState<string | null>(null)
  const [resultOk, setResultOk] = useState<boolean>(true)
  const [emailErr, setEmailErr] = useState(false)
  const [phoneErr, setPhoneErr] = useState(false)

  const handleSubmit = async (ev: React.FormEvent) => {
    ev.preventDefault()
    if (submitting) return
    const emailOk = validEmail(email)
    const phoneOk = phone.trim() ? validSGPhone(phone) : true
    setEmailErr(!emailOk)
    setPhoneErr(!phoneOk)
    if (!emailOk || !phoneOk) {
      setResultOk(false)
      setResultMsg(
        (!emailOk ? 'Enter a valid email. ' : '') +
          (!phoneOk ? 'Enter a valid SG number.' : ''),
      )
      return
    }
    setResultMsg(null)
    setSubmitting(true)

    const payload: Extract<ContactFormPayload, { kind: 'collab' }> = {
      kind: 'collab',
      name: name.trim(),
      company: company.trim() || null,
      email: email.trim(),
      phone: phone.trim() || null,
      enquiry_type: type,
      message: message.trim(),
    }
    const res = await sendContactForm(payload)
    setResultOk(res.ok)
    if (res.ok) {
      setResultMsg(
        'Thanks for reaching out — we will reply within 2–3 business days via the email you provided.',
      )
      setName('')
      setCompany('')
      setEmail('')
      setPhone('')
      setType('Corporate / Bulk Order')
      setMessage('')
    } else {
      setResultMsg(
        'We hit a problem sending your enquiry: ' +
          res.detail +
          (res.misconfigured
            ? ''
            : ' — please email ' + BBB.CORP_EMAIL + ' directly with your enquiry.'),
      )
    }
    setSubmitting(false)
  }

  return (
    <div className="page-stack">
      <section className="card section-card">
        <p className="section-label">Partner with us</p>
        <h1>Corporate Order</h1>
        <p className="body">
          Brand collaborations, influencer partnerships, office pantry orders, event
          catering — tell us what you're thinking and we'll get back to you.
        </p>
      </section>

      <form onSubmit={handleSubmit} className="card section-card" noValidate>
        <div className="form-grid">
          <label>
            <span>Name</span>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            <span>Company / brand name (optional)</span>
            <input
              type="text"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
            />
          </label>
          <label>
            <span>Email</span>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => {
                setEmail(e.target.value)
                if (emailErr) setEmailErr(!validEmail(e.target.value))
              }}
            />
            {emailErr && (
              <p className="hint" style={{ color: '#b42318', marginTop: 2 }}>
                Enter a valid email.
              </p>
            )}
          </label>
          <label>
            <span>Contact number (optional)</span>
            <input
              type="tel"
              value={phone}
              onChange={(e) => {
                setPhone(e.target.value)
                if (phoneErr) {
                  const t = e.target.value.trim()
                  setPhoneErr(t ? !validSGPhone(t) : false)
                }
              }}
            />
            {phoneErr && (
              <p className="hint" style={{ color: '#b42318', marginTop: 2 }}>
                Enter a valid SG number.
              </p>
            )}
          </label>
        </div>
        <label>
          <span>Enquiry type</span>
          <select
            required
            value={type}
            onChange={(e) => {
              const v = e.target.value
              if (
                v === 'Corporate / Bulk Order' ||
                v === 'Brand Collaboration' ||
                v === 'Other'
              ) {
                setType(v)
              }
            }}
          >
            <option value="Corporate / Bulk Order">Corporate / Bulk Order</option>
            <option value="Brand Collaboration">Brand Collaboration</option>
            <option value="Other">Other</option>
          </select>
        </label>
        <label>
          <span>Message</span>
          <textarea
            rows={4}
            required
            placeholder="Quantities, event date, partnership idea..."
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
        </label>
        {!contactEndpointConfigured() && (
          <div
            style={{
              borderRadius: 12,
              padding: '12px 14px',
              marginTop: 6,
              marginBottom: 10,
              fontSize: '0.85rem',
              background: '#fff3db',
              color: '#744210',
              border: '2px solid #f5d28a',
            }}
            role="alert"
          >
            <b>Setup reminder:</b> add <code>VITE_CONTACT_ENDPOINT</code> to your{' '}
            <code>.env</code> file so this form sends an email directly to{' '}
            {BBB.CORP_EMAIL} without opening the mail app. Recommended service:{' '}
            <a
              href="https://formspree.io/"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: 'inherit', textDecoration: 'underline' }}
            >
              Formspree free tier
            </a>
            — create a form pointing to {BBB.CORP_EMAIL} and paste the HTTPS URL.
          </div>
        )}
        {resultMsg && (
          <div
            style={{
              borderRadius: 12,
              padding: '12px 14px',
              marginTop: 6,
              marginBottom: 10,
              fontSize: '0.85rem',
              background: resultOk ? '#eaf6e7' : '#fde6e4',
              color: resultOk ? '#205a2e' : '#861d1d',
              border: `2px solid ${resultOk ? '#b4e3a4' : '#f3b3ae'}`,
            }}
            role={resultOk ? 'status' : 'alert'}
          >
            {resultMsg}
          </div>
        )}
        <button
          className="button button--primary button--large"
          type="submit"
          style={{ width: '100%' }}
          disabled={submitting}
        >
          {submitting ? 'Sending enquiry…' : 'Send enquiry'}
        </button>
        <p className="hint" style={{ marginTop: '10px', textAlign: 'center' }}>
          We'll reply to the email you've provided within 2–3 business days.
        </p>
      </form>
    </div>
  )
}

function FeedbackPage() {
  const [name, setName] = useState('')
  const [telegramHandle, setTelegramHandle] = useState('')
  const [feedback, setFeedback] = useState('')
  const [photo, setPhoto] = useState<File | null>(null)
  const [consent, setConsent] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [resultMsg, setResultMsg] = useState<string | null>(null)
  const [resultOk, setResultOk] = useState<boolean>(true)
  const [rainTick, setRainTick] = useState(0)

  useEffect(() => {
    if (rainTick === 0) return
    const prefersReduced =
      window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (prefersReduced) return
    const count = Math.min(
      16,
      Math.max(8, Math.floor(window.innerWidth / 110)),
    )
    const drops: HTMLImageElement[] = []
    for (let i = 0; i < count; i++) {
      const s = document.createElement('img')
      s.className = 'rain-item'
      s.src = '/buffy.png'
      s.alt = ''
      s.style.position = 'fixed'
      s.style.top = '-140px'
      s.style.left = `${Math.round(5 + Math.random() * 85)}%`
      s.style.animationDelay = `${Math.random() * 0.7}s`
      s.style.width = `${Math.min(88, Math.max(56, Math.floor(window.innerWidth / 9)))}px`
      s.style.zIndex = '9998'
      document.body.appendChild(s)
      drops.push(s)
    }
    const timeout = window.setTimeout(() => {
      drops.forEach((d) => {
        try {
          d.remove()
        } catch {
          /* noop */
        }
      })
    }, 4000)
    return () => window.clearTimeout(timeout)
  }, [rainTick])

  const handleSubmit = async (ev: React.FormEvent) => {
    ev.preventDefault()
    if (submitting) return
    if (!consent) return
    const tg = telegramHandle.trim()
    setResultMsg(null)
    setSubmitting(true)

    const payload: Extract<ContactFormPayload, { kind: 'feedback' }> = {
      kind: 'feedback',
      name: name.trim(),
      telegram_handle: tg,
      feedback: feedback.trim(),
      consent_given: !!consent,
      photo_filename: photo?.name?.trim() || null,
    }
    const res = await sendContactForm(payload)
    setResultOk(res.ok)
    if (res.ok) {
      setResultMsg('We will follow up with you shortly!')
      setRainTick((n) => n + 1)
      setName('')
      setTelegramHandle('')
      setFeedback('')
      setPhoto(null)
      setConsent(false)
    } else {
      setResultMsg(
        'We hit a problem sending your feedback: ' +
          res.detail +
          (res.misconfigured
            ? ''
            : ' — please message ' + BBB.TELEGRAM + ' directly with your feedback.'),
      )
    }
    setSubmitting(false)
  }

  return (
    <div className="page-stack">
      <section className="card section-card">
        <p className="section-label">Buffy insiders</p>
        <h1>Leave a review and join the community.</h1>
        <p className="body">
          Leave a review or share a photo after enjoying your brownies, and join our Buffy
          Insiders community for early drops, behind-the-scenes updates, and exclusive test
          bakes.
        </p>
      </section>

      <form onSubmit={handleSubmit} className="card section-card" encType="multipart/form-data" noValidate>
        <div className="form-grid">
          <label>
            <span>Name</span>
            <input
              id="feedback-name"
              name="feedback_name"
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            <span>Telegram handle</span>
            <input
              id="feedback-telegram"
              name="feedback_telegram"
              type="text"
              autoComplete="off"
              required
              value={telegramHandle}
              onChange={(e) => setTelegramHandle(e.target.value)}
            />
          </label>
        </div>
        <label>
          <span>Feedback / review</span>
          <textarea
            id="feedback-review"
            name="feedback_review"
            rows={4}
            required
            placeholder="Tell us what you loved and how it went"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
          />
        </label>
        <label>
          <span>Photo (optional)</span>
          <input
            id="feedback-photo"
            name="feedback_photo"
            type="file"
            accept="image/*"
            onChange={(e) => setPhoto(e.target.files?.[0] || null)}
          />
        </label>
        <label style={{ flexDirection: 'row', alignItems: 'center', gap: '8px' }}>
          <input
            id="feedback-consent"
            name="feedback_consent"
            type="checkbox"
            checked={consent}
            required
            onChange={(e) => setConsent(e.target.checked)}
            style={{ width: 'auto', padding: 0 }}
          />{' '}
          <span style={{ fontSize: '0.85rem', textTransform: 'none', letterSpacing: 0 }}>
            I agree that my review or photo may be shared publicly by Built By Bakes.
          </span>
        </label>
        {!contactEndpointConfigured() && (
          <div
            style={{
              borderRadius: 12,
              padding: '12px 14px',
              marginTop: 6,
              marginBottom: 10,
              fontSize: '0.85rem',
              background: '#fff3db',
              color: '#744210',
              border: '2px solid #f5d28a',
            }}
            role="alert"
          >
            <b>Setup reminder:</b> add <code>VITE_CONTACT_ENDPOINT</code> to your{' '}
            <code>.env</code> file so this form sends an email directly to{' '}
            {BBB.CORP_EMAIL} without opening the mail app. Recommended service:{' '}
            <a
              href="https://formspree.io/"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: 'inherit', textDecoration: 'underline' }}
            >
              Formspree free tier
            </a>
            — create a form pointing to {BBB.CORP_EMAIL} and paste the HTTPS URL.
          </div>
        )}
        {resultMsg && (
          <div
            style={{
              borderRadius: 12,
              padding: '12px 14px',
              marginTop: 6,
              marginBottom: 10,
              fontSize: '0.85rem',
              background: resultOk ? '#eaf6e7' : '#fde6e4',
              color: resultOk ? '#205a2e' : '#861d1d',
              border: `2px solid ${resultOk ? '#b4e3a4' : '#f3b3ae'}`,
            }}
            role={resultOk ? 'status' : 'alert'}
          >
            {resultMsg}
          </div>
        )}
        <button
          className="button button--primary button--large"
          type="submit"
          style={{ width: '100%' }}
          disabled={submitting || !consent}
        >
          {submitting ? 'Sending feedback…' : 'Send feedback'}
        </button>
        <p className="hint" style={{ marginTop: '10px', textAlign: 'center' }}>
          You'll receive Buffy Insiders updates, and may be invited to share more photos
          later.
        </p>
      </form>
    </div>
  )
}

function ReceiptPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const type = params.get('type')
  const ref = params.get('ref')
  const qty = params.get('qty')
  const ful = params.get('ful')
  const total = params.get('total')
  const method = params.get('method') as 'card' | 'paynow' | null
  const sessionId = params.get('session_id')

  const [receipt, setReceipt] = useState<{
    loaded: boolean
    ok: boolean
    amount_total_cents: number
    currency: string
    payment_status: string | null
    receipt_url?: string
    customer_name?: string
    customer_email?: string
    customer_phone?: string
    line_items: Array<{
      description: string
      quantity: number
      amount_total_cents: number
      currency: string
      unit_amount_cents?: number
    }>
    error?: string
    session_id?: string
    payment_intent_id?: string
    metadata?: Record<string, string>
  }>({
    loaded: false,
    ok: false,
    amount_total_cents: 0,
    currency: 'sgd',
    payment_status: null,
    line_items: [],
  })

  const [confirmStatus, setConfirmStatus] = useState<
    | { kind: 'idle' }
    | { kind: 'ok' }
    | { kind: 'stock_issue'; max_cap?: number; new_sold?: number }
    | { kind: 'db_error' }
  >({ kind: 'idle' })
  const confirmedRef = useRef<{ [sessionRef: string]: true }>({})

  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    void (async () => {
      try {
        const session = await stripeRetrieveCheckoutSession(sessionId)
        if (cancelled) return
        const li: typeof receipt.line_items = []
        const data = (session.line_items as unknown as {
          data?: Array<{
            description: string
            quantity: number | null
            currency: string
            amount_total: number | null
            price?: { unit_amount?: number | null } | null
          }>
        } | undefined)?.data
        if (Array.isArray(data)) {
          for (const it of data) {
            li.push({
              description: it.description || 'Item',
              quantity: typeof it.quantity === 'number' ? it.quantity : 1,
              amount_total_cents: typeof it.amount_total === 'number' ? it.amount_total : 0,
              currency: it.currency || 'sgd',
              unit_amount_cents:
                typeof (it.price?.unit_amount ?? null) === 'number'
                  ? (it.price!.unit_amount as number)
                  : undefined,
            })
          }
        }
        let paymentIntentId: string | undefined
        let paymentStatus: string | null = session.payment_status || null
        if (session.payment_intent) {
          if (typeof session.payment_intent === 'string') {
            paymentIntentId = session.payment_intent
          } else if (
            session.payment_intent &&
            typeof session.payment_intent === 'object' &&
            'id' in session.payment_intent
          ) {
            const pi = session.payment_intent as { id?: string; status?: string }
            paymentIntentId = pi.id
            if (pi.status && !paymentStatus) {
              paymentStatus =
                pi.status === 'succeeded'
                  ? 'paid'
                  : pi.status === 'requires_payment_method'
                    ? 'unpaid'
                    : 'no_payment_required'
            }
          }
        }
        let receiptUrl: string | undefined
        if (
          session.payment_intent &&
          typeof session.payment_intent !== 'string' &&
          'latest_charge' in session.payment_intent
        ) {
          const lc = (session.payment_intent as { latest_charge?: unknown }).latest_charge
          if (
            lc &&
            typeof lc !== 'string' &&
            typeof lc === 'object' &&
            'receipt_url' in lc
          ) {
            receiptUrl = (lc as { receipt_url?: string }).receipt_url || undefined
          }
        }
        // POST-PAID ONLY: Only after confirmed paid, write order row +
        // increment weekly_limits.sold_brownies atomically. If payment is
        // unpaid/cancelled/processing we do ZERO to the DB — no pending
        // orders, no capacity burned. StrictMode ref + set flag guard both
        // prevent double-writes.
        const confirmKey = sessionId + '::' + (ref || '')
        if (
          paymentStatus === 'paid' &&
          confirmStatus.kind === 'idle' &&
          ref &&
          qty &&
          ful &&
          !confirmedRef.current[confirmKey]
        ) {
          confirmedRef.current[confirmKey] = true
          try {
            const meta: Record<string, string> | undefined =
              session.metadata && typeof session.metadata === 'object'
                ? (session.metadata as Record<string, string>)
                : undefined
            let op: Record<string, unknown> = {}
            try {
              if (meta?.order_payload_json) op = JSON.parse(meta.order_payload_json)
            } catch {
              // ignore
            }
            const qtyN = Number(qty)
            const totalN = Number(total) || Number(op.total) || 0
            if (qtyN > 0 && totalN > 0) {
              const methodActual: 'card' | 'paynow' =
                method === 'paynow' || (op.method === 'paynow') ? 'paynow' : 'card'
              const fulfilmentActual: 'Self-collect' | 'Delivery' =
                op.fulfilment === 'Delivery' ? 'Delivery' : 'Self-collect'
              const res = await paidConfirmInsertOrder({
                ref,
                name: String(meta?.customer_name || op.name || 'Customer'),
                phone: String(meta?.customer_phone || op.phone || ''),
                email: String(meta?.customer_email || op.email || '') || undefined,
                qty: Number(op.qty || qtyN),
                total: Number(op.total || totalN),
                subtotal: Number(op.subtotal ?? (typeof op.total === 'number' ? op.total : totalN)),
                delivery_fee: Number(op.deliveryFee ?? 0),
                discount: Number(op.discount ?? 0),
                method: methodActual,
                fulfilment: fulfilmentActual,
                collection: String(op.collection || ful),
                address: fulfilmentActual === 'Delivery' ? String(op.address || '') || undefined : undefined,
                promo: op.promoCodeApplied ? String(op.promoCodeApplied) : undefined,
                payment_ref: paymentIntentId || String(session.id),
                notes: String(op.notes || '') || undefined,
              })
              if (res.ok) {
                setConfirmStatus({ kind: 'ok' })
              } else if (res.reason === 'no_stock') {
                setConfirmStatus({
                  kind: 'stock_issue',
                  max_cap: res.max_cap,
                  new_sold: res.new_sold,
                })
              } else {
                setConfirmStatus({ kind: 'db_error' })
              }
            } else {
              setConfirmStatus({ kind: 'ok' })
            }
          } catch {
            setConfirmStatus({ kind: 'db_error' })
          }
        }
        setReceipt({
          loaded: true,
          ok: true,
          amount_total_cents: typeof session.amount_total === 'number' ? session.amount_total : 0,
          currency: session.currency || 'sgd',
          payment_status: paymentStatus,
          receipt_url: receiptUrl,
          customer_name:
            (session.customer_details &&
              typeof session.customer_details !== 'string' &&
              session.customer_details?.name) ||
            (session.metadata && typeof session.metadata === 'object'
              ? (session.metadata as Record<string, string> | undefined)?.customer_name
              : undefined),
          customer_email:
            (session.customer_details &&
              typeof session.customer_details !== 'string' &&
              session.customer_details?.email) ||
            (session.metadata && typeof session.metadata === 'object'
              ? (session.metadata as Record<string, string> | undefined)?.customer_email
              : undefined),
          customer_phone:
            (session.customer_details &&
              typeof session.customer_details !== 'string' &&
              session.customer_details?.phone) ||
            (session.metadata && typeof session.metadata === 'object'
              ? (session.metadata as Record<string, string> | undefined)?.customer_phone
              : undefined),
          line_items: li,
          session_id: session.id,
          payment_intent_id: paymentIntentId,
          metadata:
            session.metadata && typeof session.metadata === 'object'
              ? (session.metadata as Record<string, string>)
              : undefined,
        })
      } catch (err) {
        if (cancelled) return
        setReceipt({
          loaded: true,
          ok: false,
          amount_total_cents: 0,
          currency: 'sgd',
          payment_status: null,
          line_items: [],
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  let title = 'Thank you!'
  let msg = ''

  if (type === 'collab') {
    title = 'Enquiry sent! 🍫'
    msg =
      "Thanks for reaching out — we'll get back to you at the email you provided within 2–3 business days."
  } else if (type === 'feedback') {
    title = 'Thanks for your review! 🍫'
    msg =
      "Your feedback is really appreciated. We'll review it and may share your photo or quote with Buffy Insiders updates."
  } else if (receipt.loaded && receipt.ok && receipt.payment_status === 'paid') {
    title = 'Order confirmed 🍫'
    msg = ''
  } else {
    title = 'Order Received 🍫'
    msg =
      receipt.loaded && receipt.ok && receipt.payment_status
        ? receipt.payment_status === 'no_payment_required'
          ? 'No payment required — order locked in. Astrid or Portia will be in touch.'
          : receipt.payment_status === 'unpaid'
            ? 'Payment not received yet — please complete PayNow transfer or check your card bank for any 3DS/decline and retry.'
            : 'Payment is being processed by Stripe. Once confirmed Astrid or Portia will contact you to confirm fulfilment.'
        : "We're verifying your payment. Astrid or Portia will contact you shortly to confirm your order and your pickup/delivery details."
  }

  useEffect(() => {
    const greeting =
      type === 'order'
        ? 'Order locked in! Astrid or Portia will be in touch 🍫'
        : type === 'collab'
          ? "Thanks for reaching out — we'll be in touch 💼"
          : 'Thanks for your review! Welcome to Buffy Insiders 🏋️'
    document.body.dataset.buffyGreeting = greeting
    return () => {
      delete document.body.dataset.buffyGreeting
    }
  }, [type])

  return (
    <>
      <div className="page-stack">
        <section className="card section-card" style={{ textAlign: 'center' }}>
          <img
            className="buffy-hero"
            src="/buffy.png"
            alt="Buffy the Brownie celebrating"
            style={{ width: '180px', margin: '0 auto 14px' }}
          />
          <h1 style={{ marginBottom: '10px' }}>{title}</h1>
          <p className="tag" style={{ marginBottom: '10px' }}>
            {msg}
          </p>
          {confirmStatus.kind === 'stock_issue' && (
            <div
              className="alert warn"
              style={{
                maxWidth: 560,
                margin: '16px auto 6px',
                textAlign: 'left',
                borderRadius: 14,
                padding: '14px 16px',
                border: '2px solid #ffd399',
                background: '#fff6e7',
                color: '#7a4a11',
              }}
            >
              <div style={{ fontWeight: 700, marginBottom: 4 }}>Order confirmed, but — brownies sold out during checkout 🥲</div>
              <p style={{ margin: 0 }}>
                Your payment went through successfully, but the last brownie in this week's batch was claimed by
                another order just before yours. Your money has not been taken off you (card capture holds will
                automatically release in 7 days; PayNow transactions will be refunded manually). Please message
                Astrid / Portia immediately via{' '}
                <a href={BBB.TELEGRAM} target="_blank" rel="noreferrer noopener">Telegram</a> or{' '}
                <a href={'mailto:' + BBB.CORP_EMAIL}>{BBB.CORP_EMAIL}</a> with your Order Reference number and we'll either swap your
                order to next week's drop or process a 100% refund right away.
              </p>
            </div>
          )}
          {confirmStatus.kind === 'db_error' && (
            <div
              className="alert err"
              style={{
                maxWidth: 560,
                margin: '16px auto 6px',
                textAlign: 'left',
                borderRadius: 14,
                padding: '14px 16px',
                border: '2px solid #ffc8c8',
                background: '#fff1f1',
                color: '#791e1e',
              }}
            >
              <div style={{ fontWeight: 700, marginBottom: 4 }}>Unable to record the order in the system</div>
              <p style={{ margin: 0 }}>
                Your payment was processed by Stripe but the brownie database was temporarily unreachable when we
                tried to save it. Please message Astrid / Portia on{' '}
                <a href={BBB.TELEGRAM} target="_blank" rel="noreferrer noopener">Telegram</a> with your Order Reference number
                and we'll add it manually — you won't lose your order or your money.
              </p>
            </div>
          )}
          {ref && (
            <p style={{ marginTop: '14px' }}>
              <span className="chip hl" style={{ fontSize: '0.85rem', padding: '8px 16px' }}>
                Order Reference number: <b>{ref}</b>
              </span>
            </p>
          )}
          {qty && (
            <p className="tag" style={{ marginTop: '10px' }}>
              {qty} brownies · {ful || ''} · total paid {total ? `$${total}` : ''}
            </p>
          )}

          {sessionId && receipt.loaded && receipt.ok && receipt.line_items.length > 0 && (
            <div
              style={{
                textAlign: 'left',
                borderRadius: 16,
                padding: '18px 16px 16px',
                marginTop: 18,
                background: '#fdf8f0',
                border: '2px solid #f2dfbf',
                maxWidth: 520,
                marginLeft: 'auto',
                marginRight: 'auto',
              }}
            >
              <div
                style={{
                  fontSize: '0.72rem',
                  fontWeight: 700,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  color: '#9a6d2d',
                  marginBottom: 10,
                }}
              >
                Receipt
              </div>
              {receipt.customer_name && (
                <div style={{ fontSize: '0.92rem', color: '#3c2a12' }}>
                  <b>{receipt.customer_name}</b>
                </div>
              )}
              {receipt.customer_email && (
                <div style={{ fontSize: '0.85rem', color: '#6a4f2a' }}>
                  {receipt.customer_email}
                </div>
              )}
              {receipt.customer_phone && (
                <div style={{ fontSize: '0.85rem', color: '#6a4f2a' }}>
                  {receipt.customer_phone}
                </div>
              )}
              <div
                style={{
                  borderTop: '1px dashed #e5cfa2',
                  marginTop: 12,
                  paddingTop: 12,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                }}
              >
                {receipt.line_items.map((it, i) => (
                  <div
                    key={i}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      fontSize: '0.92rem',
                      color: '#3c2a12',
                      gap: 12,
                    }}
                  >
                    <div>
                      {it.description}
                      {it.quantity > 1 && it.unit_amount_cents ? (
                        <span
                          style={{ color: '#8c6a38', fontSize: '0.8rem', marginLeft: 6 }}
                        >
                          × {it.quantity} @ ${(it.unit_amount_cents / 100).toFixed(2)}
                        </span>
                      ) : it.quantity > 1 ? (
                        <span style={{ color: '#8c6a38', fontSize: '0.8rem', marginLeft: 6 }}>
                          × {it.quantity}
                        </span>
                      ) : null}
                    </div>
                    <b>${(it.amount_total_cents / 100).toFixed(2)}</b>
                  </div>
                ))}
              </div>
              <div
                style={{
                  borderTop: '1px dashed #e5cfa2',
                  marginTop: 12,
                  paddingTop: 12,
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                }}
              >
                <div style={{ fontWeight: 700, color: '#3c2a12' }}>Total paid</div>
                <div style={{ fontSize: '1.1rem', fontWeight: 800, color: '#a65f1c' }}>
                  ${(receipt.amount_total_cents / 100).toFixed(2)}{' '}
                  <span
                    style={{
                      fontSize: '0.7rem',
                      color: '#9a6d2d',
                      textTransform: 'uppercase',
                    }}
                  >
                    {receipt.currency}
                  </span>
                </div>
              </div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  marginTop: 14,
                  fontSize: '0.8rem',
                  color: '#8c6a38',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: 8,
                }}
              >
                <span>
                  Status:{' '}
                  {receipt.payment_status === 'paid' ? (
                    <span
                      className="tag promo tag--ok"
                      style={{ marginLeft: 4 }}
                    >
                      Paid ✓
                    </span>
                  ) : receipt.payment_status === 'unpaid' ? (
                    <span
                      className="tag promo-hint"
                      style={{ color: '#861d1d', background: '#fdecec', marginLeft: 4 }}
                    >
                      Unpaid
                    </span>
                  ) : receipt.payment_status === 'no_payment_required' ? (
                    <span className="tag promo tag--ok" style={{ marginLeft: 4 }}>
                      No payment required
                    </span>
                  ) : (
                    <span className="tag promo-hint" style={{ marginLeft: 4 }}>
                      Processing…
                    </span>
                  )}
                </span>
                {receipt.payment_intent_id && (
                  <span style={{ color: '#9a6d2d' }}>
                    Payment: {receipt.payment_intent_id.slice(0, 14)}…
                  </span>
                )}
              </div>
              {(receipt.receipt_url || receipt.session_id) && (
                <div
                  style={{
                    marginTop: 14,
                    display: 'flex',
                    justifyContent: 'center',
                    gap: 10,
                    flexWrap: 'wrap',
                  }}
                >
                  {receipt.receipt_url && (
                    <a
                      className="button button--secondary"
                      href={receipt.receipt_url}
                      target="_blank"
                      rel="noreferrer noopener"
                      style={{ textDecoration: 'none' }}
                    >
                      Open Stripe receipt (PDF view)
                    </a>
                  )}
                  {receipt.session_id && receipt.payment_status &&
                    receipt.payment_status !== 'paid' && (
                      <button
                        type="button"
                        className="button button--primary"
                        onClick={() => navigate('/order', { replace: true })}
                      >
                        Return to order &amp; pay now
                      </button>
                    )}
                </div>
              )}
            </div>
          )}
          {sessionId && receipt.loaded && !receipt.ok && (
            <div
              style={{
                marginTop: 18,
                maxWidth: 520,
                marginLeft: 'auto',
                marginRight: 'auto',
                padding: '12px 14px',
                borderRadius: 14,
                fontSize: '0.88rem',
                background: '#fdecec',
                color: '#861d1d',
              }}
            >
              We couldn't load the Stripe receipt right now: {receipt.error || 'unknown error'}.
              Your Order Reference number <b>{ref || 'n/a'}</b> is still recorded — Astrid or Portia will
              manually confirm your payment.
            </div>
          )}

          {type !== 'collab' && type !== 'feedback' && (
            <p style={{ marginTop: '18px' }}>
              <Link className="cta" to="/feedback">
                Enjoyed your brownies? Leave a review &amp; join Buffy Insiders!
              </Link>
            </p>
          )}
          <p style={{ marginTop: '22px' }}>
            <Link className="button button--primary" to="/product">
              Back to product
            </Link>
          </p>
        </section>
      </div>
    </>
  )
}

function AdminRouteGuard({ children }: { children: ReactElement | ReactNode }) {
  const nav = useNavigate()
  const loc = useLocation()
  useEffect(() => {
    const s = getAdminSession()
    if (!s) {
      const opts: NavigateOptions = { replace: true }
      const to = '/admin-login?next=' + encodeURIComponent(loc.pathname + loc.search)
      nav(to, opts)
    }
  }, [nav, loc.pathname, loc.search])
  return children
}

function AdminLoginPage() {
  const [params] = useSearchParams()
  const nav = useNavigate()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [loggedIn, setLoggedIn] = useState(() => !!getAdminSession())

  useEffect(() => {
    document.body.dataset.buffyGreeting = 'Admin access — enter credentials below 🔒'
    return () => {
      delete document.body.dataset.buffyGreeting
    }
  }, [])

  useEffect(() => {
    if (loggedIn) nav('/admin-backend', { replace: true })
  }, [loggedIn, nav])

  const handleSubmit = async (ev: React.FormEvent) => {
    ev.preventDefault()
    setErr(null)
    setSubmitting(true)
    try {
      const ok = await verifyAdminLogin(username.trim(), password)
      if (!ok) {
        setErr('Invalid username or password.')
        return
      }
      saveAdminSession(username.trim(), 8)
      setLoggedIn(true)
      const next = params.get('next') || '/admin-backend'
      nav(next, { replace: true })
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Login failed.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="page-stack admin-page">
      <section className="card section-card admin-card">
        <p className="section-label">Built By Bakes</p>
        <h1>Admin login</h1>
        <p className="body">
          Restricted area for Astrid and Portia — manage weekly limits, promo codes, and
          view all placed orders.
        </p>
        <form className="admin-form" onSubmit={handleSubmit}>
          <label>
            <span>Username</span>
            <input
              id="admin-login-username"
              name="admin_username"
              type="text"
              autoComplete="username"
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </label>
          <label>
            <span>Password</span>
            <input
              id="admin-login-password"
              name="admin_password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {err && (
            <div className="admin-err" role="alert">
              {err}
            </div>
          )}
          <button
            className="button button--primary button--large"
            type="submit"
            style={{ width: '100%' }}
            disabled={submitting}
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
          <p className="hint" style={{ textAlign: 'center' }}>
            Lost access? Reset <code>{ADMIN_SESSION_KEY}</code> from the Supabase console.
          </p>
        </form>
      </section>
    </div>
  )
}

/**
 * Convert an ISO timestamp (UTC from Supabase) to the `datetime-local`
 * `<input type="datetime-local">` format (YYYY-MM-DDTHH:mm) rendered in
 * the admin user's browser-local timezone.
 */
function toLocalDatetimeInput(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => n.toString().padStart(2, '0')
  return (
    d.getFullYear() +
    '-' +
    pad(d.getMonth() + 1) +
    '-' +
    pad(d.getDate()) +
    'T' +
    pad(d.getHours()) +
    ':' +
    pad(d.getMinutes())
  )
}

function AdminBackendPage() {
  const nav = useNavigate()
  const session = getAdminSession()
  // NOTE: supabaseAdmin() in the browser now intentionally returns null.
  // All admin writes/reads (promos/orders CRUD, limits edits, banner save)
  // route through adminGateway() → /api/admin-gateway Netlify Function.
  // The `adminClient` variable is preserved only so existing references to
  // "if (!adminClient) return" (now always-true guards for browser-side DB
  // access) act as canaries — any path that forgets to go through the
  // gateway will short-circuit visibly.
  const adminClient: null = null
  void adminClient
  const [tab, setTab] = useState<'limits' | 'promos' | 'orders' | 'banner'>('limits')

  // Weekly limits state — single-row canonical model (id = limitsWriteId always).
  // Only MAX brownies is user-editable. Sold is updated atomically by
  // increment_weekly_sold() on each order, and reset to 0 each Thursday
  // before the next Friday drop (auto reset + big manual button).
  // limitsWriteId = actual Postgres row id (NOT hardcoded 1) — fixes the
  // mismatch if the original 0001_init used a sequence-assigned id > 1.
  const [limits, setLimits] = useState<WeeklyLimitsRow | null>(null)
  const [initialLimitsLoaded, setInitialLimitsLoaded] = useState(false)
  const [limitsWriteId, setLimitsWriteId] = useState<number | null>(null)
  const [maxBrownies, setMaxBrownies] = useState(100)
  const [saveLimitsMsg, setSaveLimitsMsg] = useState<string | null>(null)

  // Promo state
  const [promos, setPromos] = useState<PromoCodeRow[]>([])
  const [initialPromosLoaded, setInitialPromosLoaded] = useState(false)
  const [newCode, setNewCode] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [newType, setNewType] = useState<'percent' | 'fixed' | 'unit_price'>('percent')
  const [newValue, setNewValue] = useState(0.1)
  const [newActive, setNewActive] = useState(true)
  const [newMaxUses, setNewMaxUses] = useState<number | ''>('')
  const [promoMsg, setPromoMsg] = useState<string | null>(null)

  // Orders state
  const [orders, setOrders] = useState<OrderRow[]>([])
  const [initialOrdersLoaded, setInitialOrdersLoaded] = useState(false)
  const thisWeek = useMemo(() => bbbWeekContaining(Date.now()), [])
  const [ordersFrom, setOrdersFrom] = useState<string>(thisWeek.startYmd)
  const [ordersTo, setOrdersTo] = useState<string>(thisWeek.endYmd)
  const [ordersMsg, setOrdersMsg] = useState<string | null>(null)
  const ordersRange: OrderExportRange = {
    startYmd: ordersFrom || null,
    endYmd: ordersTo || null,
  }
  const filteredOrders = useMemo(
    () => ordersInRange(orders, ordersRange),
    [orders, ordersRange],
  )
  const resetToThisWeek = () => {
    const w = bbbWeekContaining(Date.now())
    setOrdersFrom(w.startYmd)
    setOrdersTo(w.endYmd)
  }

  // Banner state
  const [banner, setBanner] = useState<SalesBannerRow | null>(null)
  const [initialBannerLoaded, setInitialBannerLoaded] = useState(false)
  const [bannerMessage, setBannerMessage] = useState('')
  const [bannerActive, setBannerActive] = useState(true)
  const [bannerStart, setBannerStart] = useState<string>('')
  const [bannerEnd, setBannerEnd] = useState<string>('')
  const [bannerMsg, setBannerMsg] = useState<string | null>(null)

  const [gatewayErr, setGatewayErr] = useState<string | null>(null)

  // Hydrate lock — REF-BASED so it survives React StrictMode double-effects,
  // React Router re-mounts, and accidental isInitial=true re-passes. Each key
  // flips true ONCE after the first successful load of that slice of data;
  // subsequent loadAll() calls refresh READ-ONLY lists (promos / orders) but
  // NEVER overwrite controlled form state the user is actively editing. This
  // is what fixes the "click on banner message / dates / toggle and it
  // reverts to the original value" symptom: loadAll used to stomp on
  // bannerMessage/bannerStart/bannerEnd with freshly fetched DB data in a
  // race with the user's click/keystroke, and React reconciled the stale
  // controlled value back into the input.
  const hydrateDoneRef = useRef<{ limits: boolean; banner: boolean; orders: boolean }>({
    limits: false,
    banner: false,
    orders: false,
  })

  const loadAll = async () => {
    setGatewayErr(null)
    const [limGW, promGW, ordGW, bannerGW] = await Promise.all([
      adminGateway<WeeklyLimitsRow | null>('loadLimitsEnsure', 100),
      adminGateway<{ data: PromoCodeRow[] }>('loadPromos'),
      adminGateway<{ data: OrderRow[] }>('loadOrders', { limit: 200 }),
      adminGateway<SalesBannerRow | null>('loadBanner'),
    ])
    const allFailed =
      !limGW.ok && !promGW.ok && !ordGW.ok && !bannerGW.ok &&
      (limGW as { ok: false; error: string }).error === (promGW as { ok: false; error: string }).error
    if (allFailed) {
      const errText = (limGW as { ok: false; error: string }).error
      if (import.meta.env.DEV && errText.includes('adminGateway network error')) {
        setGatewayErr(
          'Running in plain vite dev (no Netlify Functions). Admin backend data cannot load locally until you run `npx netlify dev` instead of `npm run dev`. Netlify Dev starts both the Vite UI AND the local /api/admin-gateway function emulator on http://localhost:8888 — browse there instead. Underlying error: ' +
            errText,
        )
      } else if (import.meta.env.DEV) {
        setGatewayErr('Admin gateway returned errors — check terminal/Netlify function logs. First fail: ' + errText)
      } else {
        setGatewayErr(
          'Admin backend service unavailable — please refresh the page or contact Astrid / Portia if this persists.',
        )
      }
    } else if (!limGW.ok || !promGW.ok || !ordGW.ok || !bannerGW.ok) {
      const errs: string[] = []
      if (!limGW.ok) errs.push('limits=' + (limGW as { ok: false; error: string }).error)
      if (!promGW.ok) errs.push('promos=' + (promGW as { ok: false; error: string }).error)
      if (!ordGW.ok) errs.push('orders=' + (ordGW as { ok: false; error: string }).error)
      if (!bannerGW.ok) errs.push('banner=' + (bannerGW as { ok: false; error: string }).error)
      setGatewayErr('Partial gateway failure — some admin data may not have loaded. ' + errs.join('; '))
    }
    const limRes = limGW.ok ? limGW.data : null
    const promRes = promGW.ok ? { data: promGW.data.data } : { data: null }
    const ordRes = ordGW.ok ? { data: ordGW.data.data } : { data: null }
    const bannerRes = bannerGW.ok ? bannerGW.data : null
    if (limRes) {
      const row = limRes
      if (!hydrateDoneRef.current.limits) {
        hydrateDoneRef.current.limits = true
        setLimits(row)
        setLimitsWriteId(Number(row.id))
        setMaxBrownies(Number(row.max_brownies))
        setInitialLimitsLoaded(true)
      }
      try {
        const nowSgMs = Date.now() + 8 * 60 * 60 * 1000
        const nowSgDay = new Date(nowSgMs).getUTCDay()
        if (nowSgDay === 4) {
          const updated = row.updated_at ? new Date(row.updated_at).getTime() : 0
          const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
          if (updated < sevenDaysAgo && Number(row.sold_brownies) > 0) {
            const { row: resetRow, error: resetErr } = await adminResetSoldForNewWeek(
              Number(row.id),
            )
            if (resetRow) {
              setLimits((prev) => {
                if (!prev) return resetRow
                return {
                  ...prev,
                  sold_brownies: resetRow.sold_brownies,
                  updated_at: resetRow.updated_at,
                }
              })
              setSaveLimitsMsg(
                '🔄 Auto-reset sold count for the new Friday drop week (sold → 0).',
              )
            } else if (resetErr) {
              setSaveLimitsMsg('⚠️ Auto reset attempted but failed: ' + resetErr)
            }
          }
        }
      } catch (e) {
        console.warn('[admin] weekly Thursday auto-reset check skipped:', e)
      }
    }
    if (promRes.data) setPromos(promRes.data as PromoCodeRow[])
    if (ordRes.data && !hydrateDoneRef.current.orders) {
      hydrateDoneRef.current.orders = true
      setOrders(ordRes.data as OrderRow[])
    }
    if (bannerRes) {
      if (!hydrateDoneRef.current.banner) {
        hydrateDoneRef.current.banner = true
        setBanner(bannerRes)
        setBannerMessage(bannerRes.message)
        setBannerActive(!!bannerRes.is_active)
        setBannerStart(bannerRes.start_at ? toLocalDatetimeInput(bannerRes.start_at) : '')
        setBannerEnd(bannerRes.end_at ? toLocalDatetimeInput(bannerRes.end_at) : '')
        setInitialBannerLoaded(true)
      }
    }
    setInitialPromosLoaded(true)
    setInitialOrdersLoaded(true)
  }

  const refreshAll = async () => {
    hydrateDoneRef.current = { limits: false, banner: false, orders: false }
    await loadAll()
  }

  const deleteOrdersBeforeThisWeek = async () => {
    setOrdersMsg(null)
    const wStartIso = new Date(thisWeek.startMs).toISOString()
    const beforeCount = orders.filter(
      (o) => new Date(o.created_at).getTime() < thisWeek.startMs,
    ).length
    const humanDate = new Date(thisWeek.startMs + 8 * 60 * 60 * 1000).toLocaleString([], {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
    const sure = window.confirm(
      'Delete all orders created BEFORE the start of this drop week?\n\n' +
        'This week opened on: ' +
        humanDate +
        ' SG time (Thu 00:00).\n' +
        'Currently visible old orders: ' +
        String(beforeCount) +
        '\n\nThis action is IRREVERSIBLE — data is permanently deleted from Supabase.\n' +
        "Export the range as Excel first if you'd like to keep records.",
    )
    if (!sure) return
    const { deleted, error } = await adminDeleteOrdersBefore(wStartIso)
    if (error) {
      setOrdersMsg('✗ Delete failed: ' + error)
      return
    }
    setOrders((prev) =>
      prev.filter((o) => new Date(o.created_at).getTime() >= thisWeek.startMs),
    )
    setOrdersMsg(
      '🗑️ Deleted ' +
        String(deleted) +
        ' order' +
        (deleted === 1 ? '' : 's') +
        ' before ' +
        humanDate +
        ' (only this week now visible).',
    )
  }

  useEffect(() => {
    if (!session) {
      nav('/admin-login', { replace: true })
      return
    }
    void loadAll()
    document.body.dataset.buffyGreeting = 'Welcome back — manage the bakery 🍫'
    return () => {
      delete document.body.dataset.buffyGreeting
    }
  }, [nav, session])

  const saveMaxBrownies = async () => {
    setSaveLimitsMsg(null)
    if (limitsWriteId == null) {
      setSaveLimitsMsg(
        '✗ Write-target row not loaded yet — wait for the page to finish loading then try again. Click Refresh tab data below to reload.',
      )
      return
    }
    const snapshot = limits
    const newMax = Math.max(0, Math.floor(maxBrownies || 0))
    if (snapshot) {
      // Optimistic local update — prevents flash of "loading → data".
      setLimits({ ...snapshot, max_brownies: newMax })
    }
    const { row: canonical, error } = await adminUpdateMaxBrownies(limitsWriteId, newMax)
    if (error || !canonical) {
      if (snapshot) setLimits(snapshot)
      void loadAll()
      setSaveLimitsMsg(
        '✗ Failed to save max brownies: ' +
          (error ?? 'DB returned no updated row.') +
          ' If Postgres code=42501 → missing RLS write policy for service role (unlikely).',
      )
    } else {
      setLimits(canonical)
      setLimitsWriteId(Number(canonical.id))
      setMaxBrownies(Number(canonical.max_brownies))
      setSaveLimitsMsg(
        '✓ Weekly cap saved — max=' +
          canonical.max_brownies +
          ' brownies, sold=' +
          canonical.sold_brownies +
          '. Row id=' +
          canonical.id +
          '. Next Friday drop keeps this cap until you change it.',
      )
    }
  }

  const resetSoldForNewWeek = async () => {
    if (limitsWriteId == null) {
      setSaveLimitsMsg(
        '✗ Write-target row not loaded yet — wait for the page to finish loading then try again.',
      )
      return
    }
    const sure = window.confirm(
      'Reset sold count to 0 for the new Friday drop week?\n\nMAX brownies (' +
        String(Number(limits?.max_brownies ?? 0)) +
        ') will NOT be changed — it carries over to the next week.',
    )
    if (!sure) return
    setSaveLimitsMsg(null)
    const { row: canonical, error } = await adminResetSoldForNewWeek(limitsWriteId)
    if (error || !canonical) {
      setSaveLimitsMsg(
        '✗ Failed to reset sold count: ' + (error ?? 'DB returned no updated row.'),
      )
      void loadAll()
    } else {
      setLimits(canonical)
      setLimitsWriteId(Number(canonical.id))
      setSaveLimitsMsg(
        '🔄 Sold count reset to 0 for the new week. Max cap stays at ' +
          canonical.max_brownies +
          ' until you edit it. Row id=' +
          canonical.id,
      )
    }
  }

  const addPromo = async () => {
    setPromoMsg(null)
    const code = newCode.trim().toUpperCase()
    if (!code || !newLabel) {
      setPromoMsg('✗ Code and label are required.')
      return
    }
    const val = Number(newValue)
    if (isNaN(val) || val < 0) {
      setPromoMsg('✗ Invalid discount value.')
      return
    }
    if (newType === 'percent' && val > 1) {
      setPromoMsg('✗ Percent value should be 0–1 (e.g. 0.10 = 10%).')
      return
    }
    if (newType === 'unit_price' && val >= BBB.UNIT_PRICE) {
      setPromoMsg(`✗ Unit price must be below SGD ${BBB.UNIT_PRICE.toFixed(2)} to create a discount.`)
      return
    }
    const insertRow: PromoCodeRow = {
      id: -Math.floor(Math.random() * 1e9),
      code,
      label: newLabel,
      discount_type: newType,
      discount_value: val,
      is_active: newActive,
      max_uses: newMaxUses === '' ? null : Number(newMaxUses),
      used_count: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as PromoCodeRow
    setPromos((prev) => [insertRow, ...prev])
    setNewCode('')
    setNewLabel('')
    setNewType('percent')
    setNewValue(0.1)
    setNewActive(true)
    setNewMaxUses('')
    const gwRes = await adminGateway<{ data: PromoCodeRow | null; error: string | null }>('addPromo', {
      code,
      label: newLabel,
      discount_type: newType,
      discount_value: val,
      is_active: newActive,
      max_uses: newMaxUses === '' ? null : Number(newMaxUses),
    })
    if (!gwRes.ok || gwRes.data.error) {
      void loadAll()
      setPromoMsg('✗ ' + (gwRes.ok ? gwRes.data.error : gwRes.error))
    } else {
      setPromoMsg('✓ Promo code added.')
      const data = gwRes.data.data
      if (data) {
        setPromos((prev) =>
          prev.map((p) => (p.id === insertRow.id ? (data as PromoCodeRow) : p)),
        )
      }
    }
  }

  const updatePromoField = async (
    id: number,
    patch: Partial<PromoCodeRow>,
  ) => {
    const snapshot = promos
    const allPatches: Partial<PromoCodeRow> = {
      ...patch,
      updated_at: new Date().toISOString(),
    }
    setPromos((prev) =>
      prev.map((p) => (p.id === id ? { ...p, ...allPatches } : p)),
    )
    const gwRes = await adminGateway<{ data: PromoCodeRow | null; error: string | null }>('updatePromo', { id, patch: allPatches })
    if (!gwRes.ok || gwRes.data.error) {
      setPromoMsg('✗ Update failed: ' + (gwRes.ok ? gwRes.data.error : gwRes.error))
      setPromos(snapshot)
    } else if (gwRes.data.data) {
      const data = gwRes.data.data
      setPromos((prev) =>
        prev.map((p) => (p.id === id ? (data as PromoCodeRow) : p)),
      )
    }
  }

  const deletePromo = async (id: number) => {
    const sure = window.confirm('Delete this promo code? This cannot be undone.')
    if (!sure) return
    const snapshot = promos
    setPromos((prev) => prev.filter((p) => p.id !== id))
    const gwRes = await adminGateway<{ ok: boolean; error: string | null }>('deletePromo', { id })
    if (!gwRes.ok || gwRes.data.error) {
      setPromoMsg('✗ Delete failed: ' + (gwRes.ok ? gwRes.data.error : gwRes.error))
      setPromos(snapshot)
    }
  }

  const updateOrderStatus = async (id: number, status: string) => {
    const snapshot = orders
    const shapedStatus = status as OrderRow['status']
    setOrders((prev) =>
      prev.map((o) =>
        o.id === id
          ? { ...o, status: shapedStatus }
          : o,
      ),
    )
    const gwRes = await adminGateway<{ ok: boolean; error: string | null }>('updateOrderStatus', { id, status: shapedStatus })
    if (!gwRes.ok || gwRes.data.error) {
      console.warn('[admin] order status update failed:', gwRes.ok ? gwRes.data.error : gwRes.error)
      setOrders(snapshot)
    }
  }

  const saveBanner = async () => {
    setBannerMsg(null)
    const trimmed = bannerMessage.trim()
    if (!trimmed) {
      setBannerMsg('✗ Banner message cannot be empty.')
      return
    }
    // Interpret datetime-local values as the admin's own LOCAL wall-clock time
    // (SG timezone usually), not UTC. new Date(string without timezone) treats
    // the value as local → toISOString correctly shifts to UTC before writing.
    const start_iso: string | null = bannerStart ? new Date(bannerStart).toISOString() : null
    const end_iso: string | null = bannerEnd ? new Date(bannerEnd).toISOString() : null
    if (start_iso && end_iso && new Date(start_iso).getTime() > new Date(end_iso).getTime()) {
      setBannerMsg('✗ End date/time must be after start date/time.')
      return
    }
    // Optimistic local update
    const optimisticRow: SalesBannerRow = {
      id: banner?.id ?? 1,
      message: trimmed,
      is_active: bannerActive,
      start_at: start_iso,
      end_at: end_iso,
      created_at: banner?.created_at ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    setBanner(optimisticRow)
    const saved = await adminSaveBanner({
      message: trimmed,
      is_active: bannerActive,
      start_at: start_iso,
      end_at: end_iso,
    })
    if (!saved) {
      setBannerMsg(
        '✗ Failed to save banner — check Netlify admin-gateway function and RLS policies; retrying…',
      )
      void loadAll()
    } else {
      setBanner(saved)
      setBannerMessage(saved.message)
      setBannerActive(!!saved.is_active)
      setBannerStart(saved.start_at ? toLocalDatetimeInput(saved.start_at) : '')
      setBannerEnd(saved.end_at ? toLocalDatetimeInput(saved.end_at) : '')
      setBannerMsg(
        '✓ Banner saved. ' +
          (saved.is_active
            ? 'Active = ON'
            : 'Hidden / OFF (deactivated, overrides schedule)') +
          '. Storefront shows on next page reload.',
      )
    }
  }

  const logout = () => {
    clearAdminSession()
    nav('/admin-login', { replace: true })
  }

  if (!session) return null

  return (
    <div className="page-stack admin-page">
      {gatewayErr ? (
        <div
          className="card"
          style={{
            border: '1px solid #eab308',
            background: '#fef9c3',
            marginBottom: 0,
            color: '#854d0e',
          }}
        >
          <p className="section-label" style={{ color: '#854d0e' }}>
            Admin Backend
          </p>
          <h2 style={{ marginTop: 0, marginBottom: 8, color: '#854d0e' }}>
            ⚠️ Gateway diagnostics
          </h2>
          <p className="body" style={{ margin: 0, color: '#854d0e', whiteSpace: 'pre-wrap' }}>
            {gatewayErr}
          </p>
        </div>
      ) : null}
      <section className="card section-card admin-header">
        <div className="admin-header__row">
          <div>
            <p className="section-label">Admin dashboard</p>
            <h1>Built By Bakes · backend</h1>
            <p className="body">
              Signed in as <b>{session.user}</b>.
            </p>
          </div>
          <div className="admin-header__actions">
            <button className="button" onClick={() => void refreshAll()}>
              Refresh all data
            </button>
            <button className="button" onClick={logout}>
              Sign out
            </button>
          </div>
        </div>
        <nav className="admin-tabs" role="tablist">
          <button
            className={tab === 'limits' ? 'admin-tab admin-tab--active' : 'admin-tab'}
            onClick={() => setTab('limits')}
            type="button"
            role="tab"
          >
            Weekly limit
          </button>
          <button
            className={tab === 'promos' ? 'admin-tab admin-tab--active' : 'admin-tab'}
            onClick={() => setTab('promos')}
            type="button"
            role="tab"
          >
            Promo codes
          </button>
          <button
            className={tab === 'orders' ? 'admin-tab admin-tab--active' : 'admin-tab'}
            onClick={() => setTab('orders')}
            type="button"
            role="tab"
          >
            Orders
          </button>
          <button
            className={tab === 'banner' ? 'admin-tab admin-tab--active' : 'admin-tab'}
            onClick={() => setTab('banner')}
            type="button"
            role="tab"
          >
            Banner
          </button>
        </nav>
      </section>

      {tab === 'limits' && (
        <section className="card admin-card">
          <p className="section-label">Weekly baking capacity</p>
          <h2>Adjust how many brownies you can bake each Friday drop.</h2>
          <p className="body" style={{ marginTop: -8 }}>
            The <b>Max brownies</b> value carries over week to week until you change
            it. <b>Sold</b> increments automatically on every order submission and
            resets to 0 every Thursday (auto + manual button below) for the next
            Friday drop.
          </p>
          {!initialLimitsLoaded ? (
            <div className="skeleton-block" style={{ marginTop: 18 }}>
              <div className="skeleton skeleton--form" />
              <div className="skeleton skeleton--meter" />
            </div>
          ) : (
            <div className="admin-grid" style={{ marginTop: 14 }}>
              <label>
                <span>Max brownies each drop</span>
                <input
                  id="admin-limits-max-brownies"
                  name="max_brownies"
                  type="number"
                  min={0}
                  step={1}
                  value={maxBrownies}
                  onChange={(e) => setMaxBrownies(Number(e.target.value))}
                />
                <span className="hint">
                  Saved permanently. Carries over to future Fridays until edited.
                </span>
              </label>

              <div className="admin-metric">
                <div>
                  <b>{Number(limits?.sold_brownies ?? 0)}</b>
                  <span className="body"> sold so far this week</span>
                </div>
                <div className="admin-meter" role="progressbar">
                  <div
                    className="admin-meter__fill"
                    style={{
                      width:
                        maxBrownies > 0
                          ? Math.min(
                              100,
                              (Number(limits?.sold_brownies ?? 0) / maxBrownies) * 100,
                            ) + '%'
                          : '0%',
                    }}
                  />
                </div>
                <div style={{ marginTop: 8, fontSize: '0.82rem', color: '#6b4f2f' }}>
                  <b>
                    {Math.max(
                      0,
                      maxBrownies - Number(limits?.sold_brownies ?? 0),
                    )}
                  </b>{' '}
                  brownies remaining (of {maxBrownies} cap)
                </div>
              </div>

              {saveLimitsMsg && (
                <div
                  className={
                    'admin-save ' +
                    (saveLimitsMsg.startsWith('✓') || saveLimitsMsg.startsWith('🔄')
                      ? 'admin-save--ok'
                      : 'admin-save--err')
                  }
                  style={{ gridColumn: '1 / -1' }}
                >
                  {saveLimitsMsg}
                </div>
              )}

              <button
                className="button button--primary"
                onClick={() => void saveMaxBrownies()}
              >
                Save max brownies cap
              </button>
              <button
                className="button"
                onClick={() => void resetSoldForNewWeek()}
                type="button"
              >
                🔄 Reset sold count for new Friday drop
              </button>
            </div>
          )}
        </section>
      )}

      {tab === 'promos' && (
        <section className="card admin-card">
          <p className="section-label">Promo codes</p>
          <h2>Create, enable, or archive promotional discounts.</h2>
          <div className="admin-grid admin-grid--wide">
            <label>
              <span>Code</span>
              <input
                id="admin-promo-new-code"
                name="new_promo_code"
                type="text"
                placeholder=""
                value={newCode}
                onChange={(e) => setNewCode(e.target.value)}
              />
            </label>
            <label>
              <span>Label</span>
              <input
                id="admin-promo-new-label"
                name="new_promo_label"
                type="text"
                placeholder="10% off (Opening Sale)"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
              />
            </label>
            <label>
              <span>Discount type</span>
              <select
                id="admin-promo-new-type"
                name="new_promo_type"
                value={newType}
                onChange={(e) => setNewType(e.target.value as 'percent' | 'fixed' | 'unit_price')}
              >
                <option value="percent">Percent of subtotal (0.10 = 10%)</option>
                <option value="fixed">Fixed SGD off subtotal</option>
                <option value="unit_price">Per-brownie unit price (SGD per brownie)</option>
              </select>
            </label>
            <label>
              <span>Discount value</span>
              <input
                id="admin-promo-new-value"
                name="new_promo_value"
                type="number"
                step="0.01"
                min={0}
                value={newValue}
                onChange={(e) => setNewValue(Number(e.target.value))}
              />
            </label>
            <label>
              <span>Active</span>
              <select
                id="admin-promo-new-active"
                name="new_promo_active"
                value={newActive ? '1' : '0'}
                onChange={(e) => setNewActive(e.target.value === '1')}
              >
                <option value="1">Yes — customers can redeem it</option>
                <option value="0">No — hidden until enabled</option>
              </select>
            </label>
            <label>
              <span>Max uses (optional)</span>
              <input
                id="admin-promo-new-maxuses"
                name="new_promo_max_uses"
                type="number"
                min={0}
                step={1}
                value={newMaxUses}
                onChange={(e) =>
                  setNewMaxUses(e.target.value === '' ? '' : Number(e.target.value))
                }
              />
            </label>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
            <button className="button button--primary" onClick={addPromo}>
              Add promo code
            </button>
          </div>
          {promoMsg && (
            <div
              className={'admin-save ' + (promoMsg.startsWith('✓') ? 'admin-save--ok' : 'admin-save--err')}
            >
              {promoMsg}
            </div>
          )}

          <h3 style={{ marginTop: 28 }}>Existing codes</h3>
          {!initialPromosLoaded ? (
            <div className="skeleton-block">
              {Array.from({ length: 3 }).map((_, i) => (
                <div className="skeleton skeleton--promo-row" key={i} />
              ))}
            </div>
          ) : promos.length === 0 ? (
            <p className="body">No promo codes yet — add one above.</p>
          ) : (
            <div className="promo-table promo-table--extended">
              {promos.map((p) => (
                <div className="promo-row" key={p.id}>
                  <div className="promo-row__col">
                    <b className="promo-row__code">{p.code}</b>
                    <label style={{ display: 'block', marginTop: '10px' }}>
                      <span>Title (visible in order summary)</span>
                      <input
                        name="promo_label"
                        type="text"
                        value={p.label}
                        onChange={(e) =>
                          void updatePromoField(p.id, { label: e.target.value })
                        }
                      />
                    </label>
                  </div>
                  <div className="promo-row__col promo-row__edit">
                    <label>
                      <span>Type</span>
                      <select
                        name="promo_type"
                        value={p.discount_type}
                        onChange={(e) =>
                          void updatePromoField(p.id, {
                            discount_type: e.target.value as 'percent' | 'fixed' | 'unit_price',
                          })
                        }
                      >
                        <option value="percent">Percent</option>
                        <option value="fixed">Fixed SGD</option>
                        <option value="unit_price">$ / brownie</option>
                      </select>
                    </label>
                    <label>
                      <span>Value</span>
                      <input
                        name="promo_value"
                        type="number"
                        step="0.01"
                        min={0}
                        value={Number(p.discount_value)}
                        onChange={(e) =>
                          void updatePromoField(p.id, {
                            discount_value: Number(e.target.value),
                          })
                        }
                      />
                    </label>
                    <label>
                      <span>Active</span>
                      <select
                        name="promo_active"
                        value={p.is_active ? '1' : '0'}
                        onChange={(e) =>
                          void updatePromoField(p.id, {
                            is_active: e.target.value === '1',
                          })
                        }
                      >
                        <option value="1">Yes</option>
                        <option value="0">No</option>
                      </select>
                    </label>
                    <label>
                      <span>Max uses</span>
                      <input
                        name="promo_max_uses"
                        type="number"
                        min={0}
                        step={1}
                        placeholder="blank = unlimited"
                        value={p.max_uses == null ? '' : String(p.max_uses)}
                        onChange={(e) => {
                          const raw = e.target.value
                          if (raw.trim() === '') {
                            void updatePromoField(p.id, { max_uses: null })
                          } else {
                            void updatePromoField(p.id, { max_uses: Number(raw) })
                          }
                        }}
                      />
                    </label>
                    <label>
                      <span>Uses {p.used_count}/{p.max_uses ?? '∞'}</span>
                      <span className="hint">Used count increments automatically on orders.</span>
                    </label>
                  </div>
                  <div className="promo-row__col promo-row__dates">
                    <label>
                      <span>Valid from (date + time)</span>
                      <input
                        name="promo_valid_from"
                        type="datetime-local"
                        value={p.valid_from ? toLocalDatetimeInput(p.valid_from) : ''}
                        onChange={(e) =>
                          void updatePromoField(p.id, {
                            valid_from: e.target.value
                              ? new Date(e.target.value).toISOString()
                              : null,
                          })
                        }
                      />
                      <span className="hint">Leave blank to enable immediately when Active = Yes.</span>
                    </label>
                    <label>
                      <span>Valid until (date + time)</span>
                      <input
                        name="promo_valid_until"
                        type="datetime-local"
                        value={p.valid_until ? toLocalDatetimeInput(p.valid_until) : ''}
                        onChange={(e) =>
                          void updatePromoField(p.id, {
                            valid_until: e.target.value
                              ? new Date(e.target.value).toISOString()
                              : null,
                          })
                        }
                      />
                      <span className="hint">Leave blank to keep promo active indefinitely.</span>
                    </label>
                  </div>
                  <div className="promo-row__col">
                    <button
                      className="button button--ghost"
                      onClick={() => void deletePromo(p.id)}
                      type="button"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {tab === 'orders' && (
        <section className="card admin-card">
          <p className="section-label">Customer orders</p>
          <h2>All placed orders (newest first).</h2>

          <div className="admin-grid admin-grid--wide" style={{ marginTop: 16 }}>
            <label>
              <span>Start date (incl., SG time)</span>
              <input
                id="admin-orders-filter-from"
                name="orders_from_date"
                type="date"
                value={ordersFrom}
                onChange={(e) => setOrdersFrom(e.target.value)}
              />
              <span className="hint">Leave blank to include everything from day 1.</span>
            </label>
            <label>
              <span>End date (incl., SG time)</span>
              <input
                id="admin-orders-filter-to"
                name="orders_to_date"
                type="date"
                value={ordersTo}
                onChange={(e) => setOrdersTo(e.target.value)}
              />
              <span className="hint">Leave blank to include everything until now.</span>
            </label>
            <div
              style={{
                gridColumn: '1 / -1',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                flexWrap: 'wrap',
                marginTop: 4,
              }}
            >
              <button
                type="button"
                onClick={() => void deleteOrdersBeforeThisWeek()}
                className="button button--small"
                style={{ background: '#f9e6e6', color: '#9e1e1e' }}
              >
                🗑️ Delete orders before this week
              </button>
              <button
                type="button"
                onClick={resetToThisWeek}
                className="button button--small"
              >
                Reset to this week (Thu→Wed SG)
              </button>
              <button
                type="button"
                onClick={() =>
                  downloadOrdersExcel(filteredOrders, {
                    ...ordersRange,
                    weekLabel: thisWeek.weekLabel,
                  })
                }
                className="button button--primary button--small"
                disabled={filteredOrders.length === 0}
              >
                Download {filteredOrders.length} order
                {filteredOrders.length === 1 ? '' : 's'} as Excel (.xlsx)
              </button>
              {orders.length !== filteredOrders.length && (
                <span className="hint" style={{ marginLeft: 'auto' }}>
                  Showing {filteredOrders.length} of {orders.length} total orders in
                  the selected period.
                </span>
              )}
            </div>
          </div>

          {ordersMsg && (
            <div
              className={
                'admin-save ' +
                (ordersMsg.startsWith('✓') ||
                ordersMsg.startsWith('🔄') ||
                ordersMsg.startsWith('🗑️')
                  ? 'admin-save--ok'
                  : 'admin-save--err')
              }
              style={{ marginTop: 16 }}
            >
              {ordersMsg}
            </div>
          )}

          {!initialOrdersLoaded ? (
            <div className="skeleton-block" style={{ marginTop: 24 }}>
              <div className="skeleton skeleton--orders-head" />
              {Array.from({ length: 5 }).map((_, i) => (
                <div className="skeleton skeleton--orders-row" key={i} />
              ))}
            </div>
          ) : filteredOrders.length === 0 ? (
            <p className="body" style={{ marginTop: 24 }}>
              {orders.length === 0
                ? 'No orders yet — the next submitted order will show up here.'
                : 'No orders in this date range — widen the Start / End dates or click "Reset to this week".'}
            </p>
          ) : (
            <div className="orders-table" style={{ marginTop: 20 }}>
              <div className="orders-row orders-row--head">
                <span>Ref</span>
                <span>Name</span>
                <span>Contact</span>
                <span>Qty</span>
                <span>Total</span>
                <span>Method</span>
                <span>Collection Method</span>
                <span>Promo</span>
                <span>Status</span>
                <span>Placed</span>
              </div>
              {filteredOrders.map((o) => (
                <div className="orders-row" key={o.id}>
                  <span className="orders-row__ref">{o.ref}</span>
                  <span>
                    <b>{o.name}</b>
                    {o.email && <span className="hint"> · {o.email}</span>}
                  </span>
                  <span>{o.phone}</span>
                  <span>{o.qty}</span>
                  <span>${Number(o.total).toFixed(2)}</span>
                  <span>{o.method}</span>
                  <span className="orders-row__wrap">
                    {o.fulfilment}
                    {o.collection && o.fulfilment !== o.collection && (
                      <span className="hint"> · {o.collection}</span>
                    )}
                    {o.address && <span className="hint"> · {o.address}</span>}
                  </span>
                  <span>{o.promo || '—'}</span>
                  <span>
                    <select
                      value={o.status}
                      onChange={(e) => void updateOrderStatus(o.id, e.target.value)}
                    >
                      <option value="paid">paid</option>
                      <option value="shipped">shipped</option>
                      <option value="cancelled">cancelled</option>
                    </select>
                  </span>
                  <span className="orders-row__wrap">{new Date(o.created_at).toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {tab === 'banner' && (
        <section className="card admin-card">
          <p className="section-label">Rolling sales banner</p>
          <h2>Edit the marquee message across the top of every page.</h2>
          <p className="body" style={{ marginTop: -8 }}>
            The banner only shows on the storefront when <b>Active</b> is toggled on{' '}
            <b>and</b> the current time is inside the optional start / end window.
          </p>
          {!initialBannerLoaded ? (
            <div className="skeleton-block" style={{ marginTop: 20 }}>
              <div className="skeleton skeleton--promo-row" />
            </div>
          ) : (
            <div className="admin-grid admin-grid--wide" style={{ marginTop: 20 }}>
              <label style={{ gridColumn: '1 / -1' }}>
                <span>Banner message</span>
                <textarea
                  id="admin-banner-message"
                  name="banner_message"
                  rows={3}
                  style={{ minHeight: 96, resize: 'vertical' }}
                  value={bannerMessage}
                  onChange={(e) => setBannerMessage(e.target.value)}
                  placeholder="e.g. 🎉 OPENING SALE: 10% OFF all brownies — use code BAKEDBYGAINS10 at checkout."
                />
                <span className="hint">
                  Shown as a single rolling marquee line (one line, no wrap).
                </span>
              </label>

              <label>
                <span>Show starting (date + time)</span>
                <input
                  id="admin-banner-start"
                  name="banner_start_at"
                  type="datetime-local"
                  value={bannerStart}
                  onChange={(e) => setBannerStart(e.target.value)}
                />
                <span className="hint">Leave blank to show immediately when Active = ON.</span>
              </label>

              <label>
                <span>Hide after (date + time)</span>
                <input
                  id="admin-banner-end"
                  name="banner_end_at"
                  type="datetime-local"
                  value={bannerEnd}
                  onChange={(e) => setBannerEnd(e.target.value)}
                />
                <span className="hint">Leave blank to keep shown indefinitely until turned OFF.</span>
              </label>

              {bannerMsg && (
                <div
                  className={
                    'admin-save ' +
                    (bannerMsg.startsWith('✓') ? 'admin-save--ok' : 'admin-save--err')
                  }
                  style={{ gridColumn: '1 / -1' }}
                >
                  {bannerMsg}
                </div>
              )}

              <div
                style={{
                  gridColumn: '1 / -1',
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 16,
                  alignItems: 'center',
                  padding: '18px 20px',
                  borderRadius: 14,
                  background: '#fffaf3',
                  border: '1px dashed #eacfa8',
                }}
              >
                {/* ======= PILL TOGGLE SWITCH (replaces dropdown) ======= */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    minWidth: 220,
                  }}
                >
                  <label
                    className="toggle-switch"
                    title={bannerActive ? 'Active — banner can show' : 'OFF — banner hidden regardless of schedule'}
                    aria-label="Toggle banner active / hidden"
                  >
                    <input
                      id="admin-banner-active-toggle"
                      name="banner_active"
                      type="checkbox"
                      role="switch"
                      aria-checked={bannerActive}
                      checked={bannerActive}
                      onChange={(e) => setBannerActive(e.target.checked)}
                    />
                    <span aria-hidden="true" />
                  </label>
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <span style={{ fontWeight: 700, fontSize: 15 }}>
                      {bannerActive ? 'Active — banner can show live' : 'OFF — banner hidden'}
                    </span>
                    <span className="hint">
                      {bannerActive
                        ? 'Storefront will show this banner (subject to schedule).'
                        : 'Takes precedence over the start / end schedule.'}
                    </span>
                  </div>
                </div>

                {/* ======= LIVE PREVIEW (directly beside toggle) ======= */}
                <div style={{ flex: '1 1 340px', minWidth: 260 }}>
                  <p className="section-label" style={{ marginBottom: 10 }}>
                    Live preview
                  </p>
                  <div
                    className="sales-banner"
                    role="region"
                    aria-label="Banner preview"
                    style={{
                      position: 'static',
                      width: '100%',
                      top: 'auto',
                      left: 'auto',
                      borderRadius: 10,
                      overflow: 'hidden',
                      boxShadow: 'none',
                      opacity: bannerActive ? 1 : 0.35,
                      pointerEvents: 'none',
                    }}
                  >
                    <div className="sales-banner__track">
                      <span className="sales-banner__text">
                        {bannerMessage || 'Your banner message will scroll here…'}
                      </span>
                      <span className="sales-banner__text" aria-hidden="true">
                        {bannerMessage || 'Your banner message will scroll here…'}
                      </span>
                      <span className="sales-banner__text" aria-hidden="true">
                        {bannerMessage || 'Your banner message will scroll here…'}
                      </span>
                    </div>
                  </div>
                  <p className="body" style={{ marginTop: 12, marginBottom: 0 }}>
                    {bannerActive
                      ? bannerStart || bannerEnd
                        ? (bannerStart
                            ? `Shows starting ${new Date(bannerStart).toLocaleString()}`
                            : 'Showing immediately') +
                          (bannerEnd ? ` until ${new Date(bannerEnd).toLocaleString()}.` : '.')
                        : 'Active — shown continuously on the storefront.'
                      : 'Currently hidden (Active toggle is OFF).'}
                  </p>
                </div>
              </div>

              <div style={{ gridColumn: '1 / -1', display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
                <button className="button button--primary" onClick={() => void saveBanner()}>
                  Save banner
                </button>
                <span className="hint">
                  After saving, reload the storefront page to see the new text live.
                </span>
              </div>

              {/* ============ STOREFRONT LIVE DIAGNOSTIC ============ */}
              {initialBannerLoaded && (
                <BannerLiveStatusBox
                  message={bannerMessage}
                  active={bannerActive}
                  start={bannerStart}
                  end={bannerEnd}
                />
              )}
            </div>
          )}
        </section>
      )}

      {/* ======= Admin manual refresh / logout ======= */}
    </div>
  )
}

function App() {
  return (
    <div className="site-shell">
      <SalesBanner />
      <SiteHeader />
      <main className="site-main">
        <Routes>
          <Route path="/" element={<ProductPage />} />
          <Route path="/product" element={<ProductPage />} />
          <Route path="/about" element={<AboutPage />} />
          <Route path="/order" element={<OrderPage />} />
          <Route path="/collaborate" element={<CollaboratePage />} />
          <Route path="/feedback" element={<FeedbackPage />} />
          <Route path="/receipt" element={<ReceiptPage />} />
          <Route path="/admin-login" element={<AdminLoginPage />} />
          <Route path="/admin" element={<Navigate to="/admin-login" replace />} />
          <Route
            path="/admin-backend"
            element={
              <AdminRouteGuard>
                <AdminBackendPage />
              </AdminRouteGuard>
            }
          />
        </Routes>
      </main>
      <SiteFooter />
      <Buffy />
      <FloatingOrderCTA />
    </div>
  )
}

export default App
