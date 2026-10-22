#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""六级背单词 App - 本地服务

零第三方依赖，仅使用 Python 标准库。启动后在浏览器访问 http://127.0.0.1:8765
"""
import argparse
import errno
import hashlib
import http.client
import json
import os
import re
import shlex
import subprocess
import sys
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
DATA = ROOT / "data"
INSTANCE_PATH = "/__word_app__/instance"
APP_ID = "cet6-vocabulary-trainer"


def instance_identity():
    # Include the checkout location: another copy may use identical source files.
    return {
        "app": APP_ID,
        "version": 1,
        "project_id": hashlib.sha256(os.fsencode(ROOT.resolve())).hexdigest(),
    }


class Server(ThreadingHTTPServer):
    """允许端口快速复用，避免 Ctrl+C 后立即重启报 Address already in use。"""
    allow_reuse_address = True


class Handler(SimpleHTTPRequestHandler):
    """静态文件服务；/data/* 映射到项目 data 目录。"""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB), **kwargs)

    def do_GET(self):
        if self.path.split("?", 1)[0] == INSTANCE_PATH:
            body = json.dumps(instance_identity()).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

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
        # 页面与脚本必须同步更新，避免旧脚本跳过新增的预习流程。
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stdout.write("[server] %s\n" % (fmt % args))


def read_local_response(port, path, limit):
    # Connect directly to loopback, without environment proxies or redirects.
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
    try:
        connection.request("GET", path)
        response = connection.getresponse()
        body = response.read(limit + 1)
        if len(body) > limit:
            raise ValueError("响应超出预期大小")
        return response.status, body
    finally:
        connection.close()


def legacy_process_matches(port):
    """Only reuse old servers when their listening process belongs to this checkout.

    Old versions have no identity endpoint. On systems without lsof/ps, fail
    closed instead of treating an identical-looking website as this project.
    """
    try:
        def output(*command):
            return subprocess.check_output(
                command, text=True, stderr=subprocess.DEVNULL, timeout=2
            )

        listeners = output("lsof", "-nP", "-iTCP:%d" % port, "-sTCP:LISTEN", "-Fp")
        pids = {line[1:] for line in listeners.splitlines()
                if line.startswith("p") and line[1:].isdigit()}
        if len(pids) != 1:
            return False
        pid = pids.pop()
        locations = output("lsof", "-a", "-p", pid, "-d", "cwd", "-Fn")
        directories = [line[1:] for line in locations.splitlines() if line.startswith("n")]
        if len(directories) != 1 or Path(directories[0]).resolve() != ROOT.resolve():
            return False
        command = shlex.split(output("ps", "-p", pid, "-o", "args="))
        if not command or not re.fullmatch(r"python(?:\d+(?:\.\d+)*)?", Path(command[0]).name, re.I):
            return False
        command = command[1:]
        while command and command[0] in ("-u", "-B"):
            command.pop(0)
        return bool(command) and (ROOT / command[0]).resolve() == ROOT / "server.py"
    except (OSError, ValueError, subprocess.SubprocessError):
        return False


def is_same_instance(port):
    try:
        status, body = read_local_response(port, INSTANCE_PATH, 8192)
        if status == 200:
            return json.loads(body) == instance_identity()
        if status != 404 or not legacy_process_matches(port):
            return False
        expected = (WEB / "index.html").read_bytes()
        status, body = read_local_response(port, "/index.html", len(expected))
        return status == 200 and body == expected
    except (OSError, ValueError, http.client.HTTPException):
        return False


def main(argv=None):
    ap = argparse.ArgumentParser(description="六级背单词 App 本地服务")
    ap.add_argument("--port", type=int, default=8765, help="固定端口号（默认 8765）")
    ap.add_argument("--open", action="store_true", help="启动后自动打开浏览器")
    args = ap.parse_args(argv)
    if not 1 <= args.port <= 65535:
        ap.error("端口号必须在 1 到 65535 之间")

    url = "http://127.0.0.1:%d" % args.port
    try:
        httpd = Server(("127.0.0.1", args.port), Handler)
    except OSError as error:
        if error.errno == errno.EADDRINUSE and is_same_instance(args.port):
            print("本项目服务已在运行，继续使用: %s" % url)
            if args.open:
                webbrowser.open(url)
            return 0
        if error.errno == errno.EADDRINUSE:
            print("错误：端口 %d 已被占用，且无法确认是本项目服务。" % args.port, file=sys.stderr)
            print("请关闭占用程序后重试，或用 --port 明确指定其他端口。", file=sys.stderr)
            print("学习记录按浏览器地址保存，更换端口会使用独立的学习记录。", file=sys.stderr)
        else:
            print("错误：无法启动本地服务：%s" % error, file=sys.stderr)
        return 1
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
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
