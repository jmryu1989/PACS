"""C5-2 email state, TLS and refusal checks. Never connects to a mail server."""
import copy
import json
import os
from pathlib import Path
import ssl
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import ops_email_monitor as mail

ORIGIN = 'https://pacs.example.invalid'
RECIPIENT = 'operator@example.invalid'
NOW = 1788675000


def report(ok=True, maintenance=False, now=NOW):
    return {'ok': ok, 'maintenance': maintenance, 'checked_at': now,
            'faults': [] if ok else ['api_unavailable']}


class EmailMonitorTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.path = self.root / 'live.json'
        mail.atomic_json(self.path, mail.initial(ORIGIN, RECIPIENT, NOW))
        self.send = Mock()

    def tearDown(self):
        self.temporary.cleanup()

    def tick(self, value=None, now=NOW):
        return mail.tick(self.path, ORIGIN, RECIPIENT, value or report(now=now), self.send, now)

    def state(self):
        return json.loads(self.path.read_text())

    def test_01_healthy_first_and_steady_state_send_nothing(self):
        self.tick(); self.tick(now=NOW+300)
        self.send.assert_not_called()

    def test_02_alert_ongoing_maintenance_recovery_transitions(self):
        self.assertEqual(self.tick(report(False))['notification'], 'alert')
        self.tick(report(False, now=NOW+300), NOW+300)
        self.tick(report(True, True, NOW+600), NOW+600)
        self.assertEqual(self.send.call_count, 1)
        self.assertTrue(self.state()['open'])
        self.assertEqual(self.tick(report(now=NOW+900), NOW+900)['notification'], 'recovery')
        self.tick(now=NOW+1200)
        self.assertEqual(self.send.call_count, 2)
        self.assertFalse(self.state()['open'])

    def test_03_failed_smtp_keeps_same_outbox_and_retries(self):
        self.send.side_effect = OSError('private server response')
        with self.assertRaises(OSError): self.tick(report(False))
        pending = self.state()['pending']
        self.assertFalse(self.state()['open'])
        self.assertEqual(self.state()['attempts'], 1)
        self.send.side_effect = None
        self.tick(report(False, now=NOW+300), NOW+300)
        self.assertEqual(self.send.call_args.args[0], pending)
        self.assertIsNone(self.state()['pending'])
        self.assertEqual(self.state()['attempts'], 2)

    def test_04_uncertain_alert_then_recovery_preserves_event_order(self):
        self.send.side_effect = OSError()
        with self.assertRaises(OSError): self.tick(report(False))
        self.send.side_effect = None
        self.assertEqual(self.tick(now=NOW+300)['notification'], 'alert')
        self.assertEqual(self.tick(now=NOW+600)['notification'], 'recovery')
        self.assertEqual([call.args[0]['kind'] for call in self.send.call_args_list], ['alert','alert','recovery'])

    def test_05_daily_limit_persists_and_resets_next_utc_day(self):
        self.send.side_effect = OSError()
        for index in range(mail.MAX_ATTEMPTS):
            now = NOW + index
            with self.assertRaises(OSError): self.tick(report(False, now=now), now)
        with self.assertRaisesRegex(RuntimeError, 'limit'):
            self.tick(report(False, now=NOW+25), NOW+25)
        self.assertEqual(self.send.call_count, mail.MAX_ATTEMPTS)
        self.send.side_effect = None
        next_day = (NOW // 86400 + 1) * 86400
        self.tick(report(False, now=next_day), next_day)
        self.assertEqual(self.state()['attempts'], 1)

    def test_06_bad_report_never_sends_or_changes_state(self):
        original = self.path.read_bytes()
        cases = [dict(report(), ok='yes'), dict(report(), faults=['secret-body']), dict(report(), checked_at=0),
                 dict(report(False), maintenance=True), dict(report(), extra='data'), dict(report(), faults='api_unavailable')]
        for candidate in cases:
            with self.assertRaises(ValueError): self.tick(candidate)
            self.assertEqual(self.path.read_bytes(), original)
        self.send.assert_not_called()

    def test_07_corrupt_missing_or_different_destination_state_refused(self):
        original = self.state()
        for key, value in [('recipient','other@example.invalid'),('origin','https://other.invalid'),
                           ('attempts',-1),('open',True),('schema',True),('pending',{'id':'bad'})]:
            changed = copy.deepcopy(original);changed[key] = value
            mail.atomic_json(self.path, changed)
            with self.assertRaises(ValueError): self.tick()
        self.path.unlink()
        with self.assertRaises(ValueError): self.tick()
        self.send.assert_not_called()

    def test_08_disk_failure_prevents_smtp(self):
        with patch.object(mail, 'atomic_json', side_effect=OSError('disk')):
            with self.assertRaises(OSError): self.tick(report(False))
        self.send.assert_not_called()

    def test_09_crash_after_smtp_reuses_message_id(self):
        real_write = mail.atomic_json
        writes = []
        def fail_second(path, state):
            writes.append(1)
            if len(writes) == 2: raise OSError('post-send disk failure')
            return real_write(path, state)
        with patch.object(mail, 'atomic_json', side_effect=fail_second):
            with self.assertRaises(OSError): self.tick(report(False))
        pending = self.state()['pending']
        self.tick(report(False, now=NOW+300), NOW+300)
        self.assertEqual(self.send.call_args_list[0].args[0]['id'], pending['id'])
        self.assertEqual(self.send.call_args_list[1].args[0]['id'], pending['id'])

    def test_10_credentials_select_only_mail_and_reject_duplicates(self):
        path = self.root/'credentials'
        path.write_text('HANMAIL_USER=fixture\nHANMAIL_APP_PW="synthetic"\nERP_SECRET=do-not-import\n')
        path.chmod(0o600)
        self.assertEqual(mail.credentials(path), {'HANMAIL_USER':'fixture','HANMAIL_APP_PW':'synthetic'})
        path.write_text(path.read_text()+'HANMAIL_USER=other\n')
        with self.assertRaises(ValueError): mail.credentials(path)

    def test_11_mail_verifies_tls_and_contains_no_credentials_or_attachment(self):
        event = {'id':'a'*32,'kind':'alert','checked_at':NOW,'faults':['host_unhealthy']}
        with patch.object(mail.smtplib, 'SMTP_SSL') as connection:
            smtp = connection.return_value.__enter__.return_value
            smtp.send_message.return_value = {}
            mail.send_mail({'HANMAIL_USER':'fixture','HANMAIL_APP_PW':'TOP-SECRET'}, RECIPIENT, ORIGIN, event)
            context = connection.call_args.kwargs['context']
            self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
            self.assertTrue(context.check_hostname)
            self.assertEqual(connection.call_args.args, ('smtp.daum.net',465))
            message = smtp.send_message.call_args.args[0]
            self.assertEqual(message['To'], RECIPIENT)
            self.assertNotIn('TOP-SECRET', message.as_string())
            self.assertFalse(message.is_multipart())
            smtp.send_message.return_value = {RECIPIENT:(550,b'refused')}
            with self.assertRaises(RuntimeError): mail.send_mail({'HANMAIL_USER':'fixture','HANMAIL_APP_PW':'TOP-SECRET'}, RECIPIENT, ORIGIN, event)

    def test_12_header_injection_and_invalid_events_refused(self):
        for value in ('x@example.invalid\nBcc: victim@example.invalid', 'x@example.invalid,y@example.invalid', 'Display <x@example.invalid>'):
            with self.assertRaises(ValueError): mail.address(value)
        with self.assertRaises(ValueError): mail.event_valid({'id':'a'*32,'kind':'alert','checked_at':NOW,'faults':['private log']})

    def test_13_real_lock_contention_and_release_after_process_exit(self):
        path = self.root/'run.lock'
        source = 'import sys,pathlib;sys.path.insert(0,sys.argv[1]);import ops_email_monitor as m;\nwith m.lock(pathlib.Path(sys.argv[2])): pass'
        args = [sys.executable,'-c',source,str(Path(mail.__file__).parent),str(path)]
        with mail.lock(path):
            child = subprocess.run(args,capture_output=True)
            self.assertNotEqual(child.returncode, 0)
        child = subprocess.run(args,capture_output=True)
        self.assertEqual(child.returncode, 0, child.stderr)
        self.assertTrue(path.exists())

    def test_14_symlink_and_public_file_refusal(self):
        # Explicitly simulate symlink metadata on Windows, where creating one can
        # require a developer-mode privilege unrelated to the file safety rule.
        path = Mock();path.is_symlink.return_value = True
        with self.assertRaises(ValueError): mail.private_file(path)
        path.is_symlink.return_value = False;path.is_file.return_value = True
        path.stat.return_value.st_uid = 1000;path.stat.return_value.st_mode = 0o100644
        with patch.object(mail.os,'name','posix'), patch.object(mail.os,'geteuid',return_value=1000,create=True):
            with self.assertRaises(ValueError): mail.private_file(path)

    def test_15_clock_rollback_refused(self):
        self.tick(now=NOW+300)
        with self.assertRaises(ValueError): self.tick(now=NOW)

    def test_16_cli_initialization_exclusive_and_drill_separate(self):
        args = [sys.executable,mail.__file__,'--origin',ORIGIN,'--recipient',RECIPIENT,
                '--credentials',str(self.root/'missing-credentials'),'--state-dir',str(self.root/'cli')]
        first = subprocess.run([*args,'--initialize'],capture_output=True)
        self.assertEqual(first.returncode,0,first.stderr)
        again = subprocess.run([*args,'--initialize'],capture_output=True)
        self.assertEqual(again.returncode,1)
        drill = subprocess.run([*args,'--initialize','--mode','drill-alert'],capture_output=True)
        self.assertEqual(drill.returncode,0,drill.stderr)
        self.assertTrue((self.root/'cli/live.json').exists())
        self.assertTrue((self.root/'cli/drill.json').exists())
        missing = subprocess.run(args,capture_output=True)
        self.assertEqual(missing.returncode,1)
        self.assertNotIn(b'missing-credentials',missing.stderr)


if __name__ == '__main__':
    unittest.main(verbosity=2)
