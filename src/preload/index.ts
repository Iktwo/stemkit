import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { JobEvent, EnvEvent, UpdateEvent, AppSettings, StemKitApi, LyricsProgress, TabProgress } from '../shared/types'

function subscribe<T>(channel: string, cb: (data: T) => void): () => void {
  const handler = (_e: IpcRendererEvent, data: T): void => cb(data)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

const api: StemKitApi = {
  envStatus: () => ipcRenderer.invoke('env:status'),
  envBootstrap: () => ipcRenderer.invoke('env:bootstrap'),
  envUpdateYtDlp: () => ipcRenderer.invoke('env:update-ytdlp'),
  listSongs: () => ipcRenderer.invoke('library:list'),
  deleteSong: (videoId) => ipcRenderer.invoke('library:delete', videoId),
  getBuffers: (videoId) => ipcRenderer.invoke('song:buffers', videoId),
  exportStem: (videoId, stem) => ipcRenderer.invoke('stem:export', videoId, stem),
  exportAllStems: (videoId) => ipcRenderer.invoke('stems:export-all', videoId),
  searchYouTube: (query) => ipcRenderer.invoke('search:youtube', query),
  startJob: (url, model, stems, force) => ipcRenderer.invoke('jobs:start', url, model, stems, force),
  cancelJob: (videoId?: string) => ipcRenderer.invoke('jobs:cancel', videoId),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  getAppVersion: () => ipcRenderer.invoke('app:version'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  getThumb: (videoId) => ipcRenderer.invoke('thumb:get', videoId),
  enginesStatus: () => ipcRenderer.invoke('engines:status'),
  fetchEngine: (which) => ipcRenderer.invoke('engines:fetch', which),
  getLyrics: (videoId) => ipcRenderer.invoke('lyrics:get', videoId),
  transcribeLyrics: (videoId, model) => ipcRenderer.invoke('lyrics:transcribe', videoId, model),
  saveLyrics: (videoId, data) => ipcRenderer.invoke('lyrics:save', videoId, data),
  getTabs: (videoId, instrument) => ipcRenderer.invoke('tab:get', videoId, instrument),
  transcribeTabs: (videoId, tuning, position, sensitivity, mode, voicing, force, instrument) =>
    ipcRenderer.invoke(
      'tab:transcribe',
      videoId,
      tuning,
      position,
      sensitivity,
      mode,
      voicing,
      force,
      instrument
    ),
  saveTabs: (videoId, data, instrument) => ipcRenderer.invoke('tab:save', videoId, data, instrument),
  exportTabMidi: (videoId, instrument) => ipcRenderer.invoke('tab:exportMidi', videoId, instrument),
  exportTabAscii: (videoId, instrument) => ipcRenderer.invoke('tab:exportAscii', videoId, instrument),
  onUpdateEvent: (cb) => subscribe<UpdateEvent>('update:event', cb),
  onJobEvent: (cb) => subscribe<JobEvent>('job:event', cb),
  onEnvEvent: (cb) => subscribe<EnvEvent>('env:event', cb),
  onSettingsChange: (cb) => subscribe<AppSettings>('settings:changed', cb),
  onLyricsProgress: (cb) => subscribe<LyricsProgress>('lyrics:progress', cb),
  onTabProgress: (cb) => subscribe<TabProgress>('tab:progress', cb)
}

contextBridge.exposeInMainWorld('stemkit', api)
