export function parseMapsUrl(url?: string) {
  if (!url) return null

  const normalized = url.trim()
  const patterns = [
    /@(-?\d+\.\d+),(-?\d+\.\d+)/,
    /[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/,
    /[?&]ll=(-?\d+\.\d+),(-?\d+\.\d+)/,
    /[?&]query=(-?\d+\.\d+),(-?\d+\.\d+)/,
    /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/,
    /\/maps\/search\/(-?\d+\.\d+),\+?(-?\d+\.\d+)/,
  ]

  for (const pattern of patterns) {
    const match = normalized.match(pattern)
    if (match) {
      return { lat: Number(match[1]), lng: Number(match[2]) }
    }
  }

  return null
}

function isGoogleMapsUrl(value: string) {
  try {
    const host = new URL(value).hostname.toLowerCase()
    return host === 'maps.app.goo.gl' || host.endsWith('.google.com') || host === 'goo.gl'
  } catch { return false }
}

export async function resolveMapsCoordinates(url?: string, address?: string, apiKey?: string) {
  const direct = parseMapsUrl(url)
  if (direct) return direct

  if (url && isGoogleMapsUrl(url)) {
    try {
      const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(8000) })
      const resolved = parseMapsUrl(response.url)
      if (resolved) return resolved
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
