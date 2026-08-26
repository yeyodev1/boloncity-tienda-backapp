function isValidCoords(lat: number, lng: number) {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && (lat !== 0 || lng !== 0)
}

export function parseMapsUrl(url?: string) {
  if (!url) return null

  // Los links comparten coordenadas con la coma escapada (%2C) o con "+" tras la coma.
  let normalized = url.trim()
  try { normalized = decodeURIComponent(normalized) } catch { /* se usa tal cual */ }

  // El cliente pegó las coordenadas directas ("-2.14, -79.88") en vez de un link.
  const plain = normalized.match(/^(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/)
  if (plain) {
    const lat = Number(plain[1]); const lng = Number(plain[2])
    return isValidCoords(lat, lng) ? { lat, lng } : null
  }

  // En un link de ruta el destino es SOLO daddr/destination: "@", "center", "sll" son el
  // centro del mapa y "saddr" es el origen (la ubicacion de quien armo la ruta, no la entrega).
  if (/[?&](?:daddr|saddr|destination)=/.test(normalized)) {
    const target = normalized.match(/[?&](?:daddr|destination)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/)
    if (!target) return null
    const lat = Number(target[1]); const lng = Number(target[2])
    return isValidCoords(lat, lng) ? { lat, lng } : null
  }

  const patterns = [
    /@(-?\d+\.\d+),(-?\d+\.\d+)/,
    /[?&]q=(?:loc:)?\s*(-?\d+\.\d+),\s*(-?\d+\.\d+)/,
    /[?&]ll=(-?\d+\.\d+),(-?\d+\.\d+)/,
    /[?&]query=(-?\d+\.\d+),\s*(-?\d+\.\d+)/,
    /[?&](?:center|sll)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/,
    /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/,
    /\/maps\/search\/(-?\d+\.\d+),\s*\+?(-?\d+\.\d+)/,
    /\/maps\/(?:place|dir)\/[^/]*\/(-?\d+\.\d+),\s*\+?(-?\d+\.\d+)/,
  ]

  for (const pattern of patterns) {
    const match = normalized.match(pattern)
    if (match) {
      const lat = Number(match[1]); const lng = Number(match[2])
      if (isValidCoords(lat, lng)) return { lat, lng }
    }
  }

  return null
}

function isGoogleMapsUrl(value: string) {
  try {
    const host = new URL(value).hostname.toLowerCase()
    return (
      host === 'maps.app.goo.gl' ||
      host === 'goo.gl' ||
      host === 'g.co' ||
      host === 'google.com' ||
      host.endsWith('.google.com') ||
      /^(www\.)?google\.[a-z.]{2,6}$/.test(host) ||
      host.startsWith('maps.google.')
    )
  } catch { return false }
}

/** Busca coordenadas dentro del HTML de la página de Maps (links de "lugar" sin coords en la URL). */
function parseCoordsFromHtml(html: string) {
  const patterns = [
    /@(-?\d+\.\d+),(-?\d+\.\d+)/,
    /center=(-?\d+\.\d+)%2C(-?\d+\.\d+)/,
    /\[(-?\d+\.\d{4,}),(-?\d+\.\d{4,})\]/,
    /"latitude":(-?\d+\.\d+),"longitude":(-?\d+\.\d+)/,
  ]
  for (const pattern of patterns) {
    const match = html.match(pattern)
    if (match) {
      const lat = Number(match[1]); const lng = Number(match[2])
      if (isValidCoords(lat, lng)) return { lat, lng }
    }
  }
  return null
}

/** Plus code de Google ("W382+7QF" o "867W382+7QF"), lo unico que traen los links de "como llegar". */
function extractPlusCode(value: string) {
  const match = value.match(/(?:^|[/=?&+\s])((?:[23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{2,3}))(?:[/=?&+\s]|$)/i)
  return match ? match[1].toUpperCase() : null
}

async function geocode(query: string, apiKey: string, precise: boolean) {
  const endpoint = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&key=${encodeURIComponent(apiKey)}`
  const response = await fetch(endpoint, { signal: AbortSignal.timeout(8000) })
  const data = await response.json() as { results?: Array<{ geometry?: { location?: { lat?: number; lng?: number }; location_type?: string } }> }
  const result = data.results?.[0]
  const location = result?.geometry?.location
  // Una direccion escrita a mano ("Sur de gye") geocodifica a un punto generico: se descarta.
  // Ese punto falso costaria una sucursal y una tarifa equivocadas.
  if (precise && !['ROOFTOP', 'RANGE_INTERPOLATED'].includes(result?.geometry?.location_type || '')) return null
  if (typeof location?.lat === 'number' && typeof location.lng === 'number' && isValidCoords(location.lat, location.lng)) {
    return { lat: location.lat, lng: location.lng }
  }
  return null
}

export async function resolveMapsCoordinates(url?: string, address?: string, apiKey?: string) {
  const direct = parseMapsUrl(url)
  if (direct) return direct

  if (url && isGoogleMapsUrl(url)) {
    try {
      const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(8000) })
      const resolved = parseMapsUrl(response.url)
      if (resolved) return resolved
      const finalUrl = decodeURIComponent(response.url)
      // Un link de "como llegar" (ruta) NO es una ubicacion: su HTML trae el centro del
      // mapa y el origen, no el destino. Se resuelve solo por el plus code del destino.
      const isDirections = /\/maps\/dir\/|[?&]daddr=|[?&]saddr=/.test(finalUrl)
      if (isDirections) {
        const plusCode = extractPlusCode(finalUrl)
        return plusCode && apiKey ? await geocode(plusCode, apiKey, false) : null
      }
      // Links de "lugar": la URL final no trae coordenadas, pero el HTML sí.
      const html = (await response.text()).slice(0, 300_000)
      const fromHtml = parseCoordsFromHtml(html)
      if (fromHtml) return fromHtml
    } catch { /* Fall through to optional geocoding. */ }
  }

  if (apiKey && address?.trim()) {
    try {
      const fromAddress = await geocode(address, apiKey, true)
      if (fromAddress) return fromAddress
    } catch { /* Caller returns a clear validation response. */ }
  }

  return null
}
