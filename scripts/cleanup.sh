#!/bin/bash
# 清理 elf 相关端口占用
# 动态读取 Gateway 端口 + 所有 Agent 端口，逐一清理

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

PORTS=""

# 1. 读取 Gateway 端口（gateway.json）
GATEWAY_CONFIG="$PROJECT_DIR/gateway.json"
if [ -f "$GATEWAY_CONFIG" ]; then
  GW_PORT=$(grep -o '"port"[[:space:]]*:[[:space:]]*[0-9]*' "$GATEWAY_CONFIG" | grep -o '[0-9]*$' | head -1)
  if [ -n "$GW_PORT" ]; then
    PORTS="$PORTS $GW_PORT"
  fi
fi

# 2. 读取所有 Agent 端口（agents/*/config/config.json）
AGENTS_DIR="$PROJECT_DIR/agents"
if [ -d "$AGENTS_DIR" ]; then
  for agent_dir in "$AGENTS_DIR"/*/; do
    CONFIG_FILE="$agent_dir/config/config.json"
    if [ -f "$CONFIG_FILE" ]; then
      AGENT_PORT=$(grep -o '"port"[[:space:]]*:[[:space:]]*[0-9]*' "$CONFIG_FILE" | grep -o '[0-9]*$' | head -1)
      if [ -n "$AGENT_PORT" ]; then
        PORTS="$PORTS $AGENT_PORT"
      fi
    fi
  done
fi

# 去重
PORTS=$(echo $PORTS | tr ' ' '\n' | sort -u | tr '\n' ' ')

if [ -z "$PORTS" ]; then
  echo "未发现任何端口配置，退出"
  exit 0
fi

echo "检测到端口: $(echo $PORTS | xargs)"

for port in $PORTS; do
  pids=$(lsof -ti :$port -sTCP:LISTEN 2>/dev/null)
  if [ -n "$pids" ]; then
    echo "端口 $port 被占用 (PID: $(echo $pids | tr '\n' ' ')), 正在清理..."
    echo "$pids" | xargs kill -9 2>/dev/null
  else
    echo "端口 $port 空闲"
  fi
done

echo "清理完成"