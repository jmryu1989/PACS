"""Film / DICOM Print helper (api/print/film_print.py) against synthetic printers and a synthetic device on loopback.

The helper runs as the API runs it (a separate process, one JSON request on stdin, JSON lines out); the listeners are
tests/film_print_scp.py in this process. Checked:
  - the N-service order and attributes: film session (copies), film box (STANDARD\\c,r, film size, orientation, the
    session reference), one N-SET per filled cell only (8-bit MONOCHROME2), N-ACTION print, N-GET of the Print Job;
  - Printed only on Print Job DONE; Sent before it; a printer silent after taking the film is no answer (result unknown);
  - no answer to the print request is no answer without Sent; no Print Job support is Sent without completion;
  - a warning status is kept with the result; a FAILURE carries the printer's reason; a closed port is a failure;
  - a printer that reports DONE on its own (N-EVENT-REPORT) and then deletes the job is Printed;
  - the layout image sent to a device is a Secondary Capture with the given identity (UTF-8) and UIDs, Sent then Stored.
"""
import base64
import json
import os
import socket
import subprocess
import sys
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import film_print_scp as scp  # noqa: E402

HELPER = os.path.join(HERE, '..', 'api', 'print', 'film_print.py')
PRINT_JOB = '1.2.840.10008.5.1.1.14'
FILM_BOX = '1.2.840.10008.5.1.1.2'
FILM_SESSION = '1.2.840.10008.5.1.1.1'
IMAGE_BOX = '1.2.840.10008.5.1.1.4'


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def grey(width, height, value):
    return {'width': width, 'height': height, 'pixels': base64.b64encode(bytes([value]) * (width * height)).decode()}


def run(request, timeout=60):
    started = time.monotonic()
    done = subprocess.run([sys.executable, '-I', HELPER], input=json.dumps(request), capture_output=True, text=True, timeout=timeout)
    events = [json.loads(line) for line in done.stdout.splitlines() if line.strip()]
    return events, time.monotonic() - started, done.stderr


class Helper(unittest.TestCase):
    listeners = {}

    @classmethod
    def setUpClass(cls):
        for mode in ('done', 'silent', 'no-action', 'no-job', 'warn', 'fail', 'notify', 'store'):
            aet = 'SYN' + mode.replace('-', '').upper()[:13]
            cls.listeners[mode] = scp.Listener(aet, free_port(), mode)

    @classmethod
    def tearDownClass(cls):
        scp.STOP.set()
        for listener in cls.listeners.values():
            listener.shutdown()

    def setUp(self):
        for listener in self.listeners.values():
            listener.received.clear()

    def request(self, mode, **extra):
        listener = self.listeners[mode]
        body = {'action': 'print', 'callingAet': 'SYNKIN', 'peer': {'aet': listener.aet, 'host': '127.0.0.1', 'port': listener.port},
                'timeouts': {'connect': 5, 'response': 4, 'completion': 4, 'poll': 0.5},
                'film': {'columns': 2, 'rows': 2, 'filmSize': '14INX17IN', 'orientation': 'PORTRAIT', 'copies': 2},
                'boxes': [dict(position=1, **grey(8, 6, 200)), dict(position=2, **grey(5, 7, 100)), dict(position=3, **grey(4, 4, 10))]}
        body.update(extra)
        return body

    def kinds(self, mode):
        return [entry['kind'] for entry in self.listeners[mode].received]

    def test_printed_follows_the_n_service_order_and_attributes(self):
        events, _, err = run(self.request('done'))
        self.assertEqual(['sent', 'final'], [e['event'] for e in events], err)
        self.assertTrue(events[0]['printJobUid'])
        self.assertEqual('printed', events[1]['state'])
        self.assertEqual([], events[1]['warnings'])
        got = self.listeners['done'].received
        self.assertEqual(['N-CREATE', 'N-CREATE', 'N-SET', 'N-SET', 'N-SET', 'N-ACTION', 'N-GET'], [e['kind'] for e in got][:7])
        session, box = got[0], got[1]
        self.assertEqual((FILM_SESSION, '2'), (session['sopClass'], session['attributes']['NumberOfCopies']))
        self.assertEqual(FILM_BOX, box['sopClass'])
        self.assertEqual('STANDARD\\2,2', box['attributes']['ImageDisplayFormat'])
        self.assertEqual(('14INX17IN', 'PORTRAIT'), (box['attributes']['FilmSizeID'], box['attributes']['FilmOrientation']))
        self.assertEqual(session['uid'], box['attributes']['ReferencedFilmSessionSequence'][0]['ReferencedSOPInstanceUID'])
        sets = [e for e in got if e['kind'] == 'N-SET']
        self.assertEqual(['1', '2', '3'], [s['attributes']['ImageBoxPosition'] for s in sets], 'the empty fourth cell is not set')
        self.assertTrue(all(s['sopClass'] == IMAGE_BOX for s in sets))
        self.assertEqual(self.listeners['done'].boxes[box['uid']][:3], [s['uid'] for s in sets])
        image = sets[0]['attributes']['BasicGrayscaleImageSequence'][0]
        self.assertEqual({'Rows': '6', 'Columns': '8', 'BitsAllocated': '8', 'BitsStored': '8', 'HighBit': '7',
                          'PixelRepresentation': '0', 'SamplesPerPixel': '1', 'PhotometricInterpretation': 'MONOCHROME2'},
                         {k: image[k] for k in ('Rows', 'Columns', 'BitsAllocated', 'BitsStored', 'HighBit', 'PixelRepresentation',
                                                'SamplesPerPixel', 'PhotometricInterpretation')})
        self.assertEqual({'length': 48, 'first': [200, 200, 200, 200], 'sum': 48 * 200}, image['PixelData'])
        odd = sets[1]['attributes']['BasicGrayscaleImageSequence'][0]['PixelData']
        self.assertEqual(36, odd['length'], 'an odd pixel count is padded to even length')
        action = got[5]
        self.assertEqual((FILM_BOX, box['uid'], 1), (action['sopClass'], action['uid'], action['action']))
        self.assertEqual((PRINT_JOB, events[0]['printJobUid']), (got[6]['sopClass'], got[6]['uid']))

    def test_a_printer_silent_after_taking_the_film_is_no_answer_never_printed(self):
        events, took, err = run(self.request('silent'))
        self.assertEqual(['sent', 'final'], [e['event'] for e in events], err)
        self.assertEqual('no-answer', events[1]['state'])
        self.assertLess(took, 20)
        self.assertIn('N-GET', self.kinds('silent'))

    def test_no_answer_to_the_print_request_is_no_answer_without_sent(self):
        events, _, err = run(self.request('no-action'))
        self.assertEqual(['final'], [e['event'] for e in events], err)
        self.assertEqual('no-answer', events[0]['state'])
        self.assertNotIn('N-GET', self.kinds('no-action'))

    def test_a_printer_without_print_job_is_sent_and_does_not_report_completion(self):
        events, _, err = run(self.request('no-job'))
        self.assertEqual(['sent', 'final'], [e['event'] for e in events], err)
        self.assertEqual('sent-unreported', events[1]['state'])
        self.assertNotIn('N-GET', self.kinds('no-job'))

    def test_a_warning_is_kept_with_the_result(self):
        events, _, err = run(self.request('warn'))
        self.assertEqual('printed', events[-1]['state'], err)
        self.assertEqual(['0xB604 image larger than its box - it was made smaller'], events[-1]['warnings'])
        self.assertEqual(events[0]['warnings'], events[-1]['warnings'], 'Sent already shows the warning')

    def test_a_print_job_failure_carries_the_printer_reason(self):
        events, _, err = run(self.request('fail'))
        self.assertEqual(['sent', 'final'], [e['event'] for e in events], err)
        self.assertEqual(('failed', 'SUPPLY EMPTY'), (events[1]['state'], events[1]['reason']))

    def test_a_printer_that_reports_done_on_its_own_and_deletes_the_job_is_printed(self):
        events, _, err = run(self.request('notify'))
        self.assertEqual(['sent', 'final'], [e['event'] for e in events], err)
        self.assertEqual('printed', events[1]['state'], events[1])
        reports = [e for e in self.listeners['notify'].received if e['kind'] == 'N-EVENT-REPORT']
        self.assertEqual([0], [e['status'] for e in reports], 'the helper acknowledged the report')

    def test_a_closed_port_is_a_failure_before_anything_was_sent(self):
        body = self.request('done')
        body['peer']['port'] = free_port()
        events, _, _ = run(body)
        self.assertEqual(['final'], [e['event'] for e in events])
        self.assertEqual('failed', events[0]['state'])

    def test_a_malformed_request_is_refused_without_a_connection(self):
        events, _, _ = run(self.request('done', film={'columns': 9, 'rows': 1, 'filmSize': '14INX17IN', 'orientation': 'PORTRAIT', 'copies': 1}))
        self.assertEqual(('final', 'failed'), (events[0]['event'], events[0]['state']))
        self.assertEqual([], self.kinds('done'))

    def test_the_layout_image_goes_to_the_device_as_a_secondary_capture(self):
        listener = self.listeners['store']
        attributes = {'PatientName': 'SYN^가나다', 'PatientID': 'SYN-1', 'StudyInstanceUID': '1.2.826.0.1.3680043.8.498.501',
                      'AccessionNumber': 'SYNACC', 'SeriesInstanceUID': '1.2.826.0.1.3680043.8.498.502',
                      'SOPInstanceUID': '1.2.826.0.1.3680043.8.498.503', 'SeriesDescription': 'Print layout 2x2',
                      'Modality': 'OT', 'ConversionType': 'WSD', 'SeriesNumber': '9001', 'InstanceNumber': '1'}
        events, _, err = run({'action': 'store', 'callingAet': 'SYNKIN',
                              'peer': {'aet': listener.aet, 'host': '127.0.0.1', 'port': listener.port},
                              'timeouts': {'connect': 5, 'response': 5}, 'image': grey(10, 12, 77), 'attributes': attributes})
        self.assertEqual(['sent', 'final'], [e['event'] for e in events], err)
        self.assertEqual('stored', events[1]['state'])
        stored = listener.received[-1]
        self.assertEqual(('C-STORE', '1.2.840.10008.5.1.4.1.1.7', 'SYNKIN'), (stored['kind'], stored['sopClass'], stored['calling']))
        a = stored['attributes']
        for key, value in attributes.items():
            self.assertEqual(value, a[key], key)
        self.assertEqual(('12', '10', 'MONOCHROME2', '8'), (a['Rows'], a['Columns'], a['PhotometricInterpretation'], a['BitsAllocated']))
        self.assertEqual('ISO_IR 192', a['SpecificCharacterSet'], 'a Korean name reaches the device as written')
        self.assertEqual(120 * 77, a['PixelData']['sum'])

    def test_an_unknown_attribute_for_the_device_is_refused(self):
        listener = self.listeners['store']
        events, _, _ = run({'action': 'store', 'peer': {'aet': listener.aet, 'host': '127.0.0.1', 'port': listener.port},
                            'image': grey(2, 2, 1), 'attributes': {'SOPInstanceUID': '1.2.3', 'OperatorsName': 'X'}})
        self.assertEqual('failed', events[0]['state'])
        self.assertEqual([], listener.received)


if __name__ == '__main__':
    unittest.main(verbosity=2)
