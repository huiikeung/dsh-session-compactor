#!/bin/bash
# 恢复 dsh 的 fnOS 监管状态。
# 背景：为让新的内置 compressPrompt 生效，之前直接 SIGTERM 了 dsh web 子进程。
# fnOS 包装器（/vol1/@appcenter/deepseek.harness/bin/deepseek.harness）检测到子进程死亡后
# 把自己置成 stopped 并停掉了 2299 代理，且不会自动拉活；于脚本里手动补拉的 dsh web
# 只监听 2298（+ 插件自己的 3081），2299  LAN 入口是缺的。
# 本脚本：停掉手动拉的 dsh web → 重启包装器 → 让它按 config.json(last_run_state=running)
# 自己把 web + 2299 代理都拉起来。trim 守护进程若拉活包装器就走快路，否则用保存的
# 环境变量手动补拉；再不行退回「只保 2298 可用」。
set -u
LOG=/vol1/@appdata/deepseek.harness/harness.log
ENV_FILE=/tmp/wrapper.env
WRAPPER_BIN=/vol1/@appcenter/deepseek.harness/bin/deepseek.harness
DSH_NODE=/var/apps/nodejs_v24/target/bin/node
DSH_BIN=/vol1/@appdata/deepseek.harness/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js

say() { echo "$(date '+%Y-%m-%d %H:%M:%S') [recover-dsh] $*" >> "$LOG"; }

listen() { ss -ltn 2>/dev/null | grep -q "$1"; }
pid_on() { ss -ltnp 2>/dev/null | grep "$1" | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2; }
wrapper_pids() { pgrep -f "$WRAPPER_BIN" 2>/dev/null | tr '\n' ' '; }

wait_for() { # $1=端口 $2=秒
  local i
  for i in $(seq 1 "$2"); do
    listen "$1" && return 0
    sleep 1
  done
  return 1
}

sleep "${RECOVER_DELAY:-30}"
say "start: current wrapper=$(wrapper_pids) web=$(pid_on 2298) proxy=$(pid_on 2299)"

# 1) 停掉手动补拉的 dsh web（不是包装器拉的，杀了不影响监管）
WEB_PID=$(pid_on 2298)
if [ -n "${WEB_PID:-}" ]; then
  say "stopping manually-launched dsh web (pid=$WEB_PID)"
  kill "$WEB_PID" 2>/dev/null
  for _ in $(seq 1 30); do kill -0 "$WEB_PID" 2>/dev/null || break; sleep 1; done
  kill -0 "$WEB_PID" 2>/dev/null && { say "pid $WEB_PID still alive; SIGKILL"; kill -9 "$WEB_PID" 2>/dev/null; sleep 2; }
fi

# 2) 重启包装器（trim 可能会自动拉活；等 60s 看）
OLD_WRAPPER=$(wrapper_pids)
if [ -n "${OLD_WRAPPER:-}" ]; then
  say "restarting fnOS wrapper (pid=$OLD_WRAPPER)"
  kill $OLD_WRAPPER 2>/dev/null
  sleep 5
fi

NEW_WRAPPER=""
for i in $(seq 1 60); do
  NEW_WRAPPER=$(wrapper_pids)
  [ -n "$NEW_WRAPPER" ] && break
  sleep 1
done

# 3) 包装器没回来 → 用保存的环境变量手动补拉
if [ -z "$NEW_WRAPPER" ]; then
  say "wrapper did not come back within 60s; relaunching with saved env"
  if [ -f "$ENV_FILE" ]; then
    set -a; . "$ENV_FILE"; set +a
  fi
  cd / || exit 1
  nohup "$WRAPPER_BIN" >> "$LOG" 2>&1 &
  say "wrapper relaunch issued (pid=$!)"
  for i in $(seq 1 60); do
    NEW_WRAPPER=$(wrapper_pids)
    [ -n "$NEW_WRAPPER" ] && break
    sleep 1
  done
fi
say "wrapper now: ${NEW_WRAPPER:-none}"

# 4) 等 web(2298) + 代理(2299) 都起来
if wait_for 2298 180; then say "web 2298 is up"; else say "WARN: web 2298 still down after 180s"; fi
if wait_for 2299 60; then say "proxy 2299 is up"; else say "WARN: proxy 2299 still down after 60s"; fi

# 5) 兜底：2298 还没起来就只把 GUI 保活（退回手动拉 web）
if ! listen 2298; then
  say "last resort: launching dsh web manually so the GUI stays reachable"
  cd /vol1/@appdata/deepseek.harness/dsh-runtime || exit 1
  nohup "$DSH_NODE" "$DSH_BIN" web --port 2298 --no-open >> "$LOG" 2>&1 &
  say "manual web launch issued (pid=$!)"
  wait_for 2298 120 && say "web 2298 up (manual)" || say "ERROR: web 2298 could not be started"
fi

say "done: web=$(pid_on 2298) proxy=$(pid_on 2299) lan3081=$(pid_on 3081) wrapper=$(wrapper_pids)"
