#!/data/data/com.termux/files/usr/bin/bash
# DSH Tavern × Termux 单文件：装 + 移动版布局 + 启动 + 自动打开酒馆页面。
#   bash termux-tavern.sh [install|start|stop|restart|status|open|update|logs]
# 三条硬约束（脚本已按它们处理）：服务必须活在常驻 proot 里（proot 退出=进程失去
# rootfs）；容器脚本走 --shared-tmp 传入、不支持时退回 stdin；探活只认端口和日志 token。
set -euo pipefail

VERSION=2026-10-27.3
DISTRO=ubuntu
NODE_VERSION=24.20.0
PORT=3081
INNER='export PATH=/usr/local/node/bin:$HOME/.local/bin:$PATH'
PIDFILE=$PREFIX/var/run/tavern-proot.pid
INNER_SCRIPT=$PREFIX/tmp/tavern-inner.sh
WAIT_SCRIPT=$PREFIX/tmp/tavern-wait.sh
WAIT_OUT=$PREFIX/tmp/tavern-wait.out

mkdir -p "$(dirname -- "$PIDFILE")" "$(dirname -- "$INNER_SCRIPT")"
log() { printf '%s\n' "$*"; }
die() { printf '错误：%s\n' "$*" >&2; exit 1; }

# 自更新：仓库里的 scripts/termux/termux-tavern.sh 是唯一源，脚本比对版本号后自替换，
# 之后手机上不必再手工传文件（CDN 未同步或离线时静默跳过）。
# 自更新源：raw.githubusercontent 实时反映 main；被墙时退回 jsDelivr。
SELF_URLS=${TERMUX_TAVERN_URL:-https://raw.githubusercontent.com/flizzywine/dsh-tavern/main/scripts/termux/termux-tavern.sh https://cdn.jsdelivr.net/gh/flizzywine/dsh-tavern@main/scripts/termux/termux-tavern.sh}
self_update() {
  [ -n "${TERMUX_TAVERN_NO_SELF_UPDATE:-}" ] && return 0
  command -v curl >/dev/null 2>&1 || return 0
  local self tmp new
  self=$(readlink -f "$0" 2>/dev/null || printf '%s' "$0")
  [ -w "$self" ] || return 0
  tmp=$PREFIX/tmp/termux-tavern.new
  local got='' u
  for u in $SELF_URLS; do
    if curl -fsSL --connect-timeout 8 --max-time 25 "$u" -o "$tmp" 2>/dev/null; then got=1; break; fi
  done
  [ -n "$got" ] || return 0
  bash -n "$tmp" 2>/dev/null || { rm -f "$tmp"; return 0; }
  new=$(sed -n 's/^VERSION=//p' "$tmp" | head -n 1)
  [ -n "$new" ] && [ "$new" != "$VERSION" ] || { rm -f "$tmp"; return 0; }
  if cp "$tmp" "$self" && chmod +x "$self"; then
    rm -f "$tmp"
    log "脚本已更新：$VERSION → $new"
    TERMUX_TAVERN_NO_SELF_UPDATE=1 exec bash "$self" "$@"
  fi
  rm -f "$tmp"
  return 0
}

ensure_pkg() {
  command -v "$1" >/dev/null 2>&1 && return 0
  apt install -y "$1" 2>/dev/null && return 0
  local f
  for f in "$PREFIX"/etc/apt/sources.list.d/*; do
    [ -f "$f" ] || continue
    grep -qs 'tur\.kcubeterm\.com' "$f" && mv "$f" "$f.disabled"
  done
  pkg update -y >/dev/null 2>&1 || true
  apt install -y "$1"
}

container_ready() { proot-distro login "$DISTRO" -- true >/dev/null 2>&1; }
daemon_alive() { [ -r "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }

write_inner() {
  cat > "$INNER_SCRIPT" <<'INNER_EOF'
set -e
V=24.20.0
export DEBIAN_FRONTEND=noninteractive
grab() {
  local out=$1; shift
  local u
  for u in "$@"; do
    curl -fsSL --connect-timeout 15 --max-time 900 "$u" -o "$out" && return 0
    echo "   下载失败：$u"
  done
  return 1
}
if ! command -v curl >/dev/null || ! command -v tar >/dev/null || ! command -v git >/dev/null; then
  echo '[容器] 安装基础包'
  apt-get update
  apt-get install -y --no-install-recommends ca-certificates curl tar xz-utils git procps
fi
if [ ! -x /usr/local/node/bin/node ]; then
  echo "[容器] 安装 Node $V"
  d=$(mktemp -d)
  grab "$d/n.txz" \
    "https://nodejs.org/dist/v$V/node-v$V-linux-arm64.tar.xz" \
    "https://npmmirror.com/mirrors/node/v$V/node-v$V-linux-arm64.tar.xz" \
    "https://mirrors.tuna.tsinghua.edu.cn/nodejs-release/v$V/node-v$V-linux-arm64.tar.xz" \
    || { echo 'Node 下载失败（网络）' >&2; exit 1; }
  tar -tJf "$d/n.txz" >/dev/null 2>&1 || { echo 'Node 包不完整' >&2; exit 1; }
  mkdir -p /usr/local/node
  tar -xJf "$d/n.txz" -C /usr/local/node --strip-components=1
  rm -rf "$d"
fi
export PATH=/usr/local/node/bin:$HOME/.local/bin:$PATH
echo "[容器] Node $(node -v)"
if [ ! -f "$HOME/.dsh-tavern/apps/dsh-tavern/bin/dsh-tavern.mjs" ]; then
  echo '[容器] 安装酒馆（首次 10–30 分钟）'
  grab /tmp/ti.sh \
    "https://raw.githubusercontent.com/flizzywine/dsh-tavern/main/install.sh" \
    "https://cdn.jsdelivr.net/gh/flizzywine/dsh-tavern@main/install.sh" \
    || { echo '酒馆安装脚本下载失败（网络）' >&2; exit 1; }
  DSH_TAVERN_HOST=cli sh /tmp/ti.sh
else
  echo '[容器] 酒馆已安装，跳过'
fi
# 移动版布局：CLI 的 host 是 cli，安装器会主动剔除 dsh-web-mobile，
# 手机上必须显式加回来（幂等；APK 用的就是这一版 + 这个补丁）。
P="$HOME/.dsh-tavern/profiles/tavern"
if [ -f "$P/package.json" ]; then
  if grep -q '"dsh-web-mobile"' "$P/package.json"; then
    echo '[容器] 移动版布局已启用'
  else
    echo '[容器] 启用移动版布局 dsh-web-mobile'
    dsh-tavern stop >/dev/null 2>&1 || true
    (
      cd "$P"
      node -e '
const fs=require("fs");
const f="package.json"; const p=JSON.parse(fs.readFileSync(f,"utf8"));
p.dependencies=p.dependencies||{}; p.dependencies["dsh-web-mobile"]="3.1.0";
const dsh=p.dsh||(p.dsh={}); const prof=dsh.profile||(dsh.profile={});
const b=Array.isArray(prof.bundles)?prof.bundles:[];
if(!b.includes("dsh-web-mobile")) b.push("dsh-web-mobile");
prof.bundles=b; fs.writeFileSync(f, JSON.stringify(p,null,2)+"\n");
'
      [ -f patches/dsh-web-mobile@3.1.0.patch ] || cp "$HOME/.dsh-tavern/apps/dsh-tavern/patches/dsh-web-mobile@3.1.0.patch" patches/ 2>/dev/null || true
      grep -q "dsh-web-mobile@3.1.0" pnpm-workspace.yaml \
        || sed -i '/^patchedDependencies:/a\  dsh-web-mobile@3.1.0: patches/dsh-web-mobile@3.1.0.patch' pnpm-workspace.yaml
      PNPM=$HOME/.dsh-tavern/tools/bin/pnpm
      [ -x "$PNPM" ] || PNPM=$(command -v pnpm)
      "$PNPM" install --reporter=append-only
    )
  fi
fi

cat > /usr/local/bin/tavern <<'W'
#!/bin/bash
set -euo pipefail
export PATH=/usr/local/node/bin:$HOME/.local/bin:$PATH
exec dsh-tavern "$@"
W
chmod +x /usr/local/bin/tavern
echo '[容器] 就绪'
INNER_EOF
}

write_wait() {
  cat > "$WAIT_SCRIPT" <<'WAIT_EOF'
export PATH=/usr/local/node/bin:$HOME/.local/bin:$PATH
LOG=$HOME/.dsh-tavern/logs/tavern.log
# 端口探测用 bash 内建 /dev/tcp：连上就算就绪，不阻塞。
port_open() { (exec 3<>/dev/tcp/127.0.0.1/3081) >/dev/null 2>&1; }
# 只把真正的启动行打出来（事件 / Web 地址 / 报错），同一行不会重复。
tail -n 0 -F "$LOG" 2>/dev/null | grep --line-buffered -E '"event"|dsh web|error|Error|ERR' >&2 &
TPID=$!
i=0
while [ $i -lt 300 ]; do
  if port_open; then break; fi
  if [ $((i % 5)) -eq 0 ]; then printf '[%3ss] 等待端口…\n' "$i" >&2; fi
  sleep 1; i=$((i+1))
done
kill "$TPID" 2>/dev/null || true
if [ $i -lt 300 ]; then
  printf '[%3ss] 端口已就绪\n' "$i" >&2
  grep -o 'http://127[.]0[.]0[.]1:[0-9]*/?token=[A-Za-z0-9_-]*' "$LOG" 2>/dev/null | tail -n 1
else
  printf '[%3ss] 300 秒内没有监听端口，服务没起来\n' "$i" >&2
fi
WAIT_EOF
}

run_inner() {
  if ! proot-distro login "$DISTRO" --shared-tmp -- bash /tmp/tavern-inner.sh; then
    log '带 --shared-tmp 执行失败，改用标准输入重试…'
    proot-distro login "$DISTRO" -- bash -s < "$INNER_SCRIPT"
  fi
}

ensure_ready() {
  ensure_pkg proot-distro
  command -v tar >/dev/null 2>&1 || ensure_pkg tar
  if container_ready; then log '[容器] 已存在'; else log '[容器] 安装 Ubuntu…'; proot-distro install "$DISTRO"; fi
  write_inner
  write_wait
  run_inner
}

latest_url() {
  proot-distro login "$DISTRO" -- bash -lc "$INNER; grep -o 'http://127[.]0[.]0[.]1:[0-9]*/?token=[A-Za-z0-9_-]*' \"\$HOME/.dsh-tavern/logs/tavern.log\" 2>/dev/null | tail -n 1" 2>/dev/null || true
}

# 打开失败要能看出是哪一步失败的：Termux 的 PATH 默认没有 /system/bin，
# termux-open-url 内部就是调 am，缺 am 时它会静默失败。
# 打不开浏览器时至少把地址放进剪贴板（需要 pkg install termux-api + Termux:API 应用）
copy_url() {
  local url=$1
  command -v termux-clipboard-set >/dev/null 2>&1 || return 1
  printf '%s' "$url" | termux-clipboard-set >/dev/null 2>&1
}

open_url() {
  local url=$1 am c
  for c in termux-open-url termux-open; do
    command -v "$c" >/dev/null 2>&1 || continue
    if "$c" "$url" >/dev/null 2>&1; then return 0; fi
    log "   $c 调用失败" >&2
  done
  for am in /system/bin/am am; do
    command -v "$am" >/dev/null 2>&1 || continue
    if "$am" start --user 0 -a android.intent.action.VIEW -d "$url" >/dev/null 2>&1; then return 0; fi
    if "$am" start -a android.intent.action.VIEW -d "$url" >/dev/null 2>&1; then return 0; fi
    log "   $am start 失败" >&2
  done
  return 1
}

wait_url() {
  local url
  # stdout 收进文件，stderr 原样透出：等待期间的心跳就靠它
  if proot-distro login "$DISTRO" --shared-tmp -- bash /tmp/tavern-wait.sh >"$WAIT_OUT"; then :; else
    proot-distro login "$DISTRO" -- bash -s < "$WAIT_SCRIPT" >"$WAIT_OUT" || true
  fi
  url=$(tail -n 1 "$WAIT_OUT" 2>/dev/null || true)
  [ -n "${url:-}" ] || die "5 分钟没起来。日志尾部：$(proot-distro login "$DISTRO" -- bash -lc "$INNER; tail -n 60 \"\$HOME/.dsh-tavern/logs/tavern.log\"" 2>/dev/null || true)"
  log "访问地址：$url"
  if open_url "$url"; then
    log '已用系统浏览器打开'
  elif copy_url "$url"; then
    log '自动打开失败（原因见上），地址已复制到剪贴板，粘贴到浏览器打开'
  else
    log '自动打开失败（原因见上），手动复制上面的地址'
  fi
}

do_start() {
  command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock || true
  if daemon_alive; then
    log "容器守护已在运行：PID $(cat "$PIDFILE")"
  else
    nohup proot-distro login "$DISTRO" -- bash -lc "
      $INNER
      dsh-tavern start || true
      exec sleep infinity
    " >/dev/null 2>&1 &
    echo $! > "$PIDFILE"
    log "容器守护已后台启动：PID $!（它常驻，服务才活得下去）"
    log '服务启动中：启动日志按行实时打印，就绪即停。'
  fi
  wait_url
}

do_stop() {
  proot-distro login "$DISTRO" -- bash -lc "$INNER; dsh-tavern stop" >/dev/null 2>&1 || true
  daemon_alive && kill "$(cat "$PIDFILE")" 2>/dev/null || true
  rm -f "$PIDFILE"
  log '已停止。'
}

do_status() {
  log "脚本版本：$VERSION"
  if daemon_alive; then log "容器守护：PID $(cat "$PIDFILE")"; else log '容器守护：未运行'; fi
  proot-distro login "$DISTRO" -- bash -lc "$INNER; curl -sS -m 5 -o /dev/null -w '端口 %{http_code}\n' http://127.0.0.1:$PORT/" 2>/dev/null || log '端口：无响应'
  latest_url
}

self_update "$@"

case "${1:-install}" in
  install) ensure_ready; do_start ;;
  start)   ensure_ready; do_start ;;
  stop)    do_stop ;;
  restart) do_stop; do_start ;;
  status)  do_status ;;
  open)
    url=$(latest_url)
    [ -n "${url:-}" ] || die '没拿到地址：先 bash termux-tavern.sh start'
    log "访问地址：$url"
    if open_url "$url"; then
      log '已用系统浏览器打开'
    elif copy_url "$url"; then
      log '自动打开失败（原因见上），地址已复制到剪贴板'
    else
      log '自动打开失败（原因见上）'
    fi
    ;;
  update)  proot-distro login "$DISTRO" -- bash -lc "$INNER; dsh-tavern update" ;;
  logs)    proot-distro login "$DISTRO" -- bash -lc "$INNER; tail -n 80 \"\$HOME/.dsh-tavern/logs/tavern.log\"" ;;
  *)       log "用法：bash $0 [install|start|stop|restart|status|open|update|logs]" >&2; exit 2 ;;
esac
