#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""六级背单词 App - 本地服务

零第三方依赖，仅使用 Python 标准库。启动后在浏览器访问 http://127.0.0.1:8765
"""
import argparse
import os
import sys
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
DATA = ROOT / "data"


class Server(ThreadingHTTPServer):
    """允许端口快速复用，避免 Ctrl+C 后立即重启报 Address already in use。"""
    allow_reuse_address = True


class Handler(SimpleHTTPRequestHandler):
    """静态文件服务；/data/* 映射到项目 data 目录。"""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB), **kwargs)

    def translate_path(self, path):
        path = path.split("?", 1)[0].split("#", 1)[0]
        if path.startswith("/data/"):
            rel = path[len("/data/"):]
            target = (DATA / rel).resolve()
            root = str(DATA)
            if str(target) == root or str(target).startswith(root + os.sep):
                return str(target)
        return super().translate_path(path)

    def end_headers(self):
        if self.path.startswith("/data/") or self.path.endswith(".json"):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stdout.write("[server] %s\n" % (fmt % args))


def pick_port(start):
    for port in range(start, start + 100):
        try:
            httpd = Server(("127.0.0.1", port), Handler)
            return httpd, port
        except OSError:
            continue
    return None, None


def main():
    ap = argparse.ArgumentParser(description="六级背单词 App 本地服务")
    ap.add_argument("--port", type=int, default=8765, help="端口号（默认 8765，占用时自动顺延）")
    ap.add_argument("--open", action="store_true", help="启动后自动打开浏览器")
    args = ap.parse_args()

    httpd, port = pick_port(args.port)
    if httpd is None:
        sys.exit("错误：没有可用端口。")

    url = "http://127.0.0.1:%d" % port
    print("=" * 46)
    print("  📚 六级背单词 App 已启动")
    print("  请在浏览器打开: %s" % url)
    print("  按 Ctrl+C 停止服务")
    print("=" * 46)

    if args.open:
        webbrowser.open(url)

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n服务已停止。")
        httpd.server_close()


if __name__ == "__main__":
    main()
