import Stripe from 'stripe'

// Netlify serverless Function — retrieve-checkout
// Runs on Netlify's AWS Lambda-backed Functions runtime (Node 22+).
// STRIPE_SECRET_KEY comes from Netlify Environment Variables (never in the bundle).
//
// Client calls:
//   GET /api/retrieve-checkout?session_id=cs_test_...
// Returns:
//   200 { ok:true, session: expanded Stripe Checkout.Session }
//   4xx/5xx { ok:false, error: string }

type HandlerEvent = {
  httpMethod: string
  headers: Record<string, string | undefined>
  queryStringParameters?: Record<string, string | undefined> | null
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
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
    },
    body: JSON.stringify(payload),
  }
}

function requireEnv(primaryName: string, aliases: string[] = []): string {
  const candidates = [primaryName, ...aliases]
  for (const name of candidates) {
    const raw = (process.env[name] as string | undefined) ?? ''
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
  if (event.httpMethod !== 'GET') {
    return jsonResponse(405, { ok: false, error: 'Method not allowed. Use GET.' })
  }
  const sessionId = event.queryStringParameters?.session_id
  if (!sessionId) {
    return jsonResponse(400, { ok: false, error: 'Missing required query parameter: session_id' })
  }

  try {
    const stripe = getStripe()
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['payment_intent', 'line_items', 'customer_details'],
    })
    return jsonResponse(200, { ok: true as const, session })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return jsonResponse(500, { ok: false, error: message })
  }
}
