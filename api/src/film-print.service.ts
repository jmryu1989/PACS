/*
 * Film / DICOM Print: a radiologist or technician prints one film of a series of a study their worklist opens to a film
 * printer registered for their institution (DICOM Basic Grayscale Print Management), or sends the same film as one
 * layout image (Secondary Capture) to a DICOM device registered for their institution. The layout image goes straight
 * to the device: it is never stored in this archive.
 *
 * A job is one film. Its row (FilmPrintJob) is written before anything is sent and keeps who printed what, where and
 * the result - the output record. The result is only what the other side answered: Sent when the printer took the film
 * (or the request went out to the device), Printed when the printer reported the Print Job DONE, Stored on the device
 * when the device stored it, No answer when the answer did not come in time (the result is unknown). A job this
 * process did not see end (the server restarted) is left as No answer and is never sent again. A repeated request with
 * the same request id answers the same job and prints nothing again.
 *
 * The DICOM side is the helper process api/print/film_print.py (pydicom + pynetdicom), one per job.
 */
import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnApplicationBootstrap } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { PrismaService } from './prisma.service';
import { OrthancService } from './orthanc.service';
import { PacsService } from './pacs.service';
import { inst } from './pacs/access';
import type { Caller } from './pacs/access';
import { dump } from './pacs/values';
import { FILM_MESSAGES, FINAL_STATES, RESTART_REASON, composeFilm, fingerprint, framesOf, headerWindow, isUuid, jobRequest,
  jobView, layoutRequest, pamToGrey, planFilm, printableSeries, renderQuery, uuidUid } from './film-print';
import type { Cell, Frame, JobRequest, Layout, SeriesInfo } from './film-print';

const OPEN = ['sending', 'sent'];
/** The film sizes a printer registered without a list takes. */
const ALL_SIZES = '8INX10IN,10INX12IN,11INX14IN,14INX17IN';

function member(c: Caller) {
  if (c.kind !== 'member' || !['radiologist', 'technician', 'admin'].some(role => c.roles?.includes(role)))
    throw new ForbiddenException('필름 인쇄는 radiologist 또는 technician 권한이 필요합니다');
}

const seconds = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

type Study = NonNullable<Awaited<ReturnType<OrthancService['filmStudy']>>>;
type Peer = { id: string; name: string; aet: string; host: string; port: number; kind: string; filmSizes: string };

@Injectable()
export class FilmPrintService implements OnApplicationBootstrap {
  private readonly log = new Logger('FilmPrint');
  /** Jobs whose helper runs in this process now. */
  private readonly running = new Set<string>();

  constructor(private readonly prisma: PrismaService, private readonly orthanc: OrthancService, private readonly pacs: PacsService) {}

  async onApplicationBootstrap() {
    await this.settleUnknown();
  }

  /** Jobs an earlier process left open can no longer hear their answer: No answer, never sent again. */
  async settleUnknown() {
    try {
      const open = await this.prisma.filmPrintJob.findMany({ where: { state: { in: OPEN } }, select: { id: true, events: true } });
      for (const row of open) {
        if (this.running.has(row.id)) continue;
        const events = [...(Array.isArray(row.events) ? row.events as any[] : []), { state: 'no-answer', at: new Date().toISOString() }];
        await this.prisma.filmPrintJob.updateMany({ where: { id: row.id, state: { in: OPEN } },
          data: { state: 'no-answer', reason: RESTART_REASON, events, endedAt: new Date() } });
      }
    } catch (error: any) {
      this.log.warn(`open film print jobs were not settled: ${error?.message ?? error}`);
    }
  }

  // ── what the window shows ──

  /** The institution's film printers (with the film sizes each was registered for) and DICOM devices. */
  async destinations(c: Caller) {
    member(c);
    const me = inst(c);
    const peers: Peer[] = await this.prisma.dicomPeer.findMany({ where: { institutionId: me },
      orderBy: [{ name: 'asc' }, { aet: 'asc' }] });
    return {
      printers: peers.filter(p => p.kind === 'printer').map(p => ({ id: p.id, name: p.name, aet: p.aet, filmSizes: (p.filmSizes || ALL_SIZES).split(',') })),
      devices: peers.filter(p => (p.kind ?? 'store') === 'store').map(p => ({ id: p.id, name: p.name, aet: p.aet })),
    };
  }

  /** The study's printable series and the cells of one film of the chosen series (default: the first), as printed. */
  async layout(body: any, c: Caller) {
    member(c);
    const r = layoutRequest(body);
    const { series, chosen } = await this.series(c, r.studyUid, r.seriesUid);
    const frames = framesOf(await this.orthanc.filmInstances(chosen.id));
    const plan = await this.plan(frames, r, r.film);
    return { studyUid: r.studyUid, seriesUid: chosen.uid, film: r.film, films: plan.films,
      series: series.map(s => ({ uid: s.uid, number: s.number, description: s.description, modality: s.modality, images: s.instances.length })),
      cells: plan.cells.map(cell => ({ ...cell, src: `/instances/${cell.instance}/frames/${cell.frame - 1}/rendered?${renderQuery(cell)}` })) };
  }

  // ── a print ──

  async create(body: any, c: Caller) {
    member(c);
    const me = inst(c);
    const r = jobRequest(body);
    const known = await this.prisma.filmPrintJob.findUnique({ where: { createdBySub_requestId: { createdBySub: c.sub, requestId: r.requestId } } });
    if (known) return this.repeated(known, r, me);
    const peer: Peer | null = await this.prisma.dicomPeer.findFirst({ where: { id: r.destination.peerId, institutionId: me,
      kind: r.destination.kind === 'printer' ? 'printer' : 'store' } });
    if (!peer) throw new NotFoundException(FILM_MESSAGES.peerNotFound);
    if (r.destination.kind === 'printer' && !(peer.filmSizes || ALL_SIZES).split(',').includes(r.filmSize))
      throw new BadRequestException(FILM_MESSAGES.filmSize(peer.name, r.filmSize));
    const { study, chosen } = await this.series(c, r.studyUid, r.seriesUid);
    if (chosen.uid !== r.seriesUid) throw new NotFoundException(FILM_MESSAGES.seriesNotFound);
    const plan = await this.plan(framesOf(await this.orthanc.filmInstances(chosen.id)), r, r.film);
    const output = r.destination.kind === 'device' ? { seriesUid: uuidUid(randomUUID()), sopUid: uuidUid(randomUUID()) } : null;
    const at = new Date().toISOString();
    const layout = { format: `${r.columns}x${r.rows}`, columns: r.columns, rows: r.rows, filmSize: r.filmSize, orientation: r.orientation,
      copies: r.copies, film: r.film, films: plan.films, fingerprint: fingerprint(r), cells: plan.cells };
    let row: any;
    try {
      row = await this.prisma.$transaction(async tx => {
        const created = await tx.filmPrintJob.create({ data: { institutionId: me, requestId: r.requestId, createdBySub: c.sub,
          createdBy: c.actor || 'unknown', studyUid: r.studyUid, seriesUid: r.seriesUid, destination: r.destination.kind,
          peerId: peer.id, peerName: peer.name, peerAet: peer.aet, layout, state: 'sending', events: [{ state: 'sending', at }],
          warnings: [], outputSeriesUid: output?.seriesUid ?? null, outputSopUid: output?.sopUid ?? null } });
        // The output record names the study, the destination and the film - never a patient value.
        await tx.auditLog.create({ data: { actor: c.actor || 'unknown', action: 'film-print.job', target: r.studyUid,
          detail: dump({ institution: me, job: created.id, destination: r.destination.kind, peer: peer.id, series: r.seriesUid,
            film: r.film, films: plan.films, cells: plan.cells.length, ...(output ? { outputSeries: output.seriesUid } : {}) }) } });
        return created;
      }, { maxWait: 4000, timeout: 8000 });
    } catch (error: any) {
      if (error?.code !== 'P2002') throw error;
      const raced = await this.prisma.filmPrintJob.findUnique({ where: { createdBySub_requestId: { createdBySub: c.sub, requestId: r.requestId } } });
      if (!raced) throw error;
      return this.repeated(raced, r, me);
    }
    this.start(row, peer, study, plan.cells, r, output);
    return { job: jobView(row) };
  }

  /** The caller's own job of their institution; another member's or institution's is 404. */
  async job(id: string, c: Caller) {
    member(c);
    const me = inst(c);
    const row = isUuid(id) ? await this.prisma.filmPrintJob.findFirst({ where: { id, institutionId: me, createdBySub: c.sub } }) : null;
    if (!row) throw new NotFoundException(FILM_MESSAGES.jobNotFound);
    return { job: jobView(row) };
  }

  private repeated(row: any, r: JobRequest, me: string) {
    if (row.institutionId !== me || row.layout?.fingerprint !== fingerprint(r)) throw new ConflictException(FILM_MESSAGES.requestReused);
    return { job: jobView(row) };
  }

  // ── shared ──

  /** The study (the caller's worklist must open it), its printable series and the chosen one. */
  private async series(c: Caller, studyUid: string, seriesUid: string | null): Promise<{ study: Study; series: SeriesInfo[]; chosen: SeriesInfo }> {
    const listed: any = await this.pacs.listStudies(c, { uids: studyUid });
    if (!(listed?.studies ?? []).some((row: any) => row?.uid === studyUid)) throw new NotFoundException(FILM_MESSAGES.studyNotFound);
    const study = await this.orthanc.filmStudy(studyUid);
    if (!study) throw new NotFoundException(FILM_MESSAGES.studyNotFound);
    // Attached documents are their own series; they are not printed (a withdrawn one is not served at all).
    const attached = await this.prisma.studyAttachment.findMany({ where: { uid: studyUid }, select: { seriesInstanceUid: true } });
    const series = printableSeries(study.series, new Set(attached.map(a => a.seriesInstanceUid)));
    if (!series.length) throw new BadRequestException(FILM_MESSAGES.noImages);
    const chosen = seriesUid ? series.find(s => s.uid === seriesUid) : series[0];
    if (!chosen) throw new NotFoundException(FILM_MESSAGES.seriesNotFound);
    return { study, series, chosen };
  }

  /** The film's cells with each image's header window read once. */
  private async plan(frames: Frame[], layout: Layout, film: number) {
    const first = planFilm(frames, layout, film, new Map());
    const windows = new Map<string, { center: number; width: number } | null>();
    await Promise.all([...new Set(first.cells.map(cell => cell.instance))].map(async id => {
      windows.set(id, headerWindow(await this.orthanc.filmWindow(id)));
    }));
    return planFilm(frames, layout, film, windows);
  }

  private start(row: any, peer: Peer, study: Study, cells: Cell[], r: JobRequest, output: { seriesUid: string; sopUid: string } | null) {
    this.running.add(row.id);
    const events = [...(row.events as any[])];
    void this.run(row.id, events, peer, study, cells, r, output)
      .catch(error => this.finish(row.id, events, { state: 'failed', reason: 'the print could not be started' }, error))
      .finally(() => this.running.delete(row.id));
  }

  private async run(id: string, events: any[], peer: Peer, study: Study, cells: Cell[], r: JobRequest, output: { seriesUid: string; sopUid: string } | null) {
    let images: { position: number; width: number; height: number; pixels: Buffer }[];
    try {
      images = await Promise.all(cells.map(async cell =>
        ({ position: cell.position, ...pamToGrey(await this.orthanc.filmFrame(cell.instance, cell.frame - 1, renderQuery(cell))) })));
    } catch (error) {
      return this.finish(id, events, { state: 'failed', reason: 'the images could not be read from the archive' }, error);
    }
    const callingAet = await this.orthanc.ownAet();
    const timeouts = { connect: seconds('KIN_FILM_PRINT_CONNECT_SECONDS', 10), response: seconds('KIN_FILM_PRINT_RESPONSE_SECONDS', 30),
      completion: seconds('KIN_FILM_PRINT_COMPLETION_SECONDS', 30), poll: 2 };
    const target = { aet: peer.aet, host: peer.host, port: peer.port };
    const request = r.destination.kind === 'printer'
      ? { action: 'print', callingAet, peer: target, timeouts,
          film: { columns: r.columns, rows: r.rows, filmSize: r.filmSize, orientation: r.orientation, copies: r.copies },
          boxes: images.map(i => ({ position: i.position, width: i.width, height: i.height, pixels: i.pixels.toString('base64') })) }
      : { action: 'store', callingAet, peer: target, timeouts, attributes: layoutAttributes(study, r, output!),
          image: (({ width, height, pixels }) => ({ width, height, pixels: pixels.toString('base64') }))(composeFilm(r, images)) };
    const limit = (timeouts.connect + timeouts.response * (images.length + 4) + timeouts.completion + 30) * 1000;
    await this.helper(id, events, request, limit);
  }

  /** One helper process: its `sent` line moves the job to Sent, its `final` line ends it. No final line = no answer. */
  private helper(id: string, events: any[], request: object, limitMs: number): Promise<void> {
    return new Promise(resolve => {
      const python = process.env.KIN_FILM_PRINT_PYTHON || '/opt/kin-print/bin/python';
      const script = process.env.KIN_FILM_PRINT_HELPER || path.resolve(__dirname, '..', 'print', 'film_print.py');
      let ended = false, buffered = '', chain: Promise<unknown> = Promise.resolve();
      const child = spawn(python, ['-I', script], { stdio: ['pipe', 'pipe', 'pipe'] });
      const timer = setTimeout(() => child.kill('SIGKILL'), limitMs);
      const line = (text: string) => {
        let event: any;
        try { event = JSON.parse(text); } catch { return; }
        if (event?.event === 'sent' && !ended) chain = chain.then(() => this.sent(id, events, event));
        if (event?.event === 'final' && !ended && FINAL_STATES.has(event.state)) {
          ended = true;
          chain = chain.then(() => this.finish(id, events, { state: event.state, reason: typeof event.reason === 'string' ? event.reason : null,
            warnings: Array.isArray(event.warnings) ? event.warnings.filter((w: unknown) => typeof w === 'string') : [] }));
        }
      };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        buffered += chunk;
        for (let at = buffered.indexOf('\n'); at >= 0; at = buffered.indexOf('\n')) { line(buffered.slice(0, at)); buffered = buffered.slice(at + 1); }
      });
      child.stderr.on('data', () => undefined);
      child.stdin.on('error', () => undefined);
      let closed = false;
      const done = (started: boolean) => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        if (buffered.trim()) line(buffered);
        if (!ended) {
          ended = true;
          // The helper could not start: nothing was sent. It stopped without its answer: the result is unknown.
          chain = chain.then(() => this.finish(id, events, started
            ? { state: 'no-answer', reason: 'the print helper stopped before the answer came' }
            : { state: 'failed', reason: 'the print helper could not start' }));
        }
        void chain.finally(resolve);
      };
      child.on('error', () => done(false));
      child.on('close', () => done(true));
      child.stdin.end(JSON.stringify(request));
    });
  }

  private async sent(id: string, events: any[], event: any) {
    events.push({ state: 'sent', at: new Date().toISOString() });
    const warnings = Array.isArray(event.warnings) ? event.warnings.filter((w: unknown) => typeof w === 'string') : [];
    await this.prisma.filmPrintJob.updateMany({ where: { id, state: 'sending' },
      data: { state: 'sent', events, warnings, printJobUid: typeof event.printJobUid === 'string' ? event.printJobUid.slice(0, 64) : null } });
  }

  private async finish(id: string, events: any[], end: { state: string; reason?: string | null; warnings?: string[] }, error?: unknown) {
    if (error) this.log.warn(`film print job ${id}: ${(error as any)?.message ?? error}`);
    events.push({ state: end.state, at: new Date().toISOString() });
    try {
      await this.prisma.filmPrintJob.updateMany({ where: { id, state: { in: OPEN } },
        data: { state: end.state, reason: end.reason ?? null, events, ...(end.warnings ? { warnings: end.warnings } : {}), endedAt: new Date() } });
    } catch (failure: any) {
      this.log.error(`film print job ${id} result ${end.state} was not recorded: ${failure?.message ?? failure}`);
    }
  }
}

/** The layout image's attributes: the original study's identity, a new series and instance of its own. */
export function layoutAttributes(study: Study, layout: Layout, output: { seriesUid: string; sopUid: string }, now = new Date()) {
  const pick = (from: Record<string, string>, keys: string[]) => Object.fromEntries(keys.filter(k => typeof from[k] === 'string' && from[k] !== '').map(k => [k, from[k]]));
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`, time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return { ...pick(study.patient, ['PatientName', 'PatientID', 'PatientBirthDate', 'PatientSex']),
    ...pick(study.study, ['StudyInstanceUID', 'StudyDate', 'StudyTime', 'StudyID', 'AccessionNumber', 'ReferringPhysicianName', 'StudyDescription']),
    SeriesInstanceUID: output.seriesUid, SOPInstanceUID: output.sopUid, SeriesNumber: '9900', InstanceNumber: '1',
    SeriesDescription: `Print layout ${layout.columns}x${layout.rows}`, Modality: 'OT', ConversionType: 'WSD',
    SeriesDate: date, SeriesTime: time, ContentDate: date, ContentTime: time };
}
