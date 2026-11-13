"""Film / DICOM Print helper: one film to a DICOM film printer (Basic Grayscale Print Management SCU), or one print
layout image to a DICOM device (Secondary Capture C-STORE).

The API server (film-print.service.ts) starts one process per job, writes one JSON request to stdin and reads JSON
lines from stdout. Everything about what is printed (the cells, their pixels, the window, the size) is decided by the
API; this process only speaks DICOM and reports what the other side answered:

  {"event": "sent", ...}    the printer took the film (N-ACTION success with a Print Job UID), or the C-STORE request
                            went out to the device
  {"event": "final", "state": "printed" | "no-answer" | "sent-unreported" | "failed" | "stored", ...}

`printed` only when the printer reported its Print Job DONE; no answer within the time given is `no-answer` (the
result is unknown), never a guess. A warning status is kept and reported with the result. Exactly one final line.

Request (stdin):
  {"action": "print", "callingAet", "peer": {"aet", "host", "port"},
   "timeouts": {"connect", "response", "completion", "poll"},
   "film": {"columns", "rows", "filmSize", "orientation", "copies"},
   "boxes": [{"position", "width", "height", "pixels": base64 of width*height 8-bit grey values}]}
  {"action": "store", "callingAet", "peer", "timeouts",
   "image": {"width", "height", "pixels"}, "attributes": {DICOM keyword: value}}
"""
import base64
import json
import sys
import threading
import time

from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.sequence import Sequence
from pydicom.uid import ExplicitVRLittleEndian, ImplicitVRLittleEndian, PYDICOM_IMPLEMENTATION_UID, generate_uid
from pynetdicom import AE, evt
from pynetdicom.sop_class import (BasicFilmBox, BasicFilmSession, BasicGrayscaleImageBox,
                                  BasicGrayscalePrintManagementMeta, PrintJob, SecondaryCaptureImageStorage)

FILM_SIZES = ('8INX10IN', '10INX12IN', '11INX14IN', '14INX17IN')
ORIENTATIONS = ('PORTRAIT', 'LANDSCAPE')
# The keywords the API may set on the layout image (the original study's identity and the new object's own values).
STORE_KEYWORDS = ('PatientName', 'PatientID', 'PatientBirthDate', 'PatientSex', 'StudyInstanceUID', 'StudyDate',
                  'StudyTime', 'StudyID', 'AccessionNumber', 'ReferringPhysicianName', 'StudyDescription',
                  'SeriesInstanceUID', 'SOPInstanceUID', 'SeriesNumber', 'InstanceNumber', 'SeriesDescription',
                  'Modality', 'ConversionType', 'ContentDate', 'ContentTime', 'SeriesDate', 'SeriesTime')
# Print warning statuses (PS3.4 H.4) in the words the status line shows.
WARNINGS = {
    0xB600: 'memory allocation not supported',
    0xB601: 'film session printing (collation) not supported',
    0xB602: 'the film session holds no film box',
    0xB603: 'the film box holds no image box (empty page)',
    0xB604: 'image larger than its box - it was made smaller',
    0xB605: 'requested density outside the printer range',
    0xB609: 'image larger than its box - it was cropped',
    0xB60A: 'image larger than its box - it was decimated',
    0x0107: 'attribute list error',
    0x0116: 'attribute value out of range',
}


STAGE = {'requested': False}   # set once the print or store request may have reached the other side


def emit(**event):
    sys.stdout.write(json.dumps(event) + '\n')
    sys.stdout.flush()


def status_of(status):
    """`(code, category)` of a DIMSE response status; `(None, 'none')` when no response came."""
    if status is None or 'Status' not in status:
        return None, 'none'
    code = int(status.Status)
    if code == 0x0000:
        return code, 'success'
    if code in WARNINGS or code == 0x0001 or 0xB000 <= code <= 0xBFFF:
        return code, 'warning'
    if code in (0xFF00, 0xFF01):
        return code, 'pending'
    return code, 'failure'


def warning_text(code):
    return f'0x{code:04X} {WARNINGS.get(code, "warning")}'


def grey_pixels(box):
    width, height = int(box['width']), int(box['height'])
    pixels = base64.b64decode(box['pixels'])
    if width < 1 or height < 1 or len(pixels) != width * height:
        raise ValueError('pixels do not match the size')
    if len(pixels) % 2:
        pixels += b'\x00'
    return width, height, pixels


def image_module(ds, width, height, pixels):
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = 'MONOCHROME2'
    ds.Rows = height
    ds.Columns = width
    ds.BitsAllocated = 8
    ds.BitsStored = 8
    ds.HighBit = 7
    ds.PixelRepresentation = 0
    ds.PixelData = pixels


def application_entity(request):
    timeouts = request.get('timeouts') or {}
    ae = AE(ae_title=str(request.get('callingAet') or 'KIN'))
    ae.connection_timeout = float(timeouts.get('connect', 10))
    ae.acse_timeout = float(timeouts.get('connect', 10))
    ae.dimse_timeout = float(timeouts.get('response', 30))
    ae.network_timeout = float(timeouts.get('response', 30))
    return ae, timeouts


def associate(ae, request, handlers):
    peer = request['peer']
    return ae.associate(str(peer['host']), int(peer['port']), ae_title=str(peer['aet']), evt_handlers=handlers)


def not_connected(assoc):
    if assoc.is_rejected:
        return 'the printer refused the connection' if assoc.acse else 'the connection was refused'
    return 'could not connect'


# ── print ──

def print_film(request):
    film = request['film']
    columns, rows = int(film['columns']), int(film['rows'])
    if not (1 <= columns <= 8 and 1 <= rows <= 8):
        raise ValueError('format')
    if film['filmSize'] not in FILM_SIZES or film['orientation'] not in ORIENTATIONS:
        raise ValueError('film')
    copies = int(film['copies'])
    if not 1 <= copies <= 99:
        raise ValueError('copies')
    boxes = {int(b['position']): grey_pixels(b) for b in request.get('boxes') or []}
    if any(not 1 <= position <= columns * rows for position in boxes):
        raise ValueError('position')

    ae, timeouts = application_entity(request)
    ae.add_requested_context(BasicGrayscalePrintManagementMeta)
    ae.add_requested_context(PrintJob)
    reported = {}
    lock = threading.Lock()

    def on_event_report(event):
        # A printer that tells the Print Job's state on its own (N-EVENT-REPORT) is heard as well as asked.
        with lock:
            reported['type'] = event.request.EventTypeID
        return 0x0000, None

    assoc = associate(ae, request, [(evt.EVT_N_EVENT_REPORT, on_event_report)])
    if not assoc.is_established:
        return emit(event='final', state='failed', reason=not_connected(assoc))
    warnings = []
    try:
        meta = BasicGrayscalePrintManagementMeta
        accepted = {cx.abstract_syntax for cx in assoc.accepted_contexts}
        if meta not in accepted:
            return emit(event='final', state='failed', reason='the printer does not accept grayscale print')

        def check(status, what):
            code, kind = status_of(status)
            if kind == 'none':
                return 'none'
            if kind == 'warning':
                warnings.append(warning_text(code))
            if kind in ('success', 'warning'):
                return 'ok'
            emit(event='final', state='failed', reason=f'{what} refused (0x{code:04X})', warnings=warnings)
            return 'failed'

        session = Dataset()
        session.NumberOfCopies = copies
        session_uid = generate_uid()
        status, _ = assoc.send_n_create(session, BasicFilmSession, session_uid, meta_uid=meta)
        outcome = check(status, 'film session')
        if outcome == 'none':
            return emit(event='final', state='failed', reason='the printer did not answer the film session')
        if outcome == 'failed':
            return

        box = Dataset()
        box.ImageDisplayFormat = f'STANDARD\\{columns},{rows}'
        box.FilmOrientation = film['orientation']
        box.FilmSizeID = film['filmSize']
        reference = Dataset()
        reference.ReferencedSOPClassUID = BasicFilmSession
        reference.ReferencedSOPInstanceUID = session_uid
        box.ReferencedFilmSessionSequence = Sequence([reference])
        film_box_uid = generate_uid()
        status, film_box = assoc.send_n_create(box, BasicFilmBox, film_box_uid, meta_uid=meta)
        outcome = check(status, 'film box')
        if outcome == 'none':
            return emit(event='final', state='failed', reason='the printer did not answer the film box')
        if outcome == 'failed':
            return
        image_boxes = list(getattr(film_box, 'ReferencedImageBoxSequence', []) or []) if film_box is not None else []
        if len(image_boxes) != columns * rows:
            return emit(event='final', state='failed', reason='the printer did not give one image box per cell', warnings=warnings)

        for position, (width, height, pixels) in sorted(boxes.items()):
            item = Dataset()
            item.ImageBoxPosition = position
            image = Dataset()
            image_module(image, width, height, pixels)
            image.PixelAspectRatio = [1, 1]
            item.BasicGrayscaleImageSequence = Sequence([image])
            target = image_boxes[position - 1]
            status, _ = assoc.send_n_set(item, BasicGrayscaleImageBox, target.ReferencedSOPInstanceUID, meta_uid=meta)
            outcome = check(status, f'image {position}')
            if outcome == 'none':
                return emit(event='final', state='failed', reason=f'the printer did not answer image {position}')
            if outcome == 'failed':
                return

        # The print request. No answer here leaves the result unknown: the film may or may not come out.
        STAGE['requested'] = True
        status, action = assoc.send_n_action(None, 1, BasicFilmBox, film_box_uid, meta_uid=meta)
        outcome = check(status, 'print')
        if outcome == 'none':
            return emit(event='final', state='no-answer', reason='no answer to the print request', warnings=warnings)
        if outcome == 'failed':
            return
        job = None
        for item in (getattr(action, 'ReferencedPrintJobSequence', []) or []) if action is not None else []:
            job = getattr(item, 'ReferencedSOPInstanceUID', None) or job
        if not job or PrintJob not in accepted:
            emit(event='sent', printJobUid=job, warnings=warnings)
            return emit(event='final', state='sent-unreported', warnings=warnings)
        emit(event='sent', printJobUid=job, warnings=warnings)

        # Asked until the printer says DONE or FAILURE; a printer that stays silent or pending is no answer.
        deadline = time.monotonic() + float(timeouts.get('completion', 30))
        poll = float(timeouts.get('poll', 2))
        while time.monotonic() < deadline:
            if not assoc.is_established:
                break
            assoc.dimse_timeout = max(1.0, deadline - time.monotonic())
            status, attrs = assoc.send_n_get([0x21000020, 0x21000030], PrintJob, job)
            code, kind = status_of(status)
            if kind == 'none':
                break
            if kind == 'failure':
                return emit(event='final', state='failed', reason=f'print job status refused (0x{code:04X})', warnings=warnings)
            if kind == 'warning':
                warnings.append(warning_text(code))
            state = str(getattr(attrs, 'ExecutionStatus', '') or '').strip().upper() if attrs is not None else ''
            info = str(getattr(attrs, 'ExecutionStatusInfo', '') or '').strip() if attrs is not None else ''
            if state == 'DONE':
                return emit(event='final', state='printed', info=info or None, warnings=warnings)
            if state == 'FAILURE':
                return emit(event='final', state='failed', reason=info or 'the printer reported a failure', warnings=warnings)
            if info and info.upper() != 'NORMAL' and f'printer: {info}' not in warnings:
                warnings.append(f'printer: {info}')
            time.sleep(min(poll, max(0.0, deadline - time.monotonic())))
        return emit(event='final', state='no-answer', reason='the printer did not report completion', warnings=warnings)
    finally:
        if assoc.is_established:
            try:
                assoc.release()
            except Exception:
                assoc.abort()


# ── store ──

def store_layout(request):
    width, height, pixels = grey_pixels(request['image'])
    attributes = request.get('attributes') or {}
    ds = Dataset()
    for keyword, value in attributes.items():
        if keyword not in STORE_KEYWORDS:
            raise ValueError(f'attribute {keyword}')
        setattr(ds, keyword, value)
    ds.SOPClassUID = SecondaryCaptureImageStorage
    image_module(ds, width, height, pixels)
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = SecondaryCaptureImageStorage
    meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
    meta.TransferSyntaxUID = ImplicitVRLittleEndian
    meta.ImplementationClassUID = PYDICOM_IMPLEMENTATION_UID
    ds.file_meta = meta
    ds.is_little_endian = True
    ds.is_implicit_VR = True

    ae, _ = application_entity(request)
    ae.add_requested_context(SecondaryCaptureImageStorage, [ImplicitVRLittleEndian, ExplicitVRLittleEndian])
    told = []

    def on_sent(event):
        # The C-STORE request has gone out to the device: "Sent". Its answer decides "Stored on the device".
        if not told and type(event.message).__name__ == 'C_STORE_RQ':
            told.append(True)
            emit(event='sent')

    assoc = associate(ae, request, [(evt.EVT_DIMSE_SENT, on_sent)])
    if not assoc.is_established:
        return emit(event='final', state='failed', reason=not_connected(assoc).replace('printer', 'device'))
    try:
        if SecondaryCaptureImageStorage not in {cx.abstract_syntax for cx in assoc.accepted_contexts}:
            return emit(event='final', state='failed', reason='the device does not accept secondary capture images')
        STAGE['requested'] = True
        status = assoc.send_c_store(ds)
        code, kind = status_of(status)
        if kind == 'none':
            return emit(event='final', state='no-answer', reason='the device did not answer')
        if kind == 'failure':
            return emit(event='final', state='failed', reason=f'the device refused the image (0x{code:04X})')
        return emit(event='final', state='stored', warnings=[f'0x{code:04X} warning'] if kind == 'warning' else [])
    finally:
        if assoc.is_established:
            try:
                assoc.release()
            except Exception:
                assoc.abort()


def main():
    try:
        request = json.loads(sys.stdin.read())
        action = request.get('action')
        if action not in ('print', 'store'):
            raise ValueError('action')
    except Exception as error:  # a malformed request is the API's fault: nothing was sent anywhere
        return emit(event='final', state='failed', reason=f'invalid request ({type(error).__name__})')
    try:
        (print_film if action == 'print' else store_layout)(request)
    except ValueError as error:
        emit(event='final', state='failed', reason=f'invalid request ({error})')
    except Exception as error:
        # After the request may have reached the other side, a broken connection leaves the result unknown.
        if STAGE['requested']:
            emit(event='final', state='no-answer', reason=f'the connection broke ({type(error).__name__})')
        else:
            emit(event='final', state='failed', reason=f'the connection broke ({type(error).__name__})')


if __name__ == '__main__':
    main()
