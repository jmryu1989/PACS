import type { DisclosureManifest } from './contract';

type Original = { recordId: string; versionId: string; original: string };
const esc = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fixedContentType = (manifest: DisclosureManifest) => manifest.delivery.format === 'paper-print'
  ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8';

/** Paper needs readable text, while the electronic document retains the signed
 * source strings. Both are generated once and reopened from the saved bytes. */
export function fixedDocument(manifest: DisclosureManifest, originals: Original[]): Buffer {
  const document = { manifest, originals };
  if (manifest.delivery.format === 'signed-electronic') return Buffer.from(JSON.stringify(document), 'utf8');
  const field = (label: string, value: string) => value ? `<h3>${label}</h3><pre>${esc(value)}</pre>` : '';
  const sections = originals.map(item => {
    const source = JSON.parse(item.original);
    const content = source.plan ? JSON.parse(source.plan).version :
      JSON.parse(Buffer.from(source.envelope.payload, 'base64url').toString('utf8'));
    const signing = source.plan ? JSON.parse(source.signature ?? 'null')?.registration?.doctor : source.keyAtSigning?.doctor;
    // 의료법 제22조①: retain the registered signer identity carried by this original.
    const author = signing?.identityRegistrationId ?? (source.plan ? JSON.parse(source.plan).signing?.identityRegistrationId : content.identityRegistrationId);
    const authorLabel = author ?? `${content.author.issuer} / ${content.author.subject}`;
    const action = { 'approve-sign': 'Approved Report', addendum: 'Addendum', amend: 'Amendment',
      cancel: 'Cancellation', entry: 'Original Entry', 'additional-entry': 'Additional Entry', correction: 'Correction' }[content.action ?? content.act] ?? 'Record Version';
    const text = content.text?.kind === 'report'
      ? field('Findings', content.text.findings) + field('Conclusion', content.text.conclusion) + field('Recommendation', content.text.recommendation)
      : field('Content', typeof content.text === 'string' ? content.text : content.text?.body ?? '');
    return `<section><h2>${action}</h2><dl><dt>Recorded</dt><dd>${esc(content.serverTime ?? content.at)}</dd>` +
      `<dt>Author</dt><dd>${esc(authorLabel)}</dd><dt>Study</dt><dd>${esc(content.studyId)}</dd>` +
      `<dt>Record</dt><dd>${esc(item.recordId)}</dd><dt>Version</dt><dd>${esc(item.versionId)}</dd></dl>` +
      text + field('Reason', content.reason ?? '') + '</section>';
  }).join('');
  return Buffer.from('<!doctype html><html lang="en"><meta charset="utf-8"><title>Fixed Record Copy</title>' +
    '<style>body{font:16px/1.5 sans-serif;margin:2rem;color:#17212b;max-width:52rem}pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere}' +
    'dl{display:grid;grid-template-columns:8rem 1fr;gap:.3rem}dt{font-weight:bold}dd{margin:0;overflow-wrap:anywhere}h3{font-size:1rem;margin-bottom:0}' +
    'section{border-top:1px solid #ccc;margin-top:2rem;padding-top:1rem}@media print{details{display:none}section{break-inside:avoid}}</style>' +
    '<body><h1>Fixed Record Copy</h1><p>발급 시점의 고정 사본입니다. 수령 사실은 별도로 기록합니다.</p>' +
    `<dl><dt>Patient ID</dt><dd>${esc(manifest.patient.patientId)}</dd><dt>Assigning Authority</dt><dd>${esc(manifest.patient.assigningAuthority)}</dd>` +
    `<dt>Institution</dt><dd>${esc(manifest.institutionId)}</dd><dt>Prepared</dt><dd>${esc(manifest.preparedAt)}</dd>` +
    `<dt>Recipient</dt><dd>${esc(manifest.delivery.recipient)}</dd></dl>${sections}` +
    `<details><summary>Original Documents</summary><pre>${esc(JSON.stringify(document, null, 2))}</pre></details></body></html>`, 'utf8');
}
