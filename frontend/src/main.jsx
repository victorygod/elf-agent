import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './global.css';
import useAgentStore from './stores/agentStore';
import { reportClientError } from './api';

// 全局未捕获错误兜底：运行时异常 + 未处理 Promise reject 都 toast + 上报后端 frontend.log
window.addEventListener('error', (ev) => {
  const err = ev.error || new Error(ev.message || '未知错误');
  useAgentStore.getState().showToast(`前端错误：${err.message || err}`);
  reportClientError(err, { source: 'window.error', filename: ev.filename, lineno: ev.lineno });
});
window.addEventListener('unhandledrejection', (ev) => {
  const err = ev.reason instanceof Error ? ev.reason : new Error(String(ev.reason));
  useAgentStore.getState().showToast(`未处理异常：${err.message || err}`);
  reportClientError(err, { source: 'unhandledrejection' });
});

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);