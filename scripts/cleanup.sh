#!/bin/bash
# 清理 elf 相关端口占用 (8080=Gateway, 8081+=Agent)
PORTS="8080 8081 8082 8083 8084 8085 9876 9877 9880"

for port in $PORTS; do
  pids=$(lsof -ti :$port 2>/dev/null)
  if [ -n "$pids" ]; then
    echo "端口 $port 被占用 (PID: $(echo $pids | tr '\n' ' ')), 正在清理..."
    echo "$pids" | xargs kill -9 2>/dev/null
  fi
done

echo "清理完成"