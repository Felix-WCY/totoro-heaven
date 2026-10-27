'use strict'

/**
 * 桌面端预加载脚本（Electron preload）。
 *
 * 只暴露最小能力：`window.totoroDesktop.locate()` → 主进程用 Windows 定位服务取坐标。
 *
 * 为什么需要它：Electron 自带的 Chromium 在 Windows/国内环境下经常拿不到定位
 * （没有 Google 定位服务；`WinrtGeolocationImplementation` 在当前 Chromium 里已无效），
 * 但 Windows 自带的 `Windows.Devices.Geolocation`（WinRT）是可用的 —— 由主进程去问，
 * 再通过 IPC 把经纬度回给页面。页面侧仍以 `navigator.geolocation` 为兜底。
 */

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('totoroDesktop', {
  platform: process.platform,
  /** @returns {Promise<{ok:boolean,latitude?:number,longitude?:number,accuracy?:number,error?:string}>} */
  locate: () => ipcRenderer.invoke('totoro:geolocate'),
})
