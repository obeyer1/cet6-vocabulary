#!/bin/bash
# 六级背单词 App 启动脚本：双击即可运行
cd "$(dirname "$0")" || exit 1
python3 server.py --open
