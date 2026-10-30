'use strict';
/* MG-LOADING test fixture shared by dicom_frame_test.cjs and dicom_frame_delivery_test.cjs: one synthetic uncompressed
 * multi-frame object as Orthanc would store it (a pixel data element at a known offset), a stub Orthanc index that
 * describes it, and a response sink. Synthetic bytes only; no Docker. The loader maps /app/dist to api/src. */
require('./service_test_loader.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { PassThrough } = require('node:stream');
const { DicomFrameService } = require('/app/dist/dicom-frame.service.js');

const EXPLICIT = '1.2.840.10008.1.2.1', IMPLICIT = '1.2.840.10008.1.2';
const STUDY_UID = '1.2.3', SERIES_UID = '1.2.3.4', SOP_UID = '1.2.3.4.5';
const INSTANCE_ID = '3fc2d51f-e3bbd38a-db69114e-eef254ef-fcc4744b';
const STUDY_ID = '0a1b2c3d-4e5f6071-8293a4b5-c6d7e8f9-0a1b2c3d';

/** The index facts of a 16-bit MONOCHROME2 object, 4x3 pixels, 5 frames, pixel data at byte 1000 (explicit VR). */
const facts = (over = {}) => ({ transferSyntax: EXPLICIT, pixelDataOffset: 1000, rows: 4, columns: 3, bitsAllocated: 16,
  samplesPerPixel: 1, numberOfFrames: 5, planarConfiguration: null, photometric: 'MONOCHROME2', pixelRepresentation: 0,
  bitsStored: null, highBit: null, rescaleSlope: null, rescaleIntercept: null, modalityLutSequence: false,
  windowCenter: null, windowWidth: null, voiLutFunction: null, voiLutSequence: false, unsupportedTransforms: false,
  fileSize: 1000 + 12 + 4 * 3 * 2 * 5, storedSize: 1000 + 12 + 4 * 3 * 2 * 5, ...over });

/** Writes the stored file under `dir` the way Orthanc lays its storage out (uuid[0..2]/uuid[2..4]/uuid). */
function syntheticObject(dir, shape = {}) {
  const { rows = 4, columns = 3, random = false, tags: extraTags = {}, values = null } = shape;
  const frames = 5, frameBytes = rows * columns * 2, offset = 1000;
  const uuid = '9447e43e-7a12-4de9-af18-9ceb86847e05';
  const file = Buffer.alloc(offset + 12 + frameBytes * frames);
  Buffer.from([0xe0, 0x7f, 0x10, 0x00]).copy(file, offset); file.write('OW', offset + 4, 'latin1'); file.writeUInt32LE(frameBytes * frames, offset + 8);
  if (random) require('node:crypto').randomFillSync(file, offset + 12);   // incompressible: gzip emits many chunks
  else for (let f = 0; f < frames; f++) for (let i = 0; i < rows * columns; i++)
    file.writeUInt16LE(values ? values[i % values.length] : f * 1000 + i, offset + 12 + f * frameBytes + i * 2);
  const filePath = path.join(dir, uuid.slice(0, 2), uuid.slice(2, 4), uuid);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, file);
  // The index's simplified tags carry the object's PatientID, as Orthanc's do: the frame reader serves an object only
  // under a delivery of that patient.
  const tags = { StudyInstanceUID: STUDY_UID, SeriesInstanceUID: SERIES_UID, SOPInstanceUID: SOP_UID, PatientID: 'SYN-PID-1', Rows: String(rows), Columns: String(columns),
    BitsAllocated: '16', SamplesPerPixel: '1', NumberOfFrames: String(frames), PhotometricInterpretation: 'MONOCHROME2', PixelRepresentation: '0', ...extraTags };
  return { uuid, id: INSTANCE_ID, file, frameBytes, offset, tags, filePath,
    attachment: { Uuid: uuid, UncompressedSize: file.length, CompressedSize: file.length, ContentType: 1 } };
}

/** The Orthanc index as the frame reader and the delivery recorder consult it; every call is kept in `calls`. */
function stubOrthanc(object, over = {}) {
  const calls = [];
  return { calls,
    async lookupInstance(sop) { calls.push(['lookup', sop]); return sop === object.tags.SOPInstanceUID ? [{ Type: 'Instance', ID: object.id }] : []; },
    async frameFacts(id) { calls.push(['facts', id]); return { tags: object.tags, attachment: object.attachment, transferSyntax: EXPLICIT, pixelDataOffset: String(object.offset), ...over }; },
    async relay(path, accept, target) { calls.push(['relay', path, accept]); target.status(200); target.setHeader('content-type', 'relayed'); target.write(Buffer.from('relayed')); target.end(); },
    async instanceStudyUid(id) { calls.push(['instance-study', id]); if (id !== object.id) throw new Error('unknown instance'); return object.tags.StudyInstanceUID; },
    async studyRevision(uid) { calls.push(['revision', uid]); return { id: STUDY_ID, lastUpdate: '20261028T090000' }; },
    async studyIdentityResources(uid) {
      calls.push(['identity', uid]);
      return uid === object.tags.StudyInstanceUID ? [{ '0020000D': { vr: 'UI', Value: [uid] }, '00100020': { vr: 'LO', Value: ['SYN-PID-1'] }, '00080080': { vr: 'LO', Value: ['SYN HOSPITAL A'] } }] : [];
    },
    // The current clinical context reads the study's one patient through the archive reader's rule
    // (OrthancService.studyPatientIdentity, #244: no resource is no study, two patient resources is a split UID).
    async studyPatientIdentity(uid) {
      const resources = await this.studyIdentityResources(uid);
      if (resources.length !== 1) { const error = new Error(resources.length ? 'STUDY_IDENTITY_UNRESOLVED' : '검사가 없습니다.'); error.status = resources.length ? 409 : 404; throw error; }
      return resources[0]['00100020'].Value[0];
    },
  };
}

/** A Writable like Express's response: the service pipes into it and sets status/headers on it. */
function target() {
  const sink = new PassThrough(), chunks = [], headers = {}; let status = 0;
  sink.on('data', c => chunks.push(c));
  const done = new Promise(resolve => { sink.on('end', resolve); sink.on('close', resolve); });
  sink.status = c => { status = c; };
  sink.setHeader = (k, v) => { headers[k.toLowerCase()] = v; };
  sink.result = async () => { await done; return { status, headers, body: Buffer.concat(chunks) }; };
  return sink;
}

const request = over => ({ studyUid: STUDY_UID, seriesUid: SERIES_UID, sopUid: SOP_UID, frames: [2],
  accept: 'multipart/related; type=application/octet-stream; transfer-syntax=*', acceptEncoding: undefined, head: false, origin: 'https://pacs.example', ...over });

/** A service over a fresh storage directory holding one synthetic object; the directory is removed afterwards. */
async function withService(fn, over, shape) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-frames-'));
  const previous = process.env.KIN_ORTHANC_STORAGE;
  process.env.KIN_ORTHANC_STORAGE = dir;
  try {
    const object = syntheticObject(dir, shape), orthanc = stubOrthanc(object, over);
    await fn(new DicomFrameService(orthanc), object, orthanc);
  } finally {
    if (previous === undefined) delete process.env.KIN_ORTHANC_STORAGE; else process.env.KIN_ORTHANC_STORAGE = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The grey values of a PNG's rows, filter bytes dropped. */
function pngGreys(png) {
  const width = png.readUInt32BE(16), idat = png.indexOf('IDAT', 0, 'latin1'), length = png.readUInt32BE(idat - 4);
  return [...zlib.inflateSync(png.subarray(idat + 4, idat + 4 + length))].filter((_, i) => i % (width + 1) !== 0);
}

module.exports = { EXPLICIT, IMPLICIT, STUDY_UID, SERIES_UID, SOP_UID, INSTANCE_ID, STUDY_ID, facts, syntheticObject, stubOrthanc, target, request, withService, pngGreys };
