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

let serverStripe: Stripe | null = null
function getStripe(): Stripe {
  const secret = (process.env.STRIPE_SECRET_KEY as string | undefined) ?? ''
  if (!secret) throw new Error('STRIPE_SECRET_KEY is not set in Netlify Environment Variables.')
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
