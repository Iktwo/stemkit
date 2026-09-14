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

export function parsePlaylistId(input: string): string | null {
  const t = input.trim()
  const m = t.match(/[?&]list=([\w-]+)/)
  if (m) return m[1]
  // bare playlist ids (PL/OL/UU/LL/FL prefixes); RD* are radio mixes, skip those
  if (/^(PL|OL|UU|LL|FL)[\w-]{11,}$/.test(t)) return t
  return null
}
