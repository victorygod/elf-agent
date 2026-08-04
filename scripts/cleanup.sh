#!/bin/bash
# 清理 elf 相关进程/端口占用（v4：共享 agent-server 模型）
#
# 改造前：扫 agents/*/config 的 N 个 agent 端口 + grep 群聊副本(--mode room) + run.json 兜底。
# 改造后：1 个 gateway(8080) + 1 个共享 agent-server(agentServerPort，默认 8180)。
#   本期 M=1 单 server；将来 M>1 时，这里改为枚举注册表里的 server 端口。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

PORTS=""

# 1. gateway 端口（gateway.json: port，默认 8080）
GATEWAY_CONFIG="$PROJECT_DIR/gateway.json"
if [ -f "$GATEWAY_CONFIG" ]; then
  GW_PORT=$(grep -o '"port"[[:space:]]*:[[:space:]]*[0-9]*' "$GATEWAY_CONFIG" | grep -o '[0-9]*$' | head -1)
  [ -n "$GW_PORT" ] && PORTS="$PORTS $GW_PORT"
fi

# 2. 共享 agent-server 端口（gateway.json: agentServerPort，默认 8180）
if [ -f "$GATEWAY_CONFIG" ]; then
  AS_PORT=$(grep -o '"agentServerPort"[[:space:]]*:[[:space:]]*[0-9]*' "$GATEWAY_CONFIG" | grep -o '[0-9]*$' | head -1)
  [ -n "$AS_PORT" ] && PORTS="$PORTS $AS_PORT"
fi

# 去重
PORTS=$(echo $PORTS | tr ' ' '\n' | sort -u | tr '\n' ' ')
echo "检测到端口: $(echo $PORTS | xargs)"

# 3. 杀所有 elf agent 进程（engine/start.js：含共享 server --serve-all + 历史残留 --mode room 副本 + standalone）
echo "清理 agent 进程..."
PIDS=$(ps aux | grep "engine/start.js" | grep -v grep | awk '{print $2}')
if [ -n "$PIDS" ]; then
  echo "发现 $(echo "$PIDS" | wc -l | tr -d ' ') 个 agent 进程，正在终止..."
  echo "$PIDS" | xargs kill -9 2>/dev/null
fi

# 4. 按端口清理（gateway + agent-server 端口）
for port in $PORTS; do
  pids=$(lsof -ti :$port -sTCP:LISTEN 2>/dev/null)
  if [ -n "$pids" ]; then
    echo "端口 $port 被占用 (PID: $(echo $pids | tr '\n' ' ')), 正在清理..."
    echo "$pids" | xargs kill -9 2>/dev/null
  else
    [ -n "$port" ] && echo "端口 $port 空闲"
  fi
done

echo "清理完成"
