"""Regression checks for stable browser origins and safe server reuse."""
import contextlib
import errno
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import threading
import unittest
from unittest.mock import Mock, patch


SPEC = importlib.util.spec_from_file_location("word_server", Path(__file__).resolve().parents[1] / "server.py")
server = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(server)


class ServerTests(unittest.TestCase):
    def run_main(self, arguments, **patches):
        with contextlib.ExitStack() as stack:
            stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            stderr = stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
            mocks = {name: stack.enter_context(patch.object(server, name, **options))
                     for name, options in patches.items()}
            result = server.main(arguments)
            return result, stderr.getvalue(), mocks

    def test_existing_server_keeps_origin_and_opens_same_url(self):
        with patch.object(server.webbrowser, "open") as browser:
            result, _, mocks = self.run_main(
                ["--open"],
                Server={"side_effect": OSError(errno.EADDRINUSE, "in use")},
                is_same_instance={"return_value": True},
            )
        self.assertEqual(result, 0)
        mocks["Server"].assert_called_once_with(("127.0.0.1", 8765), server.Handler)
        mocks["is_same_instance"].assert_called_once_with(8765)
        browser.assert_called_once_with("http://127.0.0.1:8765")

    def test_reuse_respects_explicit_port_without_opening_browser(self):
        with patch.object(server.webbrowser, "open") as browser:
            result, _, mocks = self.run_main(
                ["--port", "9000"],
                Server={"side_effect": OSError(errno.EADDRINUSE, "in use")},
                is_same_instance={"return_value": True},
            )
        self.assertEqual(result, 0)
        mocks["is_same_instance"].assert_called_once_with(9000)
        browser.assert_not_called()

    def test_unrelated_listener_reports_error_without_trying_another_port(self):
        with patch.object(server.webbrowser, "open") as browser:
            result, error, mocks = self.run_main(
                ["--open"],
                Server={"side_effect": OSError(errno.EADDRINUSE, "in use")},
                is_same_instance={"return_value": False},
            )
        self.assertEqual(result, 1)
        self.assertIn("--port", error)
        self.assertIn("独立的学习记录", error)
        mocks["Server"].assert_called_once_with(("127.0.0.1", 8765), server.Handler)
        browser.assert_not_called()

    def test_other_bind_failure_is_not_hidden_or_probed_as_existing_server(self):
        result, error, mocks = self.run_main(
            [],
            Server={"side_effect": OSError(errno.EACCES, "permission denied")},
            is_same_instance={},
        )
        self.assertEqual(result, 1)
        self.assertIn("permission denied", error)
        mocks["Server"].assert_called_once()
        mocks["is_same_instance"].assert_not_called()

    def test_new_server_closes_cleanly_on_keyboard_interrupt(self):
        httpd = Mock()
        httpd.serve_forever.side_effect = KeyboardInterrupt
        result, _, _ = self.run_main([], Server={"return_value": httpd})
        self.assertEqual(result, 0)
        httpd.server_close.assert_called_once()

    def test_identity_endpoint_can_identify_a_running_server(self):
        with patch.object(server.Handler, "log_message"):
            httpd = server.Server(("127.0.0.1", 0), server.Handler)
            worker = threading.Thread(target=httpd.serve_forever, daemon=True)
            worker.start()
            try:
                self.assertTrue(server.is_same_instance(httpd.server_port))
            finally:
                httpd.shutdown()
                httpd.server_close()
                worker.join(timeout=2)

    def test_another_checkout_is_not_reused_even_with_same_app_identity(self):
        identity = server.instance_identity()
        identity["project_id"] = "another checkout"
        with patch.object(server, "read_local_response", return_value=(200, json.dumps(identity).encode())), \
                patch.object(server, "legacy_process_matches") as legacy:
            self.assertFalse(server.is_same_instance(8765))
        legacy.assert_not_called()

    def test_invalid_identity_or_unreachable_service_is_not_reused(self):
        for response in ((200, b"not json"), (200, b"null"), (403, b"forbidden")):
            with self.subTest(response=response), \
                    patch.object(server, "read_local_response", return_value=response):
                self.assertFalse(server.is_same_instance(8765))
        with patch.object(server, "read_local_response", side_effect=TimeoutError):
            self.assertFalse(server.is_same_instance(8765))

    def test_legacy_instance_requires_both_process_and_matching_page(self):
        expected = (server.WEB / "index.html").read_bytes()
        for process_matches, page, reused in ((True, expected, True), (True, b"other page", False), (False, expected, False)):
            with self.subTest(process_matches=process_matches, reused=reused), \
                    patch.object(server, "read_local_response", side_effect=[(404, b"missing"), (200, page)]), \
                    patch.object(server, "legacy_process_matches", return_value=process_matches):
                self.assertEqual(server.is_same_instance(8765), reused)

    def test_legacy_process_must_run_this_checkout_script(self):
        cwd = "p123\nfcwd\nn%s\n" % server.ROOT
        for command, expected in (
            ("/usr/bin/python3 server.py --open", True),
            ("/usr/bin/Python -u ./server.py", True),
            ("/usr/bin/python3 other.py", False),
            ("/usr/bin/python3 -c 'print(\"server.py\")'", False),
            ("/usr/bin/node server.py", False),
        ):
            with self.subTest(command=command), \
                    patch.object(server.subprocess, "check_output", side_effect=["p123\nf3\n", cwd, command]):
                self.assertEqual(server.legacy_process_matches(8765), expected)

    def test_legacy_process_from_another_checkout_is_not_reused(self):
        with patch.object(server.subprocess, "check_output", side_effect=["p123\n", "p123\nn/tmp/another-word-app\n"]):
            self.assertFalse(server.legacy_process_matches(8765))

    def test_legacy_process_ambiguity_or_missing_utilities_is_not_reused(self):
        for listeners in ("", "p123\np456\n"):
            with self.subTest(listeners=listeners), \
                    patch.object(server.subprocess, "check_output", return_value=listeners):
                self.assertFalse(server.legacy_process_matches(8765))
        for error in (FileNotFoundError(), subprocess.TimeoutExpired("lsof", 2)):
            with self.subTest(error=error), \
                    patch.object(server.subprocess, "check_output", side_effect=error):
                self.assertFalse(server.legacy_process_matches(8765))


if __name__ == "__main__":
    unittest.main()
