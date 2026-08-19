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

  const patterns = [
    /@(-?\d+\.\d+),(-?\d+\.\d+)/,
    /[?&]q=(?:loc:)?\s*(-?\d+\.\d+),\s*(-?\d+\.\d+)/,
    /[?&]ll=(-?\d+\.\d+),(-?\d+\.\d+)/,
    /[?&]query=(-?\d+\.\d+),\s*(-?\d+\.\d+)/,
    /[?&](?:daddr|destination|center|sll|saddr)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/,
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

export async function resolveMapsCoordinates(url?: string, address?: string, apiKey?: string) {
  const direct = parseMapsUrl(url)
  if (direct) return direct

  if (url && isGoogleMapsUrl(url)) {
    try {
      const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(8000) })
      const resolved = parseMapsUrl(response.url)
      if (resolved) return resolved
      // Links de "lugar": la URL final no trae coordenadas, pero el HTML sí.
      const html = (await response.text()).slice(0, 300_000)
      const fromHtml = parseCoordsFromHtml(html)
      if (fromHtml) return fromHtml
    } catch { /* Fall through to optional geocoding. */ }
  }

  if (apiKey && address?.trim()) {
    try {
      const endpoint = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${encodeURIComponent(apiKey)}`
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(8000) })
      const data = await response.json() as { results?: Array<{ geometry?: { location?: { lat?: number; lng?: number } } }> }
      const location = data.results?.[0]?.geometry?.location
      if (typeof location?.lat === 'number' && typeof location.lng === 'number') return { lat: location.lat, lng: location.lng }
    } catch { /* Caller returns a clear validation response. */ }
  }

  return null
}
