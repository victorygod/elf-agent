/**
 * AgentPageRenderer — Agent 自定义页面渲染器
 *
 * 根据 agent 的 ui/manifest.json 加载对应的聊天区组件。
 * 没有自定义组件的 agent 不走此组件（App.jsx 分歧后走 ChatPanel）。
 */

import React, { useState, useEffect } from 'react';
import { getAgentManifest, loadAgentComponent } from '../pluginRegistry';
import useBridge from '../hooks/useBridge';
import ChatPanel from './ChatPanel';

export default function AgentPageRenderer({ agentId }) {
  const [Component, setComponent] = useState(null);
  const [loading, setLoading] = useState(true);
  const bridge = useBridge(agentId);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      const manifest = getAgentManifest(agentId);
      if (!manifest?.page?.chatView) {
        // 没有定义 chatView → 走默认 ChatPanel
        setLoading(false);
        return;
      }

      const Comp = await loadAgentComponent(agentId, manifest.page.chatView);
      if (cancelled) return;

      if (Comp) {
        setComponent(() => Comp);
      } else {
        // 组件加载失败 → fallback 到默认 ChatPanel
        setComponent(null);
      }
      setLoading(false);
    }

    load();
    return () => { cancelled = true; };
  }, [agentId]);

  if (loading) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#999' }}>加载自定义页面…</div>;
  }

  if (Component) {
    return <Component bridge={bridge} />;
  }

  // fallback：没有 chatView 或加载失败 → 默认 ChatPanel
  return <ChatPanel agentId={agentId} />;
}