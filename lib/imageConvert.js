const sharp = require('sharp');
const path = require('path');

// Converts an in-memory image buffer - any format sharp/libvips can decode:
// jpg, png, gif, webp, avif, etc. - to WebP at an exact destination path.
// Throws if the buffer isn't a decodable image - callers should catch this
// and surface a clean error rather than let a corrupt/unsupported file crash
// the request.
async function convertBufferToWebpFile(buffer, destPath) {
  await sharp(buffer, { animated: true }).webp({ quality: 85 }).toFile(destPath);
}

// Same conversion, but writes to destDir under a fresh filename built from
// the given prefix - the common case for uploads that don't need a
// predictable name (reference photos, detail crops). Returns the filename.
async function saveBufferAsWebp(buffer, destDir, filenamePrefix) {
  const rand = Math.random().toString(36).slice(2, 8);
  const filename = `${filenamePrefix}-${Date.now()}-${rand}.webp`;
  await convertBufferToWebpFile(buffer, path.join(destDir, filename));
  return filename;
}

// Resizes to a fixed width (never upscales a smaller source) - used for
// board-card thumbnails, where the full-resolution image would be wasted
// bandwidth for a ~200px card.
async function makeThumbnailFile(buffer, destPath, width = 200) {
  await sharp(buffer, { animated: true }).resize({ width, withoutEnlargement: true }).webp({ quality: 82 }).toFile(destPath);
}

// Resized/JPEG-compressed data: URL for embedding a photo inline in an
// outbound request email (concepts'/styles' send-request routes, and the
// MCP send_request tool). A raw phone photo can be several MB - embedding
// it losslessly as PNG (the original approach here) plus ~33% base64
// overhead easily exceeds a recipient's mail server's message-size limit
// and silently bounces (confirmed live: a real costing request to Wofeng
// bounced with SMTP 552 "Message size exceeds maximum permitted"). Email
// viewing doesn't need source resolution or lossless quality, so this
// resizes to a sane max width and re-encodes as JPEG - both universally
// renderable in mail clients, dramatically smaller for photographic
// content than PNG at any resolution.
async function imageFileToEmailDataUrl(filePath, maxWidth = 1400) {
  const buffer = await sharp(filePath).resize({ width: maxWidth, withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
  return 'data:image/jpeg;base64,' + buffer.toString('base64');
}

module.exports = { saveBufferAsWebp, convertBufferToWebpFile, makeThumbnailFile, imageFileToEmailDataUrl };
