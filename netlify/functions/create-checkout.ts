import Stripe from 'stripe'
import { stripeBuildSessionParams, type StripeCreateCheckoutOpts } from '../../src/lib/stripe-shared'

type HandlerEvent = {
  httpMethod: string
  headers: Record<string, string | undefined>
  body: string | null
  isBase64Encoded?: boolean
}

type HandlerResponse = {
  statusCode: number
  headers: Record<string, string>
  body: string
}

function jsonResponse(status: number, payload: unknown): HandlerResponse {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    },
    body: JSON.stringify(payload),
  }
}

function requireEnv(primaryName: string, aliases: string[] = []): string {
  const candidates = [primaryName, ...aliases]
  for (const name of candidates) {
    const raw = (process.env[name] as string | undefined) ?? ''
    // Strip accidental outer quotes/spaces/newlines that often sneak in when
    // copying/pasting values into the Netlify env var panel.
    const trimmed = raw.trim().replace(/^["']|["']$/g, '').trim()
    if (trimmed) return trimmed
  }
  const list = candidates.map((n) => `'${n}'`).join(' or ')
  throw new Error(
    `Missing required server env ${primaryName}. Go to Netlify → Site configuration → Environment variables and add/republish a Variable named '${primaryName}' with the correct value. Set SCOPE = Functions (or "All scopes") AND tick the deploy contexts you want, then click "Save & deploy". Other variables currently seen on this instance: ${Object.keys(process.env)
      .filter((k) => /stripe|supabase|bbb_admin/i.test(k))
      .join(', ') || '(none matched stripe/supabase/bbb_admin)'}.`,
  )
}

let serverStripe: Stripe | null = null
function getStripe(): Stripe {
  const secret = requireEnv('STRIPE_SECRET_KEY', ['STRIPE_SK', 'STRIPE_API_KEY', 'VITE_STRIPE_SECRET_KEY'])
  if (serverStripe) return serverStripe
  serverStripe = new Stripe(secret, {
    apiVersion: '2024-06-20',
    typescript: true,
  } as unknown as Stripe.StripeConfig)
  return serverStripe
}

export async function handler(event: HandlerEvent): Promise<HandlerResponse> {
  if (event.httpMethod === 'OPTIONS') {
    return jsonResponse(204, {})
  }
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { ok: false, error: 'Method not allowed. Use POST.' })
  }
  let opts: StripeCreateCheckoutOpts
  try {
    if (!event.body) throw new Error('Missing JSON body.')
    opts = JSON.parse(event.body) as StripeCreateCheckoutOpts
  } catch (e) {
    return jsonResponse(400, { ok: false, error: 'Invalid JSON body: ' + (e instanceof Error ? e.message : String(e)) })
  }

  try {
    const stripe = getStripe()
    const session = await stripe.checkout.sessions.create(stripeBuildSessionParams(opts))

    if (!session.url) {
      throw new Error(
        'Stripe Checkout session returned without a redirect URL. Check Stripe keys + payment method capabilities.',
      )
    }
    return jsonResponse(200, { ok: true as const, sessionId: session.id, sessionUrl: session.url })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return jsonResponse(500, { ok: false, error: message })
  }
}
