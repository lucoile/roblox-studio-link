#!/usr/bin/env python3
"""Receives Studio Tree snapshots from the Studio plugin and writes <dir>/<place>.tsv."""

import argparse
import os
import re
import sys
import tempfile
import threading
import time
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PLACE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
SESSION = re.compile(r"^[a-f0-9]{6,16}$")
PROTOCOL = 2
PRUNE_AFTER = 15 * 60
PRUNE_EVERY = 60
HEADER = re.compile(rb"^# studio-tree (\d+)\t")
ROOT_SEPARATOR = "\x1f"
MAX_BODY = 64 * 1024 * 1024
MAX_TREE = 256 * 1024 * 1024
STORE = threading.Lock()


def inflate(body):
    if body[:2] != b"\x1f\x8b":
        return body
    # Bounded, so a small gzip can't expand into gigabytes.
    inflater = zlib.decompressobj(16 + zlib.MAX_WBITS)
    tree = inflater.decompress(body, MAX_TREE)
    if inflater.unconsumed_tail:
        raise ValueError("tree too large")
    return tree


def header_fields(line):
    fields = {}
    for part in line.split("\t")[1:]:
        key, _, value = part.partition("=")
        if key:
            fields[key] = value
    return fields


def under(path, root):
    return path == root or path.startswith(root + ".")


def merge(old_text, delta_text, roots):
    """Replaces every row under one of the roots in the stored snapshot with the delta's rows."""
    old = old_text.split("\n")
    new = delta_text.split("\n")
    kept = [line for line in old[1:] if line and not any(under(line.split("\t", 1)[0], root) for root in roots)]
    added = [line for line in new[1:] if line]
    head = new[0].split("\t")
    head = [part for part in head if not part.startswith(("mode=", "roots=", "count="))]
    head.append(f"count={len(kept) + len(added)}")
    return "\n".join(["\t".join(head)] + kept + added) + "\n"


def snapshot_path(out_dir, place, session):
    # Each Studio sends its own session id, so two Studios on one place keep separate files.
    return os.path.join(out_dir, f"{place}.{session}.tsv" if session else f"{place}.tsv")


def prune(out_dir, now=None):
    """Removes snapshots of Studios that stopped sending heartbeats, and leftover temp files."""
    now = time.time() if now is None else now
    try:
        names = os.listdir(out_dir)
    except OSError:
        return
    for name in names:
        full = os.path.join(out_dir, name)
        is_session = re.search(r"\.[a-f0-9]{6,16}\.tsv$", name) is not None
        is_temp = name.startswith(".") and name.endswith(".tmp")
        try:
            if (is_session or is_temp) and now - os.path.getmtime(full) > PRUNE_AFTER:
                os.remove(full)
        except OSError:
            pass


def prune_forever(out_dir):
    while True:
        time.sleep(PRUNE_EVERY)
        prune(out_dir)


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
            # "studio-tree" alone is how version 1 answered; the number says which protocol this is.
            self.answer(200, f"studio-tree {PROTOCOL}")
        else:
            self.answer(404)

    def target(self):
        url = urlparse(self.path)
        query = parse_qs(url.query)
        place = query.get("place", [""])[0]
        session = query.get("session", [""])[0]
        if not PLACE.match(place) or (session and not SESSION.match(session)):
            return url, None
        return url, snapshot_path(self.out_dir, place, session)

    def check_origin(self):
        # A custom header forces a CORS preflight, which this server never answers,
        # so a web page can't post a fake tree.
        if self.headers.get("X-Studio-Tree") != "1":
            self.answer(403, "missing X-Studio-Tree header")
            return False
        return True

    def do_PUT(self):
        # A heartbeat: keeps a Studio's snapshot alive, and says 404 when the file is gone so Studio resends.
        url, target = self.target()
        if url.path != "/ping" or target is None:
            return self.answer(400, "bad path or place")
        if not self.check_origin():
            return
        with STORE:
            if not os.path.exists(target):
                return self.answer(404, "no snapshot")
            try:
                os.utime(target)
            except OSError:
                return self.answer(404, "no snapshot")
        self.answer(204)

    def do_DELETE(self):
        url, target = self.target()
        if url.path != "/tree" or target is None:
            return self.answer(400, "bad path or place")
        if not self.check_origin():
            return
        with STORE:
            try:
                os.remove(target)
            except OSError:
                pass
        self.answer(204)

    def do_POST(self):
        url, target = self.target()
        if url.path != "/tree" or target is None:
            return self.answer(400, "bad path or place")
        if not self.check_origin():
            return
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
        start = HEADER.match(tree)
        if not start:
            return self.answer(400, "not a studio-tree snapshot")
        os.makedirs(self.out_dir, exist_ok=True)
        # Studio strings are UTF-8, but one cut-off character must not cost the whole snapshot.
        text = tree.decode("utf-8", errors="replace")
        tree = text.encode()
        with STORE:
            fields = header_fields(text.split("\n", 1)[0])
            if fields.get("mode") == "delta":
                roots = [root for root in fields.get("roots", "").split(ROOT_SEPARATOR) if root]
                if not roots:
                    return self.answer(400, "delta without roots")
                try:
                    with open(target, encoding="utf-8") as stored:
                        old_text = stored.read()
                except OSError:
                    old_text = ""
                # A delta only patches a snapshot of the same version; otherwise Studio sends the whole tree.
                old_start = HEADER.match(old_text[:64].encode())
                if not old_start or old_start.group(1) != start.group(1):
                    return self.answer(409, "no snapshot to patch")
                tree = merge(old_text, text, roots).encode()
            handle, temp = tempfile.mkstemp(dir=self.out_dir, prefix=".snapshot.", suffix=".tmp")
            with os.fdopen(handle, "wb") as out:
                out.write(tree)
            os.replace(temp, target)
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
    threading.Thread(target=prune_forever, args=(options.dir,), daemon=True).start()
    print(f"studio-tree: listening on 127.0.0.1:{options.port}, writing {options.dir}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
