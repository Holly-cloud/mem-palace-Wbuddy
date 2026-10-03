#!/usr/bin/env bash
# End-to-end smoke test. Verifies every documented command works.
set -uo pipefail
cd "$(dirname "$0")"

# 自动探测 Python 解释器：优先用 PYTHON 环境变量，其次找常见的 python3/python。
# 这样脚本在不同机器上都能直接跑，无需修改硬编码路径。
if [ -n "${PYTHON:-}" ]; then
  PY="$PYTHON"
elif command -v python3 >/dev/null 2>&1; then
  PY="python3"
elif command -v python >/dev/null 2>&1; then
  PY="python"
else
  echo "未找到 Python 解释器。请设置 PYTHON 环境变量后重试，例如："
  echo "  PYTHON=/path/to/python ./smoke_test.sh"
  exit 1
fi

P="$PY bin/palace.py"
PASS=0; FAIL=0

chk() {
  local name="$1"; shift
  if "$@" >/tmp/palace_out 2>&1; then
    echo "  PASS  $name"; PASS=$((PASS+1))
  else
    echo "  FAIL  $name"; sed -n '1,6p' /tmp/palace_out; FAIL=$((FAIL+1))
  fi
}

echo "=== 命令回归测试 ==="
chk "init"          $P init
chk "add"           $P add --type lesson --title "回归测试卡" --subject test:regression --predicate probe --value "smoke" --body "临时" --tag test
chk "search"        $P search "回归测试"
chk "search --json" $P search "回归" --json
chk "search as-of"  $P search "回归" --as-of 2026-01-01
chk "search non-act" $P search "编辑器" --include-non-active
chk "list"          $P list
chk "list --json"   $P list --json
chk "list --all"    $P list --all
chk "doctor"        $P doctor
chk "doctor --json" $P doctor --json
chk "gc dry-run"    $P gc
chk "gc --json"     $P gc --json
chk "stats"         $P stats
chk "stats --json"  $P stats --json
chk "expire"        $P expire
chk "reindex"       $P reindex
chk "log"           $P log --text "回归测试日志"
chk "distill"       $P distill
chk "template"      $P template --type lesson
chk "template pref" $P template --type preference
chk "export"        $P export

echo ""
echo "=== 索引可重建性验证 ==="
BEFORE=$($P stats --json | "$PY" -c "import json,sys; print(json.load(sys.stdin)['stats']['total'])")
rm -f .palace/index.db
$P reindex >/dev/null 2>&1
AFTER=$($P stats --json | "$PY" -c "import json,sys; print(json.load(sys.stdin)['stats']['total'])")
if [ "$BEFORE" = "$AFTER" ]; then
  echo "  PASS  删库重建后卡片数一致 ($BEFORE)"
  PASS=$((PASS+1))
else
  echo "  FAIL  重建前后不一致: $BEFORE -> $AFTER"; FAIL=$((FAIL+1))
fi

echo ""
echo "=== 清理测试卡 ==="
$P resolve --slot "test::regression" --verdict archive >/dev/null 2>&1
echo "  done"

echo ""
echo "================================"
echo "  通过 $PASS / 失败 $FAIL"
echo "================================"
[ "$FAIL" -eq 0 ]
