#!/usr/bin/env bash
# 重启助手：停止 → 等待端口释放（Windows 必需，否则新实例绑不上端口/打不开浏览器）→ 以给定 URL 重新启动
# 用法: ./restart.sh "<起始URL>"   不传参数则打开雨课堂首页
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
URL="${1:-https://www.yuketang.cn/v2/web/index}"

curl -s -X POST http://127.0.0.1:7862/stop || true
for i in $(seq 1 10); do
  sleep 1
  if ! netstat -ano | grep -q ":7862.*LISTENING"; then
    echo "port free after ${i}s"
    break
  fi
done

cd "$DIR"
node yuketang.js "$URL"
