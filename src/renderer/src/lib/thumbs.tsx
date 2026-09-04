import { useEffect, useState } from 'react'

// library thumbnails resolve through the local cache in the main process
// (userData/thumbs). Setting changes re-resolve: hideVideo on/off changes
// whether missing thumbs may still be fetched online
const memo = new Map<string, Promise<string | null>>()

function getThumbCached(videoId: string): Promise<string | null> {
  let p = memo.get(videoId)
  if (!p) {
    p = window.stemkit.getThumb(videoId).catch(() => null)
    memo.set(videoId, p)
  }
  return p
}

export function useThumb(videoId: string): string | null {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    void getThumbCached(videoId).then((url) => {
      if (alive) setSrc(url)
    })
    const off = window.stemkit.onSettingsChange(() => {
      memo.clear()
      void getThumbCached(videoId).then((url) => {
        if (alive) setSrc(url)
      })
    })
    return () => {
      alive = false
      off()
    }
  }, [videoId])
  return src
}

export function Thumb({ videoId, className }: { videoId: string; className: string }): React.ReactElement {
  const src = useThumb(videoId)
  if (!src) return <span className={className} />
  return <img src={src} alt="" className={className} draggable={false} />
}