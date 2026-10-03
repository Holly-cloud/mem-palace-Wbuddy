'use strict';
/**
 * preload —— 渲染进程与主进程之间的唯一通道。
 *
 * 只暴露白名单方法，不暴露 ipcRenderer 本身，
 * 这样即使渲染进程被注入脚本，也无法调用未授权的 IPC。
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const listeners = new Map();

function on(channel, handler) {
  const wrapped = (_e, payload) => handler(payload);
  ipcRenderer.on(channel, wrapped);
  if (!listeners.has(channel)) listeners.set(channel, []);
  listeners.get(channel).push(wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
    const arr = listeners.get(channel) || [];
    const i = arr.indexOf(wrapped);
    if (i >= 0) arr.splice(i, 1);
  };
}

contextBridge.exposeInMainWorld('forge', {
  // 文件
  openFiles: () => ipcRenderer.invoke('dialog:openFiles'),
  openDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
  readFiles: (paths) => ipcRenderer.invoke('fs:readFiles', paths),
  readRecordText: (filePath, recordIds) => ipcRenderer.invoke('fs:readRecordText', { filePath, recordIds }),
  // 拖拽取真实路径：Electron 32+ 必须用 webUtils，File.path 已移除
  pathsFromDropped: (files) =>
    Array.from(files || []).map((f) => {
      try { return webUtils.getPathForFile(f); } catch (_) { return null; }
    }).filter(Boolean),

  // 模型
  detectModels: (config) => ipcRenderer.invoke('llm:detect', config),
  testModel: (config) => ipcRenderer.invoke('llm:test', config),

  // 抽取
  startExtract: (payload) => ipcRenderer.invoke('extract:start', payload),
  cancelExtract: (jobId) => ipcRenderer.invoke('extract:cancel', { jobId }),

  // 元信息
  getTypes: () => ipcRenderer.invoke('meta:types'),
  getStrategies: () => ipcRenderer.invoke('meta:strategies'),

  // 浅尝模式
  trialInspect: (payload) => ipcRenderer.invoke('trial:inspect', payload),
  commitTrialParams: (payload) => ipcRenderer.invoke('trial:commitParams', payload),

  // Agent 驱动模式（无需配置模型）
  agentMakeTask: (payload) => ipcRenderer.invoke('agent:makeTask', payload),
  agentStatus: (taskDir) => ipcRenderer.invoke('agent:status', { taskDir }),
  agentImport: (payload) => ipcRenderer.invoke('agent:import', payload),
  agentWrite: (payload) => ipcRenderer.invoke('agent:write', payload),

  // 格式探查（格式不统一时先让 agent 勘察）
  probeMakeTask: (filePaths) => ipcRenderer.invoke('probe:makeTask', { filePaths }),
  probeStatus: (probeDir) => ipcRenderer.invoke('probe:status', { probeDir }),
  probeSplit: (payload) => ipcRenderer.invoke('probe:split', payload),

  // palace
  loadPalace: (root) => ipcRenderer.invoke('palace:load', { root }),

  // 导出
  previewExport: (payload) => ipcRenderer.invoke('export:preview', payload),
  writeExport: (payload) => ipcRenderer.invoke('export:write', payload),

  // 事件订阅
  onExtractProgress: (cb) => on('extract:progress', cb),
  onExtractDone: (cb) => on('extract:done', cb),
  onExtractError: (cb) => on('extract:chunkError', cb),
  onExtractCancelled: (cb) => on('extract:cancelled', cb),
  onExtractFailed: (cb) => on('extract:failed', cb),
});
