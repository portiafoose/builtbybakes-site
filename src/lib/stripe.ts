import Stripe from 'stripe'
import { stripeBuildSessionParams, type StripeCheckoutResult, type StripeCreateCheckoutOpts } from './stripe-shared'

const PUBLISHABLE_KEY = (import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY as string | undefined) ?? ''
const DEV_SECRET_KEY = (import.meta.env.VITE_STRIPE_SECRET_KEY as string | undefined) ?? ''

const IS_LOCAL: boolean =
  typeof window !== 'undefined' &&
  (window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1' ||
    window.location.hostname.endsWith('.local'))

export function stripeConfigured(): boolean {
  if (IS_LOCAL) return PUBLISHABLE_KEY.trim().length > 0 && DEV_SECRET_KEY.trim().length > 0
  return PUBLISHABLE_KEY.trim().length > 0
}

let serverStripe: Stripe | null = null

function getDirectStripeOrThrow(): Stripe {
  if (!IS_LOCAL) {
    throw new Error(
      'BUG: Direct Stripe client requested on a non-localhost host. Use Netlify Functions (/api/create-checkout) in production.',
    )
  }
  if (!DEV_SECRET_KEY) throw new Error('Stripe is not configured — set VITE_STRIPE_SECRET_KEY in your local .env.')
  if (DEV_SECRET_KEY.startsWith('sk_live_')) {
    throw new Error(
      'Refusing to use a LIVE Stripe secret key (sk_live_…) in the bundled client code. ' +
        'Use Netlify Functions with STRIPE_SECRET_KEY set in Netlify Environment Variables for live payments.',
    )
  }
  if (serverStripe) return serverStripe
  try {
    serverStripe = new Stripe(DEV_SECRET_KEY, {
      apiVersion: '2024-06-20',
      typescript: true,
    } as unknown as Stripe.StripeConfig)
    return serverStripe
  } catch (e) {
    console.warn('[stripe] failed to construct local-dev Stripe client:', e)
    throw e
  }
}

export type { StripeCheckoutResult }
export type { StripeCreateCheckoutOpts }

export async function stripeCreateCheckoutSession(opts: StripeCreateCheckoutOpts): Promise<StripeCheckoutResult> {
  if (IS_LOCAL) {
    const stripe = getDirectStripeOrThrow()
    const session = await stripe.checkout.sessions.create(stripeBuildSessionParams(opts))
    if (!session.url) {
      throw new Error(
        'Stripe Checkout session returned without a redirect URL. Check Stripe keys + payment method capabilities.',
      )
    }
    return { sessionId: session.id, sessionUrl: session.url }
  }

  const res = await fetch('/api/create-checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  })
  let payload: unknown
  try {
    payload = (await res.json()) as unknown
  } catch {
    throw new Error(
      `Checkout API call failed: HTTP ${res.status}${res.statusText ? ' ' + res.statusText : ''} (invalid JSON response)`,
    )
  }
  if (!res.ok || typeof payload !== 'object' || payload === null || !(payload as { ok?: boolean }).ok) {
    const msg =
      typeof payload === 'object' &&
      payload !== null &&
      'error' in payload &&
      typeof (payload as { error?: unknown }).error === 'string'
        ? (payload as { error: string }).error
        : `HTTP ${res.status}${res.statusText ? ' ' + res.statusText : ''}`
    throw new Error(msg)
  }
  const { sessionId, sessionUrl } = payload as { sessionId: string; sessionUrl: string }
  if (typeof sessionId !== 'string' || typeof sessionUrl !== 'string') {
    throw new Error('Malformed response from create-checkout endpoint.')
  }
  return { sessionId, sessionUrl }
}

export async function stripeRetrieveCheckoutSession(sessionId: string) {
  if (IS_LOCAL) {
    const stripe = getDirectStripeOrThrow()
    return stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['payment_intent', 'line_items', 'customer_details'],
    })
  }

  const url = '/api/retrieve-checkout?session_id=' + encodeURIComponent(sessionId)
  const res = await fetch(url)
  let payload: unknown
  try {
    payload = (await res.json()) as unknown
  } catch {
    throw new Error(
      `Receipt API call failed: HTTP ${res.status}${res.statusText ? ' ' + res.statusText : ''} (invalid JSON response)`,
    )
  }
  if (!res.ok || typeof payload !== 'object' || payload === null || !(payload as { ok?: boolean }).ok) {
    const msg =
      typeof payload === 'object' &&
      payload !== null &&
      'error' in payload &&
      typeof (payload as { error?: unknown }).error === 'string'
        ? (payload as { error: string }).error
        : `HTTP ${res.status}${res.statusText ? ' ' + res.statusText : ''}`
    throw new Error(msg)
  }
  return (payload as { session: unknown }).session as Stripe.Checkout.Session
}
