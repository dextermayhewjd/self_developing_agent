import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import fetch_peers


class TestResolvePeers(unittest.TestCase):
    def test_pool_hit_uses_curated_stars(self):
        entry = {"stars": ["601012", "002459"], "labels": {"601012": "隆基绿能"}}
        peers, labels, source = fetch_peers.resolve_peers("300274", entry, neighbors_fn=None)
        self.assertEqual(peers, ["300274", "601012", "002459"])
        self.assertEqual(source, "competitor_pool")
        self.assertEqual(labels["601012"], "隆基绿能")

    def test_pool_miss_falls_back_to_industry_neighbors_labelled_as_such(self):
        """行业池没有「风电设备」时 peers.json 只剩本公司一行，报告只能写未取得。"""
        def neighbors(symbol):
            return [{"code": c, "name": n} for c, n in
                    [("603507", "振江股份"), ("688349", "三一重能"), ("002487", "大金重工"),
                     ("300443", "金雷股份"), ("300850", "新强联"), ("601218", "吉鑫科技"),
                     ("002202", "金风科技")]], {}
        peers, labels, source = fetch_peers.resolve_peers("301557", {"stars": [], "labels": {}}, neighbors)
        self.assertEqual(source, "eastmoney_industry_neighbors")
        self.assertEqual(peers[0], "301557")
        self.assertEqual(len(peers), 1 + fetch_peers.MAX_NEIGHBORS)
        self.assertIn("行业近邻", labels["603507"])
        self.assertIn("振江股份", labels["603507"])

    def test_neighbor_lookup_failure_leaves_only_self(self):
        def broken(symbol):
            raise ConnectionError("datacenter reset")
        peers, labels, source = fetch_peers.resolve_peers("301557", {"stars": [], "labels": {}}, broken)
        self.assertEqual((peers, source), (["301557"], "none"))


if __name__ == "__main__":
    unittest.main()
