#!/bin/bash
# 重启 dsh web（让新的内置 compressPrompt 生效）。
# 先睡一会儿，等当前回合把回复发完；再 SIGTERM 掉 dsh web 子进程，
# 由 fnOS 应用中心包装器（/vol1/@appcenter/deepseek.harness/bin/deepseek.harness）自动拉活。
# 若 90s 内 2298 没回来，则按原命令行手动补拉，避免把服务留成死的。
LOG=/vol1/@appdata/deepseek.harness/harness.log
say() { echo "$(date '+%Y-%m-%d %H:%M:%S') [restart-dsh] $*" >> "$LOG"; }

sleep "${RESTART_DELAY:-45}"

PID=$(ss -ltnp 2>/dev/null | grep '127.0.0.1:2298' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
if [ -z "$PID" ]; then
  say "port 2298 not listening; nothing to restart"
  exit 0
fi
say "terminating dsh web (pid=$PID) to load new built-in compressPrompt"
kill "$PID" 2>/dev/null

for i in $(seq 1 90); do
  sleep 1
  if ss -ltn 2>/dev/null | grep -q '127.0.0.1:2298'; then
    say "port 2298 is back after ${i}s (wrapper revived it)"
    exit 0
  fi
done

say "wrapper did not revive the service; launching manually"
cd /vol1/@appdata/deepseek.harness/dsh-runtime || exit 1
nohup /var/apps/nodejs_v24/target/bin/node \
  /vol1/@appdata/deepseek.harness/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js \
  web --port 2298 --no-open >> "$LOG" 2>&1 &
say "manual launch issued (pid=$!)"
