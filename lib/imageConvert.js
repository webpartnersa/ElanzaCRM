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

module.exports = { saveBufferAsWebp, convertBufferToWebpFile, makeThumbnailFile };
