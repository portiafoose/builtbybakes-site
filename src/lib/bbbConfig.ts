export type ReviewItem = {
  type?: 'photo' | 'video'
  src: string
  credit?: string
}

export const BBB = {
  UNIT_PRICE: 6.9,
  DELIVERY_FEE: 12,
  QUANTITIES: [1, 3, 6],
  PAYNOW_NUMBER: '9740 1751',
  PAYNOW_NAME: 'Built By Bakes',
  PAYNOW_QR_IMG: 'paynow-qr.png',
  WHATSAPP: '6597401751',
  INSTAGRAM: 'https://instagram.com/builtbybakes.sg',
  TELEGRAM: 'https://t.me/builtbybakes',
  TIKTOK: 'https://www.tiktok.com/@builtbybakes.sg',
  ORDERS_OPEN: true /* [TESTING OVERRIDE] Set to false to show the closed banner. Temporarily disabled for end-to-end testing — also see orderWindowOk() in OrderPage. */,
  COLLECT_OPTIONS: [
    'Self-collection at Bras Basah MRT (Thursday, 7pm)',
    'Self-collection from Astrid (liaise with Astrid directly)',
  ],
  REVIEW_ITEMS: [] as ReviewItem[],
  VIDEOS: [
    { type: 'video', src: '/reviews/IMG_5246.MP4', credit: 'Customer clip 01' },
    { type: 'video', src: '/reviews/IMG_5667.MP4', credit: 'Customer clip 02' },
  ] as ReviewItem[],
  FEE_CARD_RATE: 0.034,
  FEE_CARD_FIXED: 0.5,
  FEE_PAYNOW_LOW_RATE: 0.013,
  FEE_PAYNOW_LOW_MIN: 0.0,
  FEE_PAYNOW_HIGH_RATE: 0.013,
  FEE_PAYNOW_HIGH_FIXED: 0.0,
  CARD_PAYMENT_LINK: '',
  CORP_WHATSAPP: '6597401751',
  CORP_EMAIL: 'builtbybakes.sg@gmail.com',
  SCHEDULE_NOTE:
    'Weekly drops open Friday evening, orders close Tuesday night. Collection is Thursday 7pm at Bras Basah MRT, or liaise directly with Astrid. Delivery is available at a flat $12.',
  ORDER_PAGE_NOTE:
    'Weekly drops open Friday evening, orders close Tuesday night. Collection is Thursday 7pm at Bras Basah MRT, or liaise directly with Astrid. Delivery is available at a flat $12.',
  CLOSED_NOTE:
    "This week's batch is fully claimed 🍫 New drop goes live Friday evening — orders close Tuesday night, join our Telegram so you don't miss it!",
  VALID_EMAIL_RE: /^[^\s@]+@[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,}$/,
  VALID_SG_PHONE_RE: /^(\+?65[\s-]?)?[689]\d{3}[\s-]?\d{4}$/,
}

export function bbbOrdersOpen() {
  return !!BBB.ORDERS_OPEN
}

export function bbbScheduleNote() {
  return bbbOrdersOpen() ? BBB.SCHEDULE_NOTE : BBB.CLOSED_NOTE
}

export function bbbGrossUp(base: number, method: 'card' | 'paynow') {
  if (method === 'card') {
    if (!BBB.FEE_CARD_RATE && !BBB.FEE_CARD_FIXED) return base
    return (base + BBB.FEE_CARD_FIXED) / (1 - BBB.FEE_CARD_RATE)
  }
  if (!BBB.FEE_PAYNOW_LOW_RATE && !BBB.FEE_PAYNOW_HIGH_RATE) return base
  let p = base / (1 - BBB.FEE_PAYNOW_LOW_RATE)
  if (p - base < BBB.FEE_PAYNOW_LOW_MIN) p = base + BBB.FEE_PAYNOW_LOW_MIN
  if (p >= 100) p = (base + BBB.FEE_PAYNOW_HIGH_FIXED) / (1 - BBB.FEE_PAYNOW_HIGH_RATE)
  return p
}

export function validEmail(v: string): boolean {
  return BBB.VALID_EMAIL_RE.test(String(v ?? '').trim())
}

export function validSGPhone(v: string): boolean {
  return BBB.VALID_SG_PHONE_RE.test(String(v ?? '').trim())
}

export function validEmailOrSGPhone(v: string): boolean {
  const s = String(v ?? '').trim()
  if (!s) return false
  if (s.includes('@')) return validEmail(s)
  return validSGPhone(s)
}
