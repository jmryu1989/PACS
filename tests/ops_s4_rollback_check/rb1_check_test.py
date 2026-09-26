"""Pure checks for the RISK-RB-1 harness: no Docker, no database, no network."""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock
import uuid

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import rb1_check as rb1

WORKFLOW = HERE.parents[1] / '.github' / 'workflows' / 's4-rollback-entrypoint-check.yml'
NODE_ENTRYPOINT = ['docker-entrypoint.sh']


def good_summary():
    return {
        'schema': 1, 'harness_complete': True, 'harness_errors': [],
        'facts': {
            'current_precondition_met': True, 'previous_entrypoint_unmodified': True,
            'previous_migrate_deploy_exit_inferred': 0, 'previous_migrate_deploy_exit_isolated': 0,
            'previous_healthy_on_migrated_db': True, 'history_unchanged_by_previous_boot': True,
            'schema_unchanged_by_previous_boot': True, 'history_unchanged_by_isolated_probes': True,
            # Optional observations never gate the report.
            'control_previous_healthy_on_fresh_db': False, 'previous_migrate_status_exit_isolated': 1,
        },
    }


class ClassifyBoot(unittest.TestCase):
    PRISMA_OK = (b'Prisma schema loaded from prisma/schema.prisma\n'
                 b'23 migrations found in prisma/migrations\n\nNo pending migrations to apply.\n')

    def test_node_output_means_migrate_deploy_exited_zero(self):
        stdout = self.PRISMA_OK + b'[Nest] 1  - LOG [NestFactory] Starting Nest application...\n'
        facts = rb1.classify_boot(stdout, b'', {'Running': True, 'ExitCode': 0}, {'healthy': False})
        self.assertTrue(facts['node_reached'])
        self.assertFalse(facts['nest_started'])
        self.assertTrue(facts['prisma_no_pending_line'])
        self.assertEqual(facts['migrate_deploy_exit_inferred'], 0)
        self.assertIsNone(facts['container_exit_code_at_poll_end'])
        self.assertEqual(facts['stdout_sha256'], hashlib.sha256(stdout).hexdigest())
        self.assertEqual(facts['stderr_sha256'], hashlib.sha256(b'').hexdigest())

    def test_health_alone_is_node_evidence(self):
        facts = rb1.classify_boot(b'', b'', {'Running': True}, {'healthy': True})
        self.assertTrue(facts['node_reached'])
        self.assertEqual(facts['migrate_deploy_exit_inferred'], 0)

    def test_failed_migrate_takes_the_container_exit_and_lists_codes(self):
        stderr = b'Error: P3009\n\nmigrate found failed migrations in the target database\n'
        facts = rb1.classify_boot(b'Prisma schema loaded\n', stderr, {'Running': False, 'ExitCode': 1},
                                  {'healthy': False})
        self.assertFalse(facts['node_reached'])
        self.assertEqual(facts['migrate_deploy_exit_inferred'], 1)
        self.assertEqual(facts['container_exit_code_at_poll_end'], 1)
        self.assertEqual(facts['prisma_error_codes'], ['P3009'])
        self.assertIn('set -eu', facts['migrate_deploy_exit_basis'])

    def test_prisma_success_then_a_silent_node_death_is_not_blamed_on_migrate(self):
        facts = rb1.classify_boot(self.PRISMA_OK, b'', {'Running': False, 'ExitCode': 1}, {'healthy': False})
        self.assertFalse(facts['node_reached'])
        self.assertEqual(facts['migrate_deploy_exit_inferred'], 0)
        self.assertIn('prisma', facts['migrate_deploy_exit_basis'])

    def test_running_without_any_marker_is_undetermined(self):
        facts = rb1.classify_boot(b'', b'', {'Running': True}, {'healthy': False})
        self.assertIsNone(facts['migrate_deploy_exit_inferred'])
        facts = rb1.classify_boot(b'', b'', None, {'healthy': False})
        self.assertIsNone(facts['migrate_deploy_exit_inferred'])
        # A non-integer exit is never passed through as a status.
        facts = rb1.classify_boot(b'', b'', {'Running': False, 'ExitCode': None}, {'healthy': False})
        self.assertIsNone(facts['migrate_deploy_exit_inferred'])


class Health(unittest.TestCase):
    def probe(self, **body):
        return (json.dumps(body) + '\n').encode()

    def test_only_200_with_ok_and_auth_is_healthy(self):
        good = self.probe(status=200, body=json.dumps({'ok': True, 'at': 'x', 'auth': True}))
        self.assertTrue(rb1.evaluate_health(b'noise\n' + good)['healthy'])
        for body in ({'ok': True, 'auth': False}, {'ok': False, 'auth': True}, {'ok': 1, 'auth': True}):
            self.assertFalse(rb1.evaluate_health(self.probe(status=200, body=json.dumps(body)))['healthy'], body)
        self.assertFalse(rb1.evaluate_health(self.probe(status=500, body=json.dumps({'ok': True, 'auth': True})))['healthy'])
        self.assertFalse(rb1.evaluate_health(self.probe(status=200, body='<html>'))['healthy'])

    def test_errors_and_garbage_are_unhealthy_with_a_reason(self):
        refused = rb1.evaluate_health(self.probe(error='ECONNREFUSED'))
        self.assertEqual((refused['healthy'], refused['error']), (False, 'ECONNREFUSED'))
        for raw in (b'', b'not json', b'[1,2]'):
            self.assertFalse(rb1.evaluate_health(raw)['healthy'])
            self.assertIsNotNone(rb1.evaluate_health(raw)['error'])


class History(unittest.TestCase):
    def raw(self, *rows):
        return ''.join('|'.join(row) + '\n' for row in rows).encode()

    def row(self, name, finished='2026-09-26 00:00:01+00', rolled='', logs='t'):
        return ('id-' + name, name, 'c' * 64, '2026-09-26 00:00:00+00', finished, rolled, '1', logs)

    def test_parse_and_facts(self):
        rows = rb1.parse_history(self.raw(self.row('0_init'), self.row('20260917120000_findings')))
        self.assertEqual([r['migration_name'] for r in rows], ['0_init', '20260917120000_findings'])
        facts = rb1.history_facts(rows, ['0_init', '20260917120000_findings'], 2)
        self.assertEqual({k: facts[k] for k in ('count', 'count_matches', 'names_match_image_migrations',
                                                'all_finished', 'none_rolled_back', 'all_logs_null')},
                         {'count': 2, 'count_matches': True, 'names_match_image_migrations': True,
                          'all_finished': True, 'none_rolled_back': True, 'all_logs_null': True})
        self.assertEqual(facts['duplicate_names'], [])

    def test_unfinished_rolled_back_duplicate_and_wrong_count_are_visible(self):
        rows = rb1.parse_history(self.raw(self.row('0_init'), self.row('0_init', finished='', rolled='x', logs='f')))
        facts = rb1.history_facts(rows, ['0_init'], 29)
        self.assertFalse(facts['count_matches'])
        self.assertFalse(facts['names_match_image_migrations'])
        self.assertFalse(facts['all_finished'])
        self.assertFalse(facts['none_rolled_back'])
        self.assertFalse(facts['all_logs_null'])
        self.assertEqual(facts['duplicate_names'], ['0_init'])

    def test_malformed_row_is_a_harness_error(self):
        with self.assertRaises(rb1.HarnessError):
            rb1.parse_history(b'only|three|fields\n')


class SchemaDump(unittest.TestCase):
    BODY = b'--\n-- PostgreSQL database dump\n--\n\nCREATE TABLE public."Order" (oid text NOT NULL);\n'

    def dump(self, key, body=BODY):
        return b'\\restrict ' + key + b'\n\n' + body + b'\n\\unrestrict ' + key + b'\n'

    def test_only_the_per_run_restrict_key_is_ignored(self):
        first, dropped = rb1.normalize_schema_dump(self.dump(b'Ab12'))
        second, _ = rb1.normalize_schema_dump(self.dump(b'Zz99'))
        self.assertEqual(dropped, 2)
        self.assertEqual(first, second)
        self.assertNotEqual(self.dump(b'Ab12'), self.dump(b'Zz99'))
        changed, _ = rb1.normalize_schema_dump(self.dump(b'Zz99', self.BODY + b'ALTER TABLE public."Order" ADD x text;\n'))
        self.assertNotEqual(first, changed)

    def test_older_dumps_and_embedded_text_are_untouched(self):
        self.assertEqual(rb1.normalize_schema_dump(self.BODY), (self.BODY, 0))
        embedded = b'-- \\restrict k\nCOMMENT ON TABLE x IS \'\\restrict k\';\n'
        self.assertEqual(rb1.normalize_schema_dump(embedded), (embedded, 0))
        normalized, dropped = rb1.normalize_schema_dump(self.dump(b'k').replace(b'\n', b'\r\n'))
        self.assertEqual(dropped, 2)
        self.assertNotIn(b'restrict', normalized)


class Entrypoint(unittest.TestCase):
    def test_node_base_entrypoint_followed_by_the_start_script(self):
        image = {'cmd': rb1.START_CMD, 'entrypoint': NODE_ENTRYPOINT}
        created = {'cmd': rb1.START_CMD, 'entrypoint': NODE_ENTRYPOINT, 'path': 'docker-entrypoint.sh',
                   'args': ['sh', '/app/start-production.sh']}
        self.assertEqual(rb1.created_process(created), ['docker-entrypoint.sh', 'sh', '/app/start-production.sh'])
        self.assertTrue(rb1.entrypoint_unmodified(image, created))

    def test_image_without_entrypoint(self):
        image = {'cmd': rb1.START_CMD, 'entrypoint': None}
        created = {'cmd': rb1.START_CMD, 'entrypoint': None, 'path': 'sh', 'args': ['/app/start-production.sh']}
        self.assertTrue(rb1.entrypoint_unmodified(image, created))

    def test_any_override_is_refused(self):
        image = {'cmd': rb1.START_CMD, 'entrypoint': NODE_ENTRYPOINT}
        base = {'cmd': rb1.START_CMD, 'entrypoint': NODE_ENTRYPOINT, 'path': 'docker-entrypoint.sh',
                'args': ['sh', '/app/start-production.sh']}
        # The Stage-1 bypass shape, a replaced command, and a process that disagrees with the config.
        overrides = ({'entrypoint': ['node'], 'path': 'node'},
                     {'cmd': ['node', 'dist/main.js'], 'args': ['node', 'dist/main.js']},
                     {'args': ['sh', '-c', 'node dist/main.js']},
                     {'path': 'sh', 'args': ['/app/start-production.sh']})
        for change in overrides:
            self.assertFalse(rb1.entrypoint_unmodified(image, {**base, **change}), change)
        self.assertFalse(rb1.entrypoint_unmodified({'cmd': ['node'], 'entrypoint': NODE_ENTRYPOINT}, base))
        self.assertFalse(rb1.entrypoint_unmodified(image, None))
        self.assertIsNone(rb1.created_process({'path': 'sh', 'args': None}))


class Environment(unittest.TestCase):
    def test_shape_matches_production_image_test_and_secrets_stay_out(self):
        env = rb1.api_env('kin_control', token=lambda size: 'T' * size)
        self.assertEqual(env['DATABASE_URL'], 'postgresql://postgres@127.0.0.1:5432/kin_control')
        self.assertEqual((env['DEPLOYMENT_MODE'], env['AUTH_REQUIRED']), ('production', 'true'))
        for key in ('KC_ISSUER', 'KC_JWKS_URL', 'KC_AUDIENCE', 'KC_WEB_SECRET', 'KIN_COOKIE_SECRET', 'PUBLIC_ORIGIN'):
            self.assertTrue(env[key], key)  # the keys main.ts refuses to start without
        public = rb1.public_env(env)
        for key in rb1.SECRET_KEYS:
            self.assertEqual(public[key], '<generated>')
        self.assertNotIn('TTTT', json.dumps(public))
        text = rb1.env_file_text(env)
        self.assertEqual(text.count('\n'), len(env))
        self.assertIn('AUTH_REQUIRED=true\n', text)

    def test_real_generator_differs_per_call(self):
        self.assertNotEqual(rb1.api_env('kin')['KIN_COOKIE_SECRET'], rb1.api_env('kin')['KIN_COOKIE_SECRET'])

    def test_invalid_names_and_values_are_refused(self):
        for database in ('Kin', 'kin;drop', '', 'kin/x', 'k' * 40):
            with self.assertRaises(rb1.HarnessError, msg=database):
                rb1.api_env(database)
        for env in ({'lower': 'x'}, {'A B': 'x'}, {'KEY': 'x\ny'}, {'KEY': 'x\r'}, {'KEY': 1}):
            with self.assertRaises(rb1.HarnessError, msg=repr(env)):
                rb1.env_file_text(env)


class Report(unittest.TestCase):
    GATES = ('current_precondition_met', 'previous_entrypoint_unmodified', 'previous_migrate_deploy_exit_inferred',
             'previous_migrate_deploy_exit_isolated', 'previous_healthy_on_migrated_db',
             'history_unchanged_by_previous_boot', 'schema_unchanged_by_previous_boot',
             'history_unchanged_by_isolated_probes')

    def test_complete_healthy_summary_passes_and_optional_facts_do_not_gate(self):
        self.assertEqual(rb1.report_failures(good_summary()), [])

    def test_each_primary_fact_gates_by_name(self):
        for key in self.GATES:
            exit_fact = key.endswith(('_inferred', '_isolated'))
            for bad in ((None, 1, 137, False, '0') if exit_fact else (None, False, 1, 'true')):
                summary = good_summary()
                summary['facts'][key] = bad
                failures = rb1.report_failures(summary)
                self.assertEqual(len(failures), 1, (key, bad))
                self.assertIn(key, failures[0])
            summary = good_summary()
            del summary['facts'][key]
            self.assertIn(key, ' '.join(rb1.report_failures(summary)))

    def test_true_is_not_zero_and_one_is_not_true(self):
        summary = good_summary()
        summary['facts']['previous_migrate_deploy_exit_isolated'] = False
        summary['facts']['previous_healthy_on_migrated_db'] = 1
        self.assertEqual(len(rb1.report_failures(summary)), 2)

    def test_incomplete_harness_and_bad_shapes(self):
        summary = good_summary()
        summary['harness_complete'] = False
        summary['harness_errors'] = ['HarnessError: synthetic PostgreSQL readiness timed out']
        self.assertIn('readiness timed out', rb1.report_failures(summary)[0])
        summary = good_summary()
        summary['harness_complete'] = 'yes'
        self.assertIn('unknown', rb1.report_failures(summary)[0])
        self.assertEqual(rb1.report_failures({'schema': 2}), ['summary schema is not 1'])
        self.assertEqual(rb1.report_failures([]), ['summary schema is not 1'])
        self.assertEqual(rb1.report_failures({'schema': 1}), ['summary has no facts'])

    def test_report_cli_exit_follows_failures(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'rb1-check-summary.json'
            for summary, expected in ((good_summary(), 0), ({**good_summary(), 'harness_complete': False}, 1)):
                path.write_text(json.dumps(summary), encoding='utf-8')
                with contextlib.redirect_stdout(io.StringIO()) as printed:
                    self.assertEqual(rb1.main(['report', str(path)]), expected)
                self.assertEqual(json.loads(printed.getvalue())['facts'], summary['facts'])


class Recorder(unittest.TestCase):
    def test_raw_streams_exit_and_hashes_are_kept(self):
        with tempfile.TemporaryDirectory() as folder:
            recorder = rb1.Recorder(Path(folder))
            script = 'import sys; sys.stdout.buffer.write(b"out\\x00"); sys.stderr.write("err"); sys.exit(3)'
            stdout, stderr, entry = recorder.run('child', [sys.executable, '-c', script])
            self.assertEqual((stdout, stderr, entry['exit'], entry['error']), (b'out\x00', b'err', 3, None))
            step = Path(folder) / entry['folder']
            self.assertEqual(step.name, '001-child')
            self.assertEqual((step / 'stdout.log').read_bytes(), b'out\x00')
            self.assertEqual((step / 'stderr.log').read_bytes(), b'err')
            self.assertEqual(json.loads((step / 'step.json').read_text(encoding='utf-8')), entry)
            self.assertEqual(entry['stdout_sha256'], hashlib.sha256(b'out\x00').hexdigest())
            with self.assertRaises(rb1.HarnessError):
                recorder.run('checked', [sys.executable, '-c', 'raise SystemExit(4)'], check=True)
            self.assertEqual(recorder.index[-1]['exit'], 4)
            _, _, entry = recorder.run('slow', [sys.executable, '-c', 'import time; time.sleep(5)'], timeout=0.5)
            self.assertEqual((entry['exit'], entry['error']), (None, 'timeout'))
            _, _, entry = recorder.run('missing', [str(Path(folder) / 'no-such-executable')])
            self.assertEqual((entry['exit'], entry['error']), (None, 'FileNotFoundError'))
            self.assertEqual([e['step'] for e in recorder.index], [1, 2, 3, 4])


class Sql(unittest.TestCase):
    def test_seed_is_synthetic_and_single_statement(self):
        values = re.findall(r"'([^']*)'", rb1.SEED_SQL.split('VALUES', 1)[1])
        self.assertEqual(len(values), 12)
        self.assertEqual(rb1.SEED_SQL.count("'") % 2, 0)
        self.assertNotIn(';', rb1.SEED_SQL)
        # oid, institution, patient id, name, ward, accession: every identifying field is synthetic.
        for index in (0, 1, 2, 3, 9, 11):
            self.assertTrue(values[index].startswith('SYN'), values[index])
        self.assertEqual((values[0], values[11]), (rb1.SYNTHETIC_ORDER, rb1.SYNTHETIC_ACCESSION))
        self.assertIn('ORDER BY migration_name COLLATE "C"', rb1.HISTORY_SQL)


PREV, CUR = '17980d522b260b59fa97c96924f96038b63551ae', '489c326478d1e2ffdfe556803cb3c3ea5eff3862'
PREV_MIGRATIONS = ['0_init'] + ['202609010000%02d_m%02d' % (i, i) for i in range(1, 23)]
LATER = ['20260917120000_findings', '20260920120000_report_citations', '20260921120000_report_structure',
         '20260924120000_order_accession', '20260924130000_gateway_receipt', '20260924140000_gateway_retry_request']
CUR_MIGRATIONS = PREV_MIGRATIONS + LATER


class FakeHost:
    """A scripted docker/git stand-in for subprocess.run, so the whole sequence runs without a daemon.

    It models only what the harness reads: image config, created-container process, container
    state and logs, the history table per database, and the probes. It is not evidence of Docker's
    behaviour; the hosted run is.
    """

    def __init__(self, previous_fails=False, current_label=CUR):
        self.previous_fails = previous_fails
        self.labels = {'kin-api:rb1-previous': PREV, 'kin-api:rb1-current': current_label}
        self.ids = {'kin-api:rb1-previous': 'sha256:' + 'a' * 64, 'kin-api:rb1-current': 'sha256:' + 'b' * 64}
        self.migrations = {self.ids['kin-api:rb1-previous']: PREV_MIGRATIONS,
                           self.ids['kin-api:rb1-current']: CUR_MIGRATIONS}
        self.containers, self.history, self.secrets, self.ward = {}, {}, [], None

    def __call__(self, argv, **kwargs):
        stdout, stderr, code = self.dispatch(list(argv))
        return subprocess.CompletedProcess(argv, code, stdout, stderr)

    def read_env(self, argv):
        path = Path(argv[argv.index('--env-file') + 1])
        env = dict(line.split('=', 1) for line in path.read_text(encoding='utf-8').splitlines())
        self.secrets += [env[key] for key in rb1.SECRET_KEYS]
        return env['DATABASE_URL'].rsplit('/', 1)[1]

    def dispatch(self, a):
        ok = lambda out=b'': (out, b'', 0)  # noqa: E731
        if a[:2] == ['git', 'rev-parse']:
            if a[2:] == ['HEAD', 'HEAD:api']:
                return ok(b'f' * 40 + b'\n' + b'c' * 40 + b'\n')
            return ok((b'd' if a[2].startswith(PREV) else b'c') * 40 + b'\n')
        if a[:2] == ['docker', 'version']:
            return ok(b'{}\n')
        if a[:3] == ['docker', 'image', 'inspect']:
            config = {'User': 'node', 'Cmd': rb1.START_CMD, 'Entrypoint': NODE_ENTRYPOINT, 'WorkingDir': '/app',
                      'Labels': {'org.opencontainers.image.revision': self.labels[a[3]]}}
            return ok(json.dumps([{'Id': self.ids[a[3]], 'Config': config}]).encode())
        if a[:2] == ['docker', 'run']:
            at = a.index('--entrypoint')
            image = a[at + 2]
            if a[at + 1] == 'node':
                return ok(json.dumps({'prisma': '5.22.0', 'prisma_client': '5.22.0', 'migrations': self.migrations[image],
                                      'start_script_sha256': 'e' * 64, 'start_script': '#!/bin/sh\n'}).encode() + b'\n')
            self.read_env(a)
            failing = self.previous_fails and image == self.ids['kin-api:rb1-previous']
            if a[at + 4] == rb1.MIGRATE_LINE:
                return (b'', b'Error: P3009\n', 1) if failing else ok(b'23 migrations found\n\nNo pending migrations to apply.\n')
            return b'not in sync\n', b'', 1
        if a[:2] == ['docker', 'create']:
            name = a[a.index('--name') + 1]
            self.containers[name] = {'token': a[a.index('--label') + 1].split('=', 1)[1], 'image': a[-1],
                                     'database': self.read_env(a) if '--env-file' in a else None,
                                     'running': False, 'exit': 0, 'healthy': False, 'polls': 0,
                                     'stdout': b'', 'stderr': b''}
            return ok(name.encode() + b'\n')
        if a[:2] == ['docker', 'start']:
            return self.start(a[2])
        if a[:2] == ['docker', 'stop']:
            self.containers[a[-1]]['running'] = False
            return ok()
        if a[:2] == ['docker', 'logs']:
            return self.containers[a[-1]]['stdout'], self.containers[a[-1]]['stderr'], 0
        if a[:2] == ['docker', 'inspect']:
            fmt, c = a[3], self.containers[a[4]]
            if fmt == rb1.CREATED_FORMAT:
                return ok(json.dumps({'cmd': rb1.START_CMD, 'entrypoint': NODE_ENTRYPOINT,
                                      'path': NODE_ENTRYPOINT[0], 'args': rb1.START_CMD}).encode())
            if fmt == '{{json .State}}':
                return ok(json.dumps({'Running': c['running'], 'ExitCode': c['exit']}).encode())
            if fmt == '{{.State.Running}}':
                return ok(b'true\n' if c['running'] else b'false\n')
        if a[:3] == ['docker', 'container', 'inspect']:
            if a[-1] not in self.containers:
                return b'[]\n', b'Error: No such container: ' + a[-1].encode() + b'\n', 1
            return ok(self.containers[a[-1]]['token'].encode() + b'\n' if '--format' in a else b'[{}]\n')
        if a[:2] == ['docker', 'rm']:
            del self.containers[a[-1]]
            return ok()
        if a[:2] == ['docker', 'exec']:
            at, env = 2, {}
            while a[at] == '-e':
                key, value = a[at + 1].split('=', 1)
                env[key], at = value, at + 2
            return self.execute(self.containers[a[at]], a[at + 1:], env)
        raise AssertionError('unexpected command: %r' % a)

    def start(self, name):
        c = self.containers[name]
        c['running'] = True
        if c['database'] is None:
            return b'', b'', 0
        current = c['image'] == self.ids['kin-api:rb1-current']
        if not current and self.previous_fails and c['database'] == 'kin':
            c.update(running=False, exit=1, stdout=b'Prisma schema loaded\n',
                     stderr=b'Error: P3009\nmigrate found failed migrations\n')
            return b'', b'', 0
        names = CUR_MIGRATIONS if current else PREV_MIGRATIONS
        self.history.setdefault(c['database'], list(names))
        c.update(healthy=True, stdout=b'%d migrations found in prisma/migrations\n\nNo pending migrations to apply.\n'
                 b'[Nest] 1 - LOG [NestFactory] Starting Nest application...\n'
                 b'[Nest] 1 - LOG [NestApplication] Nest application successfully started\n' % len(names))
        return b'', b'', 0

    def execute(self, c, cmd, env):
        if c['database'] is None:
            return self.database(cmd)
        if cmd[:2] == ['node', '-e'] and cmd[2] == rb1.PROBE_SCRIPT:
            c['polls'] += 1
            # The first poll of every container is refused, so the loop is exercised.
            if not (c['running'] and c['healthy']) or c['polls'] == 1:
                return b'{"error":"ECONNREFUSED"}\n', b'', 2
            if env['RB1_PATH'] == '/api/health':
                body = json.dumps({'ok': True, 'at': 'x', 'auth': True})
                return json.dumps({'status': 200, 'body': body}).encode() + b'\n', b'', 0
            return b'{"status":401,"body":"{}"}\n', b'', 0
        if cmd[:2] == ['node', '-e'] and cmd[2] == rb1.ORDER_SCRIPT:
            self.ward = env['RB1_WARD']
            return json.dumps({'found': True, 'keys': ['oid', 'ward'], 'accession_key_present': False,
                               'find_many_count': 6, 'update_returned_ward': self.ward}).encode() + b'\n', b'', 0
        raise AssertionError('unexpected exec: %r' % cmd)

    def database(self, cmd):
        if cmd[0] in ('pg_isready', 'postgres', 'createdb'):
            return b'ok\n', b'', 0
        if cmd[0] == 'pg_dump':
            key = uuid.uuid4().hex.encode()  # a new key per dump, as pg_dump 16.10+ does
            return b'\\restrict ' + key + b'\n\nCREATE TABLE public."Order" ();\n\n\\unrestrict ' + key + b'\n', b'', 0
        database, sql = cmd[cmd.index('-d') + 1], cmd[cmd.index('-c') + 1]
        if sql == rb1.HISTORY_SQL:
            return ''.join('id-%s|%s|%s|2026-09-26 00:00:00+00|2026-09-26 00:00:01+00||1|t\n' % (n, n, 'c' * 64)
                           for n in self.history.get(database, [])).encode(), b'', 0
        if sql == rb1.SEED_SQL:
            self.ward = rb1.SYNTHETIC_WARD
            return b'', b'', 0
        if sql == rb1.ORDER_SQL:
            return ('%s|%s\n' % (rb1.SYNTHETIC_ACCESSION, self.ward)).encode(), b'', 0
        raise AssertionError('unexpected psql: %r' % cmd)


class SequenceOverFakeHost(unittest.TestCase):
    def sequence(self, host):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        out = Path(folder.name) / 'check'
        args = argparse.Namespace(previous_image='kin-api:rb1-previous', current_image='kin-api:rb1-current',
                                  postgres_image='postgres:16-alpine@sha256:' + '0' * 64,
                                  previous_revision=PREV, current_revision=CUR, out=str(out))
        with mock.patch.object(subprocess, 'run', host), mock.patch.object(time, 'sleep', lambda seconds: None):
            code = rb1.run(args)
        summary = json.loads((out / 'rb1-check-summary.json').read_text(encoding='utf-8'))
        # Every generated throwaway value stayed in the env files, which are gone.
        for path in out.rglob('*'):
            if path.is_file():
                data = path.read_bytes()
                for value in host.secrets:
                    self.assertNotIn(value.encode(), data, path)
        self.assertEqual(host.containers, {}, 'every owned container removed')
        self.assertEqual(summary['cleanup_errors'], [])
        return code, summary, out

    def test_healthy_previous_image_gives_every_primary_fact(self):
        host = FakeHost()
        code, summary, out = self.sequence(host)
        self.assertEqual(len(host.secrets), 4 * 5, 'four generated values per API container or probe')
        self.assertEqual(code, 0)
        self.assertTrue(summary['harness_complete'], summary['harness_errors'])
        self.assertEqual(summary['report_failures'], [])
        facts = summary['facts']
        self.assertEqual(facts['current_migrated_rows'], 29)
        self.assertEqual(facts['db_rows_unknown_to_previous_image'], LATER)
        self.assertTrue(facts['previous_entrypoint_unmodified'])
        self.assertEqual((facts['previous_migrate_deploy_exit_inferred'], facts['previous_migrate_deploy_exit_isolated']), (0, 0))
        self.assertTrue(facts['schema_unchanged_by_previous_boot'])
        self.assertNotEqual(facts['schema_sha256']['before_previous']['raw_sha256'],
                            facts['schema_sha256']['after_previous']['raw_sha256'])
        self.assertTrue(facts['history_unchanged_by_previous_boot'] and facts['history_unchanged_by_isolated_probes'])
        self.assertTrue(facts['control_previous_healthy_on_fresh_db'] and facts['head_api_tree_equals_current'])
        self.assertEqual(facts['previous_health']['status'], 200)
        stages = summary['stages']
        self.assertEqual(stages['control_previous_fresh_db']['history']['count'], 23)
        self.assertTrue(stages['control_previous_fresh_db']['history']['names_match_image_migrations'])
        seen = stages['previous_boot']['observations']
        self.assertEqual((seen['/api/studies']['status'], seen['/api/me']['status']), (401, 401))
        self.assertEqual(seen['order_row_after']['row'], seen['order_row_after']['expected'])
        self.assertEqual(stages['previous_boot']['health']['attempts'], 2)
        self.assertEqual(stages['previous_boot']['created_process'], NODE_ENTRYPOINT + rb1.START_CMD)
        self.assertEqual(summary['api_env']['KIN_COOKIE_SECRET'], '<generated>')
        for step in summary['steps']:
            self.assertTrue((out / step['folder'] / 'stdout.log').is_file(), step['name'])

    def test_failed_previous_migrate_is_recorded_not_raised(self):
        host = FakeHost(previous_fails=True)
        code, summary, _ = self.sequence(host)
        self.assertEqual(len(host.secrets), 4 * 5)
        self.assertEqual(code, 0)
        self.assertTrue(summary['harness_complete'], summary['harness_errors'])
        facts = summary['facts']
        self.assertEqual((facts['previous_migrate_deploy_exit_inferred'], facts['previous_migrate_deploy_exit_isolated']), (1, 1))
        self.assertFalse(facts['previous_healthy_on_migrated_db'])
        self.assertEqual(facts['previous_prisma_error_codes'], ['P3009'])
        self.assertEqual(facts['previous_health']['ended_because'], 'exited')
        self.assertTrue(facts['control_previous_healthy_on_fresh_db'])
        failures = ' '.join(summary['report_failures'])
        for key in ('previous_migrate_deploy_exit_inferred', 'previous_migrate_deploy_exit_isolated',
                    'previous_healthy_on_migrated_db'):
            self.assertIn(key, failures)
        self.assertEqual(len(summary['report_failures']), 3)
        self.assertNotIn('/api/studies', summary['stages']['previous_boot']['observations'])

    def test_wrong_image_revision_is_a_harness_error_with_a_summary(self):
        host = FakeHost(current_label='0' * 40)
        code, summary, _ = self.sequence(host)
        self.assertEqual(host.secrets, [], 'refused before any container was created')
        self.assertEqual(code, 2)
        self.assertFalse(summary['harness_complete'])
        self.assertIn('current image revision label', summary['harness_errors'][0])
        self.assertIn('harness incomplete', summary['report_failures'][0])


class Workflow(unittest.TestCase):
    """Text checks, so this runs where PyYAML is absent; the YAML parse is a separate check."""

    @classmethod
    def setUpClass(cls):
        cls.text = WORKFLOW.read_text(encoding='utf-8').replace('\r\n', '\n')
        # Comments explain the Stage-1 `--entrypoint node` bypass; only executable lines are checked.
        cls.code = '\n'.join(line for line in cls.text.splitlines() if not line.lstrip().startswith('#'))

    def test_dispatch_only_read_only_and_pinned(self):
        on_block = self.text.split('\non:\n', 1)[1].split('\n\n', 1)[0]
        # Commander change: GitHub refuses workflow_dispatch for a file that only exists on its own branch,
        # so a push trigger limited to exactly that branch is accepted next to workflow_dispatch.
        self.assertIn(on_block.strip(), ('workflow_dispatch:',
                                         'workflow_dispatch:\n  push:\n    branches: [opus/s4-rb1-check-20260926]'))
        self.assertIn('\npermissions:\n  contents: read\n', self.text)
        self.assertNotIn('secrets.', self.code)
        uses = re.findall(r'uses:\s*(\S+)', self.text)
        self.assertTrue(uses)
        for action in uses:
            self.assertRegex(action, r'^[\w.-]+/[\w.-]+@[0-9a-f]{40}$')
        self.assertEqual(self.text.count('persist-credentials: false'), self.text.count('actions/checkout@'))

    def test_revisions_and_harness_invocation(self):
        self.assertIn('PREVIOUS_REVISION: 17980d522b260b59fa97c96924f96038b63551ae', self.text)
        self.assertIn('CURRENT_REVISION: 489c326478d1e2ffdfe556803cb3c3ea5eff3862', self.text)
        self.assertRegex(self.text, r'RB1_POSTGRES: postgres:16-alpine@sha256:[0-9a-f]{64}')
        self.assertIn('--target production --build-arg "VCS_REF=$PREVIOUS_REVISION"', self.text)
        self.assertIn('--target production --build-arg "VCS_REF=$CURRENT_REVISION"', self.text)
        self.assertIn('tests/ops_s4_rollback_check/rb1_check.py run', self.text)
        self.assertIn('tests/ops_s4_rollback_check/rb1_check.py report', self.text)
        self.assertIn('rb1-check-summary.json', self.text)
        # The workflow never overrides an entrypoint; the harness labels its own secondary probes.
        self.assertNotIn('--entrypoint', self.code)


if __name__ == '__main__':
    unittest.main(verbosity=2)
