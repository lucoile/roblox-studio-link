import gzip
import http.client
import os
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer

import tree_listener

FULL = (
    "# studio-tree 2\tplace=1\tname=P\tat=10\tcount=4\n"
    "ServerStorage\tServerStorage\t2\t1\t13\t\t\t\t\n"
    "ServerStorage.A\tFolder\t1\t2\t1\t\t\t\t\n"
    "ServerStorage.A.X\tPart\t0\t3\t1\t\t\t\t\n"
    "ServerStorage.AB\tFolder\t0\t2\t2\t\t\t\t\n"
)
DELTA = (
    "# studio-tree 2\tplace=1\tname=P\tat=20\tcount=2\tmode=delta\troots=ServerStorage.A\n"
    "ServerStorage.A\tFolder\t1\t2\t1\t\t\t\t\n"
    "ServerStorage.A.Y\tPart\t0\t3\t1\t\t\t\t\n"
)


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        tree_listener.Handler.out_dir = self.dir.name
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), tree_listener.Handler)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.dir.cleanup()

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port)
        conn.request(method, path, body, {"X-Studio-Tree": "1"} if headers is None else headers)
        response = conn.getresponse()
        text = response.read().decode()
        conn.close()
        return response.status, text

    def post(self, body, place="1", gz=True, session=""):
        data = gzip.compress(body.encode()) if gz else body.encode()
        suffix = f"&session={session}" if session else ""
        return self.request("POST", f"/tree?place={place}{suffix}", data)[0]

    def stored(self, place="1", session=""):
        name = f"{place}.{session}.tsv" if session else f"{place}.tsv"
        with open(os.path.join(self.dir.name, name), encoding="utf-8") as handle:
            return handle.read()

    def exists(self, place="1", session=""):
        name = f"{place}.{session}.tsv" if session else f"{place}.tsv"
        return os.path.exists(os.path.join(self.dir.name, name))


class ListenerTest(Base):
    def test_full_snapshot_is_stored_as_sent(self):
        self.assertEqual(self.post(FULL), 204)
        self.assertEqual(self.stored(), FULL)

    def test_delta_replaces_only_rows_under_its_root(self):
        self.post(FULL)
        self.assertEqual(self.post(DELTA), 204)
        rows = [line.split("\t")[0] for line in self.stored().splitlines()[1:]]
        # ServerStorage.AB shares a prefix with the root but is not under it.
        self.assertEqual(sorted(rows), ["ServerStorage", "ServerStorage.A", "ServerStorage.A.Y", "ServerStorage.AB"])
        head = self.stored().splitlines()[0]
        self.assertIn("at=20", head)
        self.assertIn("count=4", head)
        self.assertNotIn("mode=", head)

    def test_delta_with_no_roots_rows_removes_the_root(self):
        self.post(FULL)
        gone = "# studio-tree 2\tplace=1\tname=P\tat=30\tcount=0\tmode=delta\troots=ServerStorage.A\n"
        self.assertEqual(self.post(gone), 204)
        rows = [line.split("\t")[0] for line in self.stored().splitlines()[1:]]
        self.assertEqual(rows, ["ServerStorage", "ServerStorage.AB"])

    def test_delta_without_a_snapshot_asks_for_the_whole_tree(self):
        self.assertEqual(self.post(DELTA, place="2"), 409)

    def test_delta_against_another_version_asks_for_the_whole_tree(self):
        self.post(FULL.replace("studio-tree 2", "studio-tree 1"))
        self.assertEqual(self.post(DELTA), 409)

    def test_rejects_garbage(self):
        self.assertEqual(self.post("hello"), 400)
        self.assertEqual(self.post("# studio-tree 2\tplace=1\tmode=delta\n"), 400)


class SessionTest(Base):
    def test_health_is_unchanged_and_version_names_the_protocol(self):
        self.assertEqual(self.request("GET", "/health", None, {}), (200, "studio-tree"))
        self.assertEqual(self.request("GET", "/version", None, {}), (200, str(tree_listener.PROTOCOL)))

    def test_sessions_of_one_place_keep_separate_files(self):
        self.assertEqual(self.post(FULL, session="aaaaaaaa"), 204)
        self.assertEqual(self.post(FULL.replace("ServerStorage.AB", "ServerStorage.ZZ"), session="bbbbbbbb"), 204)
        self.assertIn("ServerStorage.AB", self.stored(session="aaaaaaaa"))
        self.assertNotIn("ServerStorage.AB", self.stored(session="bbbbbbbb"))
        self.assertFalse(self.exists())

    def test_a_delta_patches_only_its_own_session(self):
        self.post(FULL, session="aaaaaaaa")
        self.post(FULL, session="bbbbbbbb")
        self.assertEqual(self.post(DELTA, session="aaaaaaaa"), 204)
        self.assertIn("ServerStorage.A.Y", self.stored(session="aaaaaaaa"))
        self.assertNotIn("ServerStorage.A.Y", self.stored(session="bbbbbbbb"))
        self.assertEqual(self.post(DELTA, session="cccccccc"), 409)

    def test_a_bad_session_is_refused(self):
        self.assertEqual(self.post(FULL, session="../x"), 400)

    def test_ping_keeps_a_snapshot_alive_and_404s_when_it_is_gone(self):
        path = "/ping?place=1&session=aaaaaaaa"
        self.assertEqual(self.request("PUT", path)[0], 404)
        self.post(FULL, session="aaaaaaaa")
        file = os.path.join(self.dir.name, "1.aaaaaaaa.tsv")
        os.utime(file, (1, 1))
        self.assertEqual(self.request("PUT", path)[0], 204)
        self.assertGreater(os.path.getmtime(file), 1000)
        self.assertEqual(self.request("PUT", path, None, {})[0], 403)

    def test_delete_removes_a_snapshot(self):
        self.post(FULL, session="aaaaaaaa")
        self.assertEqual(self.request("DELETE", "/tree?place=1&session=aaaaaaaa")[0], 204)
        self.assertFalse(self.exists(session="aaaaaaaa"))
        self.assertEqual(self.request("DELETE", "/tree?place=1&session=aaaaaaaa")[0], 204)

    def test_prune_drops_silent_sessions_and_snapshots_a_session_superseded(self):
        self.post(FULL, session="aaaaaaaa")
        self.post(FULL)
        self.post(FULL, place="2")
        for name in ("1.aaaaaaaa.tsv", "1.tsv", "2.tsv"):
            os.utime(os.path.join(self.dir.name, name), (1, 1))
        tree_listener.prune(self.dir.name)
        self.assertFalse(self.exists(session="aaaaaaaa"))
        self.assertFalse(self.exists())  # place 1 had a session file, so its unsessioned one is dead
        self.assertTrue(self.exists("2"))  # place 2 only has an unsessioned plugin: kept


if __name__ == "__main__":
    unittest.main()
