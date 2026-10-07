#!/usr/bin/env python3
"""Receives Studio Tree snapshots from the Studio plugin and writes <dir>/<place>.tsv."""

import argparse
import os
import re
import sys
import tempfile
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PLACE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
HEADER = b"# studio-tree 1\t"
MAX_BODY = 64 * 1024 * 1024
MAX_TREE = 256 * 1024 * 1024


def inflate(body):
    if body[:2] != b"\x1f\x8b":
        return body
    # Bounded, so a small gzip can't expand into gigabytes.
    inflater = zlib.decompressobj(16 + zlib.MAX_WBITS)
    tree = inflater.decompress(body, MAX_TREE)
    if inflater.unconsumed_tail:
        raise ValueError("tree too large")
    return tree


class Handler(BaseHTTPRequestHandler):
    server_version = "studio-tree"
    out_dir = "."

    def answer(self, status, text=""):
        data = text.encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if urlparse(self.path).path == "/health":
            self.answer(200, "studio-tree")
        else:
            self.answer(404)

    def do_POST(self):
        url = urlparse(self.path)
        place = parse_qs(url.query).get("place", [""])[0]
        if url.path != "/tree" or not PLACE.match(place):
            return self.answer(400, "bad path or place")
        # A custom header forces a CORS preflight, which this server never answers,
        # so a web page can't post a fake tree.
        if self.headers.get("X-Studio-Tree") != "1":
            return self.answer(403, "missing X-Studio-Tree header")
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY:
            return self.answer(413, "bad length")
        try:
            tree = inflate(self.rfile.read(length))
        except (ValueError, zlib.error) as error:
            return self.answer(400, str(error))
        if not tree.startswith(HEADER):
            return self.answer(400, "not a studio-tree snapshot")
        os.makedirs(self.out_dir, exist_ok=True)
        handle, temp = tempfile.mkstemp(dir=self.out_dir, prefix=f".{place}.", suffix=".tmp")
        with os.fdopen(handle, "wb") as out:
            out.write(tree)
        os.replace(temp, os.path.join(self.out_dir, f"{place}.tsv"))
        self.answer(204)

    def log_message(self, format, *args):
        pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=34950)
    parser.add_argument("--dir", default=os.path.expanduser("~/.claude/studio-tree"))
    options = parser.parse_args()
    Handler.out_dir = options.dir
    try:
        server = ThreadingHTTPServer(("127.0.0.1", options.port), Handler)
    except OSError as error:
        print(f"studio-tree: port {options.port} unavailable: {error}", file=sys.stderr, flush=True)
        sys.exit(2)
    print(f"studio-tree: listening on 127.0.0.1:{options.port}, writing {options.dir}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
