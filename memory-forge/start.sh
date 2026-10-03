#!/usr/bin/env bash
# 启动脚本：处理两个常见的 Electron 启动障碍
#
# 1. ELECTRON_RUN_AS_NODE=1 —— 某些 CI / 编辑器 / 工具链会预设它。
#    Electron 见到它就退化成纯 Node 运行时，表现为：
#      TypeError: Cannot read properties of undefined (reading 'whenReady')
#    必须在进程启动前剥离，主进程代码里无法补救。
#
# 2. GPU 不可用 —— 无显卡的服务器 / 容器 / 远程会话会崩在
#    "GPU process isn't usable. Goodbye."
#
# 用法：
#   ./start.sh          正常启动
#   ./start.sh --dev    带开发者工具

set -euo pipefail
cd "$(dirname "$0")"

unset ELECTRON_RUN_AS_NODE

ELECTRON="./node_modules/.bin/electron"
if [ ! -x "$ELECTRON" ]; then
  echo "未安装依赖，请先运行：npm install"
  exit 1
fi

# 检测是否有可用 GPU 加速；无显示环境时自动降级为软件渲染
if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
  echo "[start] 无显示环境，使用软件渲染模式"
  exec "$ELECTRON" . --disable-gpu --disable-software-rasterizer --no-sandbox --in-process-gpu "$@"
fi

exec "$ELECTRON" . "$@"
