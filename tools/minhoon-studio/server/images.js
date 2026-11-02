'use strict';
const fs = require('fs');
const path = require('path');
const { today } = require('./util');

// Owner's screenshot limits, measured after the browser resizes and encodes the image.
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const CHAT_BODY_BYTES = MAX_IMAGES * Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 256 * 1024;

function storeImages(dataDir, jobId, images = []) {
  const refuse = message => { throw Object.assign(new Error(message), { status: 400 }); };
  if (!Array.isArray(images)) refuse('첨부 그림을 다시 선택해 주세요.');
  if (images.length > MAX_IMAGES) refuse(`그림은 한 번에 ${MAX_IMAGES}장까지 보낼 수 있습니다.`);
  // Check the whole request before writing: a mistyped/oversized attachment must not leave half a request stored.
  const decoded = images.map(image => {
    if (!image || !['image/png', 'image/jpeg'].includes(image.type) || typeof image.data !== 'string') {
      refuse('PNG 또는 JPEG 그림을 첨부해 주세요.');
    }
    const bytes = Buffer.from(image.data, 'base64');
    if (!bytes.length) refuse('빈 그림입니다. 다시 첨부해 주세요.');
    if (bytes.length > MAX_IMAGE_BYTES) refuse('그림은 축소한 뒤 장당 8 MB까지 보낼 수 있습니다.');
    return { bytes, image };
  });
  const saved = [];
  try {
    for (const { bytes, image } of decoded) {
      const relative = `uploads/${today()}/${jobId}-${saved.length + 1}.${image.type === 'image/jpeg' ? 'jpg' : 'png'}`;
      const file = path.join(dataDir, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      saved.push({ path: relative, width: image.width, height: image.height });
      fs.writeFileSync(file, bytes);
    }
  } catch (error) {
    for (const image of saved) fs.rmSync(path.join(dataDir, image.path), { force: true });
    throw error;
  }
  return saved;
}

module.exports = { storeImages, CHAT_BODY_BYTES };
