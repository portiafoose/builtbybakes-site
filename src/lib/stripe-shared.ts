import type Stripe from 'stripe'

export type StripeCheckoutResult = {
  sessionId: string
  sessionUrl: string
}

export type StripeCreateCheckoutOpts = {
  method: 'card' | 'paynow'
  lineItems: Array<{
    name: string
    description?: string
    unitAmountSGD: number
    quantity: number
    imageUrl?: string
  }>
  totalLineItems?: Array<{ name: string; amountSGD: number }>
  currency?: string
  referenceNumber: string
  customerName?: string
  customerEmail?: string
  customerPhone?: string
  successUrl: string
  cancelUrl: string
  promoCodeName?: string
  discountAmountSGD?: number
  sourceChannel?: string
  orderPayload?: Record<string, unknown>
}

export function stripeBuildSessionParams(opts: StripeCreateCheckoutOpts): Stripe.Checkout.SessionCreateParams {
  const currency = (opts.currency || 'SGD').toUpperCase()

  const products: Stripe.Checkout.SessionCreateParams.LineItem[] = []
  for (const it of opts.lineItems) {
    products.push({
      quantity: it.quantity,
      price_data: {
        currency,
        unit_amount: Math.max(1, Math.round(it.unitAmountSGD * 100)),
        product_data: {
          name: it.name,
          ...(it.description ? { description: it.description } : {}),
          ...(it.imageUrl ? { images: [it.imageUrl] } : {}),
        },
      },
    })
  }
  if (opts.totalLineItems) {
    for (const extra of opts.totalLineItems) {
      if (extra.amountSGD <= 0) continue
      products.push({
        quantity: 1,
        price_data: {
          currency,
          unit_amount: Math.max(1, Math.round(extra.amountSGD * 100)),
          product_data: { name: extra.name },
        },
      })
    }
  }
  if (products.length === 0) {
    throw new Error('Stripe Checkout requires at least 1 line item (no items passed).')
  }

  const payment_method_types: string[] = opts.method === 'card' ? ['card'] : ['paynow']
  const metadata: Record<string, string> = {
    order_reference: opts.referenceNumber,
    shop: 'built-by-bakes',
    payment_method: opts.method,
  }
  if (opts.customerPhone) metadata.customer_phone = opts.customerPhone
  if (opts.customerName) metadata.customer_name = opts.customerName
  if (opts.customerEmail) metadata.customer_email = opts.customerEmail
  if (opts.promoCodeName) metadata.promo_code = opts.promoCodeName
  if (typeof opts.discountAmountSGD === 'number' && opts.discountAmountSGD > 0) {
    metadata.discount_amount = opts.discountAmountSGD.toFixed(2)
  }
  if (opts.sourceChannel) metadata.source_channel = opts.sourceChannel
  if (opts.orderPayload) metadata.order_payload_json = JSON.stringify(opts.orderPayload)

  return {
    mode: 'payment',
    payment_method_types,
    line_items: products,
    currency,
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    customer_email: opts.customerEmail || undefined,
    metadata,
    payment_intent_data: {
      statement_descriptor: `BBB-${(opts.referenceNumber || '').slice(0, 6).toUpperCase()}`,
      metadata,
    },
    submit_type: 'pay',
    billing_address_collection: 'auto',
    phone_number_collection: { enabled: true },
    allow_promotion_codes: false,
    locale: 'en',
  }
}
