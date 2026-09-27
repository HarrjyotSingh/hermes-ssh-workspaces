"""Unit tests for hecore.wiki_links (rename link-rewrite engine).

Run with the Hermes venv interpreter (no pytest required):

    /home/testuser/.hermes/hermes-agent/venv/bin/python tests/test_wiki_links.py
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PLUGIN_ROOT / "dashboard"))

from hecore import wiki_links as wl  # noqa: E402


def entry(path, title=None, aliases=None, outgoing=None):
    return {"path": path, "title": title or path.rsplit("/", 1)[-1][:-3],
            "aliases": aliases or [], "outgoing": outgoing or []}


class StripCodeContentTests(unittest.TestCase):
    def test_fenced_code_is_blanked(self):
        body = "before\n```md\n[[In Fence]]\n```\nafter"
        out = wl.strip_code_content(body)
        self.assertNotIn("[[In Fence]]", out)
        self.assertIn("before", out)

    def test_indented_fence_inside_list(self):
        body = "- item\n  ```\n  [[Nested]]\n  ```\n- next"
        self.assertNotIn("[[Nested]]", wl.strip_code_content(body))

    def test_inline_code_is_blanked(self):
        self.assertNotIn("[[X]]", wl.strip_code_content("keep `[[X]]` here"))

    def test_tilde_fence(self):
        body = "~~~\n[[T]]\n~~~\n[[Real]]"
        out = wl.strip_code_content(body)
        self.assertIn("[[Real]]", out)
        self.assertNotIn("[[T]]", out)


class SplitSwapTests(unittest.TestCase):
    def test_split_target_anchor_alias(self):
        self.assertEqual(wl.split_wikilink_content("Doc#Head|Alias"),
                         ("Doc", "#Head", "|Alias"))
        self.assertEqual(wl.split_wikilink_content("Doc"), ("Doc", "", ""))

    def test_swap_basename_keeps_dir_and_ext(self):
        self.assertEqual(wl.swap_basename("a/b/Old Name", "New"),
                         "a/b/New")
        self.assertEqual(wl.swap_basename("Old Name.md", "New"),
                         "New.md")


class ResolveTests(unittest.TestCase):
    ENTRIES = [
        entry("notes/Alpha.md", outgoing=["Beta", "sub/Gamma"]),
        entry("notes/sub/Beta.md"),
        entry("elsewhere/Gamma.md", title="Gamma Prime"),
    ]

    def test_exact_path(self):
        e = wl.resolve_target_entry(self.ENTRIES, "notes/Alpha")
        self.assertEqual(e["path"], "notes/Alpha.md")

    def test_unique_suffix(self):
        e = wl.resolve_target_entry(self.ENTRIES, "sub/Beta")
        self.assertEqual(e["path"], "notes/sub/Beta.md")

    def test_basename_unique(self):
        e = wl.resolve_target_entry(self.ENTRIES, "Alpha")
        self.assertEqual(e["path"], "notes/Alpha.md")

    def test_title_match(self):
        e = wl.resolve_target_entry(self.ENTRIES, "gamma prime")
        self.assertEqual(e["path"], "elsewhere/Gamma.md")

    def test_ambiguous_basename_is_none(self):
        entries = [entry("a/Dup.md"), entry("b/Dup.md")]
        self.assertIsNone(wl.resolve_target_entry(entries, "Dup"))


class RewriteTests(unittest.TestCase):
    ENTRIES = [
        entry("Notes/Old Name.md", aliases=["ON"]),
        entry("Other.md", outgoing=["Old Name"]),
        entry("Deep/Nested/Ref.md", outgoing=["Notes/Old Name"]),
        entry("Coder.md", outgoing=["nothing"]),
    ]

    def test_plain_alias_and_anchor_survive(self):
        body = ("See [[Old Name]], styled [[Old Name|the old one]] and "
                "[[Old Name#Setup]] plus ![[Old Name]] embed.")
        out, changed, touched = wl.rewrite_links_for_rename(
            body, self.ENTRIES, "Notes/Old Name.md", "Renamed")
        self.assertEqual(changed, 4)
        self.assertEqual(touched, ["Other.md", "Deep/Nested/Ref.md"])
        self.assertIn("[[Renamed]]", out)
        self.assertIn("[[Renamed|the old one]]", out)
        self.assertIn("[[Renamed#Setup]]", out)
        self.assertIn("![[Renamed]]", out)

    def test_code_blocks_untouched(self):
        body = "```md\n[[Old Name]]\n```\nand `[[Old Name]]` inline\nbut [[Old Name]] real"
        out, changed, _t = wl.rewrite_links_for_rename(
            body, self.ENTRIES, "Notes/Old Name.md", "Renamed")
        self.assertEqual(changed, 1)
        self.assertIn("[[Old Name]]", out)          # fence survived verbatim
        self.assertIn("`[[Old Name]]`", out)        # inline code survived
        self.assertIn("[[Renamed]]", out)           # the real one rewritten

    def test_no_inbound_links_is_noop(self):
        body = "nothing here"
        out, changed, touched = wl.rewrite_links_for_rename(
            body, self.ENTRIES, "Missing.md", "X")
        self.assertEqual((changed, touched), (0, []))
        self.assertEqual(out, body)

    def test_path_targets_rewrite_with_dir_prefix(self):
        body = "link to [[Notes/Old Name]]"
        out, changed, _t = wl.rewrite_links_for_rename(
            body, self.ENTRIES, "Notes/Old Name.md", "Renamed")
        self.assertEqual(changed, 1)
        self.assertIn("[[Notes/Renamed]]", out)

    def test_unrelated_names_left_alone(self):
        body = "[[Other]] and [[Old Nam]] stay"
        out, changed, _t = wl.rewrite_links_for_rename(
            body, self.ENTRIES, "Notes/Old Name.md", "Renamed")
        self.assertEqual(changed, 0)
        self.assertEqual(out, body)


class ExtractOutgoingTests(unittest.TestCase):
    def test_code_links_excluded(self):
        text = "real [[A]]\n```\n[[B]]\n```\n`[[C]]`\n[[D#Sec|lab]]"
        self.assertEqual(wl.extract_outgoing_targets(text), ["A", "D"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
