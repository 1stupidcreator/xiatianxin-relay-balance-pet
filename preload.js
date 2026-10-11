// 预加载脚本：通过 contextBridge 暴露安全的桌宠 API 给渲染层
'use strict'
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('pet', {
  // 余额
  getBalance: () => ipcRenderer.invoke('pet:get-balance'),
  // 屏幕/位置
  getScreen: () => ipcRenderer.invoke('pet:get-screen'),
  getGeometry: () => ipcRenderer.invoke('pet:get-geometry'),
  onGeometryUpdated: (cb) => {
    const listener = (_event, geometry) => cb(geometry)
    ipcRenderer.on('pet:geometry-updated', listener)
    return () => ipcRenderer.removeListener('pet:geometry-updated', listener)
  },
  getPosition: () => ipcRenderer.invoke('pet:get-position'),
  setPosition: (x, y) => ipcRenderer.invoke('pet:set-position', { x, y }),
  // 尺寸
  getSize: () => ipcRenderer.invoke('pet:get-size'),
  setScale: (scale) => ipcRenderer.invoke('pet:set-scale', { scale }),
  // 配置
  getConfig: () => ipcRenderer.invoke('pet:get-config'),
  getFullConfig: () => ipcRenderer.invoke('pet:get-full-config'),
  saveApiKey: (apiKey) => ipcRenderer.invoke('pet:save-key', { apiKey }),
  saveSettings: (settings) => ipcRenderer.invoke('pet:save-settings', settings),
  // 统计
  getStats: () => ipcRenderer.invoke('pet:get-stats'),
  getUsage24h: () => ipcRenderer.invoke('pet:get-usage-24h'),
  getUsageWindow: (hours) => ipcRenderer.invoke('pet:get-usage-window', hours),
  getLocalCacheStats: (options) => ipcRenderer.invoke('pet:get-local-cache-stats', { force: !!(options && options.force === true) }),
  getCacheMonitor: () => ipcRenderer.invoke('pet:get-cache-monitor'),
  pauseCacheMonitor: (hours) => ipcRenderer.invoke('pet:pause-cache-monitor', hours),
  resumeCacheMonitor: () => ipcRenderer.invoke('pet:resume-cache-monitor'),
  testCacheAlert: () => ipcRenderer.invoke('pet:test-cache-alert'),
  openStats: () => ipcRenderer.invoke('pet:open-stats'),
  // 远程推送（预留）
  testPush: () => ipcRenderer.invoke('pet:test-push'),
  // 闲置透明度
  setIdle: (idle) => ipcRenderer.invoke('pet:set-idle', { idle }),
  // 图片
  getImageUrl: () => ipcRenderer.invoke('pet:get-image-url'),
  chooseImage: () => ipcRenderer.invoke('pet:choose-image'),
  // 事件
  onCacheMonitorUpdated: (cb) => {
    const listener = (_event, data) => cb(data)
    ipcRenderer.on('pet:cache-monitor-updated', listener)
    return () => ipcRenderer.removeListener('pet:cache-monitor-updated', listener)
  },
  onDailySpendAlert: (cb) => {
    const listener = (_event, data) => cb(data)
    ipcRenderer.on('pet:daily-spend-alert', listener)
    return () => ipcRenderer.removeListener('pet:daily-spend-alert', listener)
  },
  onRefreshRequested: (cb) => {
    const listener = () => cb()
    ipcRenderer.on('pet:refresh', listener)
    return () => ipcRenderer.removeListener('pet:refresh', listener)
  },
  onConfigUpdated: (cb) => {
    const listener = () => cb()
    ipcRenderer.on('pet:config-updated', listener)
    return () => ipcRenderer.removeListener('pet:config-updated', listener)
  },
  // 其它
  getVisibility: () => ipcRenderer.invoke('pet:get-visibility'),
  setManualHidden: (hidden) => ipcRenderer.invoke('pet:set-manual-hidden', hidden),
  onVisibilityUpdated: (cb) => {
    const listener = (_event, state) => cb(state)
    ipcRenderer.on('pet:visibility-updated', listener)
    return () => ipcRenderer.removeListener('pet:visibility-updated', listener)
  },
  hideTemporarily: () => ipcRenderer.invoke('pet:hide-temporarily'),
  openSettings: () => ipcRenderer.invoke('pet:open-settings'),
  closeSettings: () => ipcRenderer.invoke('pet:close-settings'),
  quit: () => ipcRenderer.invoke('pet:quit'),
})
