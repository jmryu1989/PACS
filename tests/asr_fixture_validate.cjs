'use strict';
/* S3-ASR-U3 — validate the generated fixture with the SHIPPED COMPILED wire validator.
 *
 * Runs inside kin-api:ci with --network none, before the engine exists. It deliberately uses
 * /app/dist/dictation-audio rather than a copy, so the bytes that reach the engine are exactly
 * the bytes the product would accept. Prints one JSON object on stdout and exits non-zero when
 * the fixture is not the canonical dictation wire format.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const { inspectDictationWav, DICTATION_AUDIO_MAX_BYTES } = require('/app/dist/dictation-audio');

const path = process.argv[2] || '/fixture/dictation.wav';
const bytes = fs.readFileSync(path);
const result = inspectDictationWav(bytes);
const record = {
  module: '/app/dist/dictation-audio',
  path,
  bytes: bytes.length,
  sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  wav_max_bytes: DICTATION_AUDIO_MAX_BYTES,
  result,
};
process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
if (!result.ok) {
  process.stderr.write(`asr_fixture_validate: shipped validator rejected ${path}\n`);
  process.exit(1);
}
