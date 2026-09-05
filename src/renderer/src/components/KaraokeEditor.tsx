import { useState, useRef, useCallback } from 'react'
import type { KaraokeLine, KaraokeWord } from '../../../shared/types'
import { fmtTime } from '../lib/format'
import {
  PlayIcon,
  TrashIcon,
  PlusIcon,
  CheckIcon,
  UndoIcon,
  MicIcon,
  XIcon
} from './Icons'

interface Props {
  lines: KaraokeLine[]
  currentTime: number
  duration: number
  onSeek: (time: number) => void
  onSave: (updatedLines: KaraokeLine[]) => Promise<void>
  onClose: () => void
  voiceTrackOn: boolean
  onToggleVoiceTrack: (enable: boolean) => void
}

function fmtSec(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0.00'
  return sec.toFixed(2)
}

function fmtFullTime(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = (sec % 60).toFixed(2)
  return `${m}:${s.padStart(5, '0')}`
}

export function KaraokeEditor({
  lines: initialLines,
  currentTime,
  duration,
  onSeek,
  onSave,
  onClose,
  voiceTrackOn,
  onToggleVoiceTrack
}: Props): React.ReactElement {
  const [lines, setLines] = useState<KaraokeLine[]>(() =>
    JSON.parse(JSON.stringify(initialLines))
  )
  const [hasChanges, setHasChanges] = useState(false)
  const [saving, setSaving] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [expandedWordIndices, setExpandedWordIndices] = useState<Set<number>>(new Set())
  const [toastMessage, setToastMessage] = useState<string | null>(null)

  const activeLineRef = useRef<HTMLDivElement | null>(null)
  const listContainerRef = useRef<HTMLDivElement | null>(null)

  // Show a temporary toast
  const showToast = useCallback((msg: string): void => {
    setToastMessage(msg)
    setTimeout(() => setToastMessage(null), 3000)
  }, [])

  // Toggle word expansion for a line
  const toggleWordsExpanded = (idx: number): void => {
    setExpandedWordIndices((prev) => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })
  }

  // Update line text and re-sync words
  const handleUpdateLineText = (idx: number, newText: string): void => {
    setLines((prev) => {
      const next = [...prev]
      const target = { ...next[idx] }
      target.text = newText

      const splitWords = newText.trim().split(/\s+/).filter(Boolean)
      const existingWords = target.words || []

      if (splitWords.length === existingWords.length) {
        // Same count: keep existing word timestamps, update word strings
        target.words = existingWords.map((w, wIdx) => ({
          ...w,
          word: splitWords[wIdx]
        }))
      } else if (splitWords.length > 0) {
        // Word count changed: interpolate word timestamps across line duration
        const dur = Math.max(0.2, target.end - target.start)
        const step = dur / splitWords.length
        target.words = splitWords.map((w, wIdx) => ({
          word: w,
          start: Math.round((target.start + wIdx * step) * 100) / 100,
          end: Math.round((target.start + (wIdx + 1) * step) * 100) / 100,
          probability: 1.0
        }))
      } else {
        target.words = []
      }

      next[idx] = target
      return next
    })
    setHasChanges(true)
  }

  // Nudge line start or end by delta seconds
  const handleNudge = (idx: number, which: 'start' | 'end', delta: number): void => {
    setLines((prev) => {
      const next = [...prev]
      const target = { ...next[idx] }

      if (which === 'start') {
        const newStart = Math.max(0, Math.round((target.start + delta) * 100) / 100)
        target.start = newStart
        if (target.end <= newStart) {
          target.end = Math.round((newStart + 0.5) * 100) / 100
        }
        if (target.words && target.words.length > 0) {
          const w0 = { ...target.words[0], start: target.start }
          target.words = [w0, ...target.words.slice(1)]
        }
      } else {
        const newEnd = Math.max(
          target.start + 0.1,
          Math.min(duration || 9999, Math.round((target.end + delta) * 100) / 100)
        )
        target.end = newEnd
        if (target.words && target.words.length > 0) {
          const lastIdx = target.words.length - 1
          const wLast = { ...target.words[lastIdx], end: target.end }
          target.words = [...target.words.slice(0, lastIdx), wLast]
        }
      }

      next[idx] = target
      return next
    })
    setHasChanges(true)
  }

  // Direct edit of timestamp
  const handleTimeInput = (idx: number, which: 'start' | 'end', val: number): void => {
    if (isNaN(val) || val < 0) return
    setLines((prev) => {
      const next = [...prev]
      const target = { ...next[idx] }

      if (which === 'start') {
        target.start = Math.round(val * 100) / 100
        if (target.end <= target.start) {
          target.end = Math.round((target.start + 0.5) * 100) / 100
        }
        if (target.words && target.words.length > 0) {
          target.words = [
            { ...target.words[0], start: target.start },
            ...target.words.slice(1)
          ]
        }
      } else {
        target.end = Math.max(target.start + 0.1, Math.round(val * 100) / 100)
        if (target.words && target.words.length > 0) {
          const lastIdx = target.words.length - 1
          target.words = [
            ...target.words.slice(0, lastIdx),
            { ...target.words[lastIdx], end: target.end }
          ]
        }
      }

      next[idx] = target
      return next
    })
    setHasChanges(true)
  }

  // Update an individual word within a line
  const handleUpdateWord = (
    lineIdx: number,
    wordIdx: number,
    patch: Partial<KaraokeWord>
  ): void => {
    setLines((prev) => {
      const next = [...prev]
      const target = { ...next[lineIdx] }
      const words = [...(target.words || [])]

      if (words[wordIdx]) {
        words[wordIdx] = { ...words[wordIdx], ...patch }
        target.words = words
        target.text = words.map((w) => w.word).join(' ')
        if (patch.start !== undefined && wordIdx === 0) {
          target.start = patch.start
        }
        if (patch.end !== undefined && wordIdx === words.length - 1) {
          target.end = patch.end
        }
      }

      next[lineIdx] = target
      return next
    })
    setHasChanges(true)
  }

  // Split a line into two at a specific word index
  const handleSplitLine = (lineIdx: number, wordIdx: number): void => {
    setLines((prev) => {
      const target = prev[lineIdx]
      const words = target.words || []
      if (wordIdx <= 0 || wordIdx >= words.length) return prev

      const wordsA = words.slice(0, wordIdx)
      const wordsB = words.slice(wordIdx)

      const lineA: KaraokeLine = {
        start: wordsA[0]?.start ?? target.start,
        end: wordsA[wordsA.length - 1]?.end ?? (target.start + target.end) / 2,
        text: wordsA.map((w) => w.word).join(' '),
        words: wordsA
      }

      const lineB: KaraokeLine = {
        start: wordsB[0]?.start ?? lineA.end + 0.1,
        end: wordsB[wordsB.length - 1]?.end ?? target.end,
        text: wordsB.map((w) => w.word).join(' '),
        words: wordsB
      }

      const next = [...prev.slice(0, lineIdx), lineA, lineB, ...prev.slice(lineIdx + 1)]
      return next
    })
    setHasChanges(true)
    showToast('Split line into two phrases')
  }

  // Merge line with the next line
  const handleMergeWithNext = (lineIdx: number): void => {
    setLines((prev) => {
      if (lineIdx >= prev.length - 1) return prev
      const current = prev[lineIdx]
      const nextLine = prev[lineIdx + 1]

      const mergedWords = [...(current.words || []), ...(nextLine.words || [])]
      const mergedLine: KaraokeLine = {
        start: current.start,
        end: nextLine.end,
        text: `${current.text} ${nextLine.text}`.trim(),
        words: mergedWords
      }

      const next = [...prev.slice(0, lineIdx), mergedLine, ...prev.slice(lineIdx + 2)]
      return next
    })
    setHasChanges(true)
    showToast('Merged lines')
  }

  // Delete a line
  const handleDeleteLine = (lineIdx: number): void => {
    setLines((prev) => prev.filter((_, i) => i !== lineIdx))
    setHasChanges(true)
    showToast('Line deleted')
  }

  // Add a new line at current playback time or after an existing line
  const handleAddLine = (afterIdx?: number): void => {
    setLines((prev) => {
      let startTime = Math.round(currentTime * 100) / 100
      let insertIdx = prev.length

      if (afterIdx !== undefined && prev[afterIdx]) {
        startTime = Math.round((prev[afterIdx].end + 0.3) * 100) / 100
        insertIdx = afterIdx + 1
      }

      const endTime = Math.round((startTime + 3.0) * 100) / 100
      const newLine: KaraokeLine = {
        start: startTime,
        end: endTime,
        text: 'New lyric phrase',
        words: [
          { word: 'New', start: startTime, end: startTime + 0.9, probability: 1 },
          { word: 'lyric', start: startTime + 1.0, end: startTime + 1.9, probability: 1 },
          { word: 'phrase', start: startTime + 2.0, end: endTime, probability: 1 }
        ]
      }

      const next = [...prev.slice(0, insertIdx), newLine, ...prev.slice(insertIdx)]
      return next
    })
    setHasChanges(true)
    showToast('Added new line')
  }

  // Revert all edits
  const handleDiscard = (): void => {
    if (hasChanges && !confirm('Discard all unsaved edits to lyrics?')) return
    setLines(JSON.parse(JSON.stringify(initialLines)))
    setHasChanges(false)
    showToast('Edits discarded')
  }

  // Save changes to disk & parent state
  const handleSave = async (): Promise<void> => {
    setSaving(true)
    try {
      // Sort lines chronologically
      const sorted = [...lines].sort((a, b) => a.start - b.start)
      await onSave(sorted)
      setLines(sorted)
      setHasChanges(false)
      showToast('Lyrics saved successfully!')
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  // Filter lines by search query
  const filteredLines = lines
    .map((line, originalIndex) => ({ line, originalIndex }))
    .filter(({ line }) =>
      searchQuery ? line.text.toLowerCase().includes(searchQuery.toLowerCase()) : true
    )

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Editor Sub-Header Toolbar */}
      <div className="flex items-center justify-between px-8 py-3 bg-black/40 border-b border-white/10 shrink-0 gap-4 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          <span className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-amber-400/20 text-amber-300 font-semibold text-xs border border-amber-400/30">
            ✍️ Lyric Timing & Text Editor
          </span>
          <span className="text-xs text-white/50 font-mono">
            {lines.length} lines total
          </span>

          {/* Quick Filter Input */}
          <div className="relative">
            <input
              type="text"
              placeholder="Search lyrics…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="px-3 py-1 text-xs rounded-lg glass border border-white/15 text-white placeholder-white/40 focus:outline-none focus:border-amber-400/60 w-44"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2 top-1.5 text-white/40 hover:text-white"
              >
                <XIcon className="w-3 h-3" />
              </button>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Voice Track Audition Toggle */}
          <button
            onClick={() => onToggleVoiceTrack(!voiceTrackOn)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer border ${
              voiceTrackOn
                ? 'bg-amber-400/20 text-amber-300 border-amber-400/40'
                : 'glass text-white/50 border-white/10 hover:text-white'
            }`}
            title="Toggle original voice track audible while editing (Shortcut: V)"
          >
            <MicIcon className="w-3.5 h-3.5" />
            <span>Voice Track: {voiceTrackOn ? 'ON' : 'MUTED'}</span>
          </button>

          {/* Add Line at Current Time Button */}
          <button
            onClick={() => handleAddLine()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg glass hover:bg-white/10 text-white/80 hover:text-white text-xs font-medium border border-white/15 transition-all cursor-pointer"
            title={`Insert a new line at current playhead position (${fmtTime(currentTime)})`}
          >
            <PlusIcon className="w-3.5 h-3.5 text-amber-400" />
            <span>Add Line @ {fmtTime(currentTime)}</span>
          </button>

          {/* Discard Changes Button */}
          {hasChanges && (
            <button
              onClick={handleDiscard}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg glass hover:bg-white/10 text-white/60 hover:text-red-300 text-xs font-medium border border-white/10 transition-colors cursor-pointer"
              title="Discard unsaved edits"
            >
              <UndoIcon className="w-3.5 h-3.5" />
              <span>Discard</span>
            </button>
          )}

          {/* Save Changes Button */}
          <button
            onClick={() => void handleSave()}
            disabled={saving || !hasChanges}
            className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
              hasChanges
                ? 'bg-amber-400 text-black hover:bg-amber-300 shadow-lg shadow-amber-400/20 scale-105'
                : 'bg-white/10 text-white/40 cursor-not-allowed'
            }`}
            title={hasChanges ? 'Save edits to disk' : 'No changes to save'}
          >
            <CheckIcon className="w-3.5 h-3.5" />
            <span>{saving ? 'Saving…' : hasChanges ? 'Save Changes' : 'Saved'}</span>
          </button>

          {/* Exit / Return to Stage */}
          <button
            onClick={onClose}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg glass hover:bg-white/10 text-white/70 hover:text-white text-xs transition-colors cursor-pointer"
            title="Return to Karaoke Stage View"
          >
            <span>Done Editing</span>
          </button>
        </div>
      </div>

      {/* Floating Toast Notification */}
      {toastMessage && (
        <div className="absolute top-24 left-1/2 -translate-x-1/2 z-40 animate-in fade-in slide-in-from-top-2 duration-200">
          <div className="glass px-4 py-2 rounded-full border border-amber-400/30 text-amber-300 text-xs font-semibold shadow-2xl flex items-center gap-2 backdrop-blur-xl">
            <CheckIcon className="w-3.5 h-3.5" />
            <span>{toastMessage}</span>
          </div>
        </div>
      )}

      {/* Scrollable Lyric Lines List */}
      <div
        ref={listContainerRef}
        className="flex-1 overflow-y-auto px-8 py-6 space-y-4 scroll-smooth"
      >
        {filteredLines.length === 0 ? (
          <div className="h-64 flex flex-col items-center justify-center text-center">
            <p className="text-white/40 text-sm mb-4">
              {searchQuery ? `No lines matching "${searchQuery}"` : 'No lyrics yet.'}
            </p>
            <button
              onClick={() => handleAddLine()}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-amber-400 text-black font-semibold text-xs cursor-pointer shadow-lg hover:bg-amber-300"
            >
              <PlusIcon className="w-3.5 h-3.5" />
              <span>Add First Lyric Line</span>
            </button>
          </div>
        ) : (
          filteredLines.map(({ line, originalIndex: idx }) => {
            const isActive = currentTime >= line.start && currentTime <= line.end + 0.3
            const isWordsExpanded = expandedWordIndices.has(idx)
            const durationSec = Math.max(0, line.end - line.start).toFixed(2)

            return (
              <div
                key={idx}
                ref={isActive ? activeLineRef : null}
                className={`rounded-2xl border transition-all duration-150 p-4 ${
                  isActive
                    ? 'bg-amber-500/[0.07] border-amber-400/40 ring-1 ring-amber-400/30 shadow-lg'
                    : 'glass border-white/10 hover:border-white/20 bg-white/[0.02]'
                }`}
              >
                {/* Header Row: Index, Audition, Timestamps, Actions */}
                <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
                  <div className="flex items-center gap-2.5">
                    {/* Line Index Badge */}
                    <span
                      className={`text-[11px] font-mono font-bold px-2 py-0.5 rounded-md ${
                        isActive
                          ? 'bg-amber-400 text-black'
                          : 'bg-white/10 text-white/60'
                      }`}
                    >
                      #{idx + 1}
                    </span>

                    {/* Quick Audition Button */}
                    <button
                      onClick={() => onSeek(line.start)}
                      className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white/10 hover:bg-amber-400 hover:text-black text-white/80 text-xs font-mono font-medium transition-colors cursor-pointer"
                      title="Play from this line start"
                    >
                      <PlayIcon className="w-3 h-3" />
                      <span>{fmtFullTime(line.start)}</span>
                    </button>

                    {isActive && (
                      <span className="text-[10px] font-semibold text-amber-300 bg-amber-400/20 px-2 py-0.5 rounded-full border border-amber-400/30 animate-pulse">
                        PLAYING
                      </span>
                    )}
                  </div>

                  {/* Timing Adjusters */}
                  <div className="flex items-center gap-4 flex-wrap text-xs">
                    {/* Start Time Adjuster */}
                    <div className="flex items-center gap-1 glass px-2.5 py-1 rounded-lg border border-white/10">
                      <span className="text-white/40 text-[11px] font-mono">START:</span>
                      <button
                        onClick={() => handleNudge(idx, 'start', -0.2)}
                        className="px-1.5 py-0.5 rounded hover:bg-white/20 text-white/70 hover:text-white font-mono text-[10px] cursor-pointer"
                        title="Nudge earlier by 0.2s"
                      >
                        -0.2s
                      </button>
                      <input
                        type="number"
                        step={0.05}
                        min={0}
                        value={fmtSec(line.start)}
                        onChange={(e) =>
                          handleTimeInput(idx, 'start', parseFloat(e.target.value))
                        }
                        className="w-14 bg-black/40 text-center font-mono text-amber-300 text-xs rounded px-1 py-0.5 border border-white/10 focus:outline-none focus:border-amber-400"
                        title="Direct start time in seconds"
                      />
                      <button
                        onClick={() => handleNudge(idx, 'start', 0.2)}
                        className="px-1.5 py-0.5 rounded hover:bg-white/20 text-white/70 hover:text-white font-mono text-[10px] cursor-pointer"
                        title="Nudge later by 0.2s"
                      >
                        +0.2s
                      </button>
                    </div>

                    {/* End Time Adjuster */}
                    <div className="flex items-center gap-1 glass px-2.5 py-1 rounded-lg border border-white/10">
                      <span className="text-white/40 text-[11px] font-mono">END:</span>
                      <button
                        onClick={() => handleNudge(idx, 'end', -0.2)}
                        className="px-1.5 py-0.5 rounded hover:bg-white/20 text-white/70 hover:text-white font-mono text-[10px] cursor-pointer"
                        title="Nudge earlier by 0.2s"
                      >
                        -0.2s
                      </button>
                      <input
                        type="number"
                        step={0.05}
                        min={0}
                        value={fmtSec(line.end)}
                        onChange={(e) =>
                          handleTimeInput(idx, 'end', parseFloat(e.target.value))
                        }
                        className="w-14 bg-black/40 text-center font-mono text-amber-300 text-xs rounded px-1 py-0.5 border border-white/10 focus:outline-none focus:border-amber-400"
                        title="Direct end time in seconds"
                      />
                      <button
                        onClick={() => handleNudge(idx, 'end', 0.2)}
                        className="px-1.5 py-0.5 rounded hover:bg-white/20 text-white/70 hover:text-white font-mono text-[10px] cursor-pointer"
                        title="Nudge later by 0.2s"
                      >
                        +0.2s
                      </button>
                    </div>

                    <span className="text-[11px] text-white/40 font-mono">
                      dur: {durationSec}s
                    </span>

                    {/* Line Operations */}
                    <div className="flex items-center gap-1 border-l border-white/10 pl-2">
                      {idx < lines.length - 1 && (
                        <button
                          onClick={() => handleMergeWithNext(idx)}
                          className="px-2 py-1 rounded-md glass hover:bg-white/15 text-white/60 hover:text-white text-[11px] transition-colors cursor-pointer"
                          title="Merge with next line"
                        >
                          Merge ▼
                        </button>
                      )}
                      <button
                        onClick={() => handleAddLine(idx)}
                        className="p-1 rounded-md glass hover:bg-white/15 text-white/60 hover:text-white transition-colors cursor-pointer"
                        title="Insert new line below this one"
                      >
                        <PlusIcon className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => handleDeleteLine(idx)}
                        className="p-1 rounded-md glass hover:bg-red-500/20 text-white/50 hover:text-red-400 transition-colors cursor-pointer"
                        title="Delete line"
                      >
                        <TrashIcon className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>

                {/* Line Text Input */}
                <div className="relative mb-2">
                  <input
                    type="text"
                    value={line.text}
                    onChange={(e) => handleUpdateLineText(idx, e.target.value)}
                    className="w-full bg-black/50 border border-white/15 focus:border-amber-400/80 rounded-xl px-4 py-2.5 text-base md:text-lg font-medium text-white focus:outline-none transition-colors"
                    placeholder="Enter lyric line text…"
                  />
                </div>

                {/* Expand Word Timing Chips Toggle */}
                {line.words && line.words.length > 0 && (
                  <div className="mt-2">
                    <button
                      onClick={() => toggleWordsExpanded(idx)}
                      className="text-[11px] text-white/50 hover:text-amber-300 font-mono flex items-center gap-1 cursor-pointer transition-colors"
                    >
                      <span>{isWordsExpanded ? '▼ Hide' : '▶ Show'} Word Timings</span>
                      <span>({line.words.length} words)</span>
                    </button>

                    {/* Word Timing Chips Container */}
                    {isWordsExpanded && (
                      <div className="mt-3 p-3 rounded-xl bg-black/30 border border-white/10 space-y-2 animate-in fade-in duration-150">
                        <div className="text-[10px] font-mono text-white/40 uppercase tracking-wider mb-2">
                          Individual Word Timestamps & Split Controls
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {line.words.map((w, wIdx) => {
                            const isWordActive =
                              currentTime >= w.start && currentTime < w.end

                            return (
                              <div
                                key={wIdx}
                                className={`flex items-center gap-1.5 p-1.5 rounded-lg border text-xs transition-all ${
                                  isWordActive
                                    ? 'bg-amber-400/20 border-amber-400/50 shadow-sm'
                                    : 'glass border-white/10 hover:border-white/20'
                                }`}
                              >
                                <button
                                  onClick={() => onSeek(w.start)}
                                  className="text-white/60 hover:text-amber-400 cursor-pointer p-0.5"
                                  title="Audition word"
                                >
                                  <PlayIcon className="w-2.5 h-2.5" />
                                </button>
                                <input
                                  type="text"
                                  value={w.word}
                                  onChange={(e) =>
                                    handleUpdateWord(idx, wIdx, { word: e.target.value })
                                  }
                                  className="w-16 bg-transparent text-white font-medium text-xs focus:outline-none focus:underline"
                                />
                                <span className="text-[10px] font-mono text-white/40 tabular-nums">
                                  {fmtSec(w.start)}-{fmtSec(w.end)}
                                </span>
                                {wIdx < line.words.length - 1 && (
                                  <button
                                    onClick={() => handleSplitLine(idx, wIdx + 1)}
                                    className="text-[10px] text-white/40 hover:text-amber-300 px-1 py-0.5 rounded hover:bg-white/10 font-mono cursor-pointer"
                                    title="Split into new line after this word"
                                  >
                                    ✂ split
                                  </button>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
