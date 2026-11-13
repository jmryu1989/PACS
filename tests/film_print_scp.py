"""Synthetic DICOM film printers and a synthetic DICOM device, for tests only (never for a deployment).

Each listener is `AET:PORT:MODE`:
  done       a film printer that answers every step and reports its Print Job DONE
  silent     takes the film (N-ACTION success with a Print Job UID) and never answers the completion inquiry
  no-action  never answers the print request (N-ACTION)
  no-job     takes the film without the Print Job SOP Class: it cannot report completion
  warn       takes the film with warning 0xB604 (image made smaller) and reports DONE
  fail       takes the film and reports its Print Job FAILURE (SUPPLY EMPTY)
  store      a DICOM device that stores what it receives (C-STORE)

What each listener received is kept in `received` (in process) and, with --log-dir, written one JSON line per request
to <log-dir>/<AET>.jsonl (pixel values are reduced to their size and a few sample values).

  python tests/film_print_scp.py --bind 0.0.0.0 --log-dir DIR PRINTA:11112:done PRINTB:11113:silent DEVICE:11114:store
"""
import argparse
import json
import os
import threading
import time

from pydicom.dataset import Dataset
from pydicom.sequence import Sequence
from pydicom.uid import generate_uid
from pynetdicom import AE, evt
from pynetdicom.sop_class import (BasicFilmBox, BasicFilmSession, BasicGrayscaleImageBox,
                                  BasicGrayscalePrintManagementMeta, PrintJob, SecondaryCaptureImageStorage, Verification)

MODES = ('done', 'silent', 'no-action', 'no-job', 'warn', 'fail', 'store')
STOP = threading.Event()


def summary(ds):
    """A JSON-friendly copy of a dataset: values as text, sequences as lists, pixel data as size and samples."""
    out = {}
    if ds is None:
        return out
    for element in ds:
        if element.keyword == 'PixelData':
            data = bytes(element.value)
            out['PixelData'] = {'length': len(data), 'first': list(data[:4]), 'sum': sum(data)}
        elif element.VR == 'SQ':
            out[element.keyword] = [summary(item) for item in element.value]
        elif element.keyword:
            value = element.value
            out[element.keyword] = [str(v) for v in value] if isinstance(value, (list, tuple)) or type(value).__name__ == 'MultiValue' else str(value)
    return out


class Listener:
    def __init__(self, aet, port, mode, bind='127.0.0.1', log_dir=None):
        if mode not in MODES:
            raise ValueError(mode)
        self.aet, self.port, self.mode, self.log_dir = aet, int(port), mode, log_dir
        self.received = []
        self.boxes = {}
        self.lock = threading.Lock()
        ae = AE(ae_title=aet)
        ae.add_supported_context(Verification)
        if mode == 'store':
            ae.add_supported_context(SecondaryCaptureImageStorage)
        else:
            ae.add_supported_context(BasicGrayscalePrintManagementMeta)
            if mode != 'no-job':
                ae.add_supported_context(PrintJob)
        handlers = [(evt.EVT_N_CREATE, self.n_create), (evt.EVT_N_SET, self.n_set), (evt.EVT_N_ACTION, self.n_action),
                    (evt.EVT_N_GET, self.n_get), (evt.EVT_N_DELETE, self.n_delete), (evt.EVT_C_STORE, self.c_store)]
        self.server = ae.start_server((bind, self.port), block=False, evt_handlers=handlers)

    def record(self, kind, **fields):
        entry = {'kind': kind, 'at': time.time(), **fields}
        with self.lock:
            self.received.append(entry)
            if self.log_dir:
                with open(os.path.join(self.log_dir, f'{self.aet}.jsonl'), 'a', encoding='utf-8') as out:
                    out.write(json.dumps(entry) + '\n')

    def n_create(self, event):
        cls, uid = str(event.request.AffectedSOPClassUID), str(event.request.AffectedSOPInstanceUID or generate_uid())
        attrs = event.attribute_list
        self.record('N-CREATE', sopClass=cls, uid=uid, attributes=summary(attrs))
        reply = Dataset()
        if cls == BasicFilmBox:
            fmt = str(attrs.ImageDisplayFormat)
            columns, rows = (int(v) for v in fmt.split('\\')[1].split(','))
            items = []
            for _ in range(columns * rows):
                item = Dataset()
                item.ReferencedSOPClassUID = BasicGrayscaleImageBox
                item.ReferencedSOPInstanceUID = generate_uid()
                items.append(item)
            reply.ReferencedImageBoxSequence = Sequence(items)
            self.boxes[uid] = [i.ReferencedSOPInstanceUID for i in items]
        return 0x0000, reply

    def n_set(self, event):
        self.record('N-SET', sopClass=str(event.request.RequestedSOPClassUID), uid=str(event.request.RequestedSOPInstanceUID),
                    attributes=summary(event.modification_list))
        return 0x0000, Dataset()

    def n_action(self, event):
        self.record('N-ACTION', sopClass=str(event.request.RequestedSOPClassUID), uid=str(event.request.RequestedSOPInstanceUID),
                    action=int(event.action_type))
        if self.mode == 'no-action':
            STOP.wait(600)
            return 0x0000, None
        reply = Dataset()
        if self.mode != 'no-job':
            job = Dataset()
            job.ReferencedSOPClassUID = PrintJob
            job.ReferencedSOPInstanceUID = generate_uid()
            reply.ReferencedPrintJobSequence = Sequence([job])
        return (0xB604 if self.mode == 'warn' else 0x0000), reply

    def n_get(self, event):
        self.record('N-GET', sopClass=str(event.request.RequestedSOPClassUID), uid=str(event.request.RequestedSOPInstanceUID))
        if self.mode == 'silent':
            STOP.wait(600)
            return 0x0000, None
        reply = Dataset()
        reply.ExecutionStatus = 'FAILURE' if self.mode == 'fail' else 'DONE'
        reply.ExecutionStatusInfo = 'SUPPLY EMPTY' if self.mode == 'fail' else 'NORMAL'
        return 0x0000, reply

    def n_delete(self, event):
        self.record('N-DELETE', sopClass=str(event.request.RequestedSOPClassUID), uid=str(event.request.RequestedSOPInstanceUID))
        return 0x0000

    def c_store(self, event):
        ds = event.dataset
        self.record('C-STORE', sopClass=str(event.request.AffectedSOPClassUID), uid=str(event.request.AffectedSOPInstanceUID),
                    calling=str(event.assoc.requestor.ae_title).strip(), attributes=summary(ds))
        return 0x0000

    def shutdown(self):
        self.server.shutdown()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--bind', default='127.0.0.1')
    parser.add_argument('--log-dir')
    parser.add_argument('listeners', nargs='+')
    args = parser.parse_args()
    if args.log_dir:
        os.makedirs(args.log_dir, exist_ok=True)
    started = []
    for spec in args.listeners:
        aet, port, mode = spec.split(':')
        started.append(Listener(aet, port, mode, args.bind, args.log_dir))
        print(f'listening {aet} {args.bind}:{port} {mode}', flush=True)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass
    finally:
        STOP.set()
        for listener in started:
            listener.shutdown()


if __name__ == '__main__':
    main()
