export function parseVideoId(input: string): string | null {
  const t = input.trim()
  const patterns = [
    /(?:youtube\.com\/watch\?.*v=)([\w-]{11})/,
    /(?:youtu\.be\/)([\w-]{11})/,
    /(?:youtube\.com\/shorts\/)([\w-]{11})/,
    /(?:youtube\.com\/embed\/)([\w-]{11})/
  ]
  for (const re of patterns) {
    const m = t.match(re)
    if (m) return m[1]
  }
  if (/^[\w-]{11}$/.test(t)) return t
  return null
}
