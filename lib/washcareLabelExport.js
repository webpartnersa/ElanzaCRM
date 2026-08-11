const sharp = require('sharp');
const path = require('path');

// Renders a woven/printed-style wash care label as a PNG, matching the
// layout of public/final-submission/pl036b-washcare.png (the real label
// example this was built from): style no, composition, a fixed row of 5
// ISO 3758/GINETEX-style care icons, the free-text care instructions
// (styles.washcare_details), country of manufacture, importer/vendor code
// and article number, and season. The icon set is fixed (cold wash, medium
// iron, no tumble dry, no dry clean, no bleach) rather than chosen per
// style - see the icon-approach discussion this was built against; revisit
// if per-style icon selection is ever needed.
//
// Text/layout is built as an SVG string rasterized by sharp, then the 5
// real icon images (lib/washcare-icons/, cropped from public/washcare-icons.png -
// a clean reference set, not hand-drawn) are composited on top at a fixed
// height with proportional widths, since they're not a uniform aspect ratio.

const W = 300, H = 620;
const ICONS_DIR = path.join(__dirname, 'washcare-icons');
const ICON_ROW = ['wash.png', 'iron.png', 'notumbledry.png', 'nodryclean.png', 'nobleach.png'];
const ICON_TARGET_HEIGHT = 34;
const ICON_GAP = 14;

function escapeXml(s) {
  return (s || '').toString().replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function wrapLines(text, maxCharsPerLine) {
  const words = (text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  words.forEach(w => {
    if ((current + ' ' + w).trim().length > maxCharsPerLine && current) {
      lines.push(current.trim());
      current = w;
    } else {
      current = (current + ' ' + w).trim();
    }
  });
  if (current) lines.push(current);
  return lines;
}

async function buildWashcareLabelPng({ style, fabric, factory }) {
  const composition = (style && style.composition) || (fabric && fabric.composition) || '';
  const compLines = wrapLines(composition, 30);
  const careLines = ((style && style.washcare_details) || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  let y = 30;
  const parts = [];
  parts.push(`<rect x="1" y="1" width="${W - 2}" height="${H - 2}" fill="#fff" stroke="#000" stroke-width="1.5"/>`);

  parts.push(`<text x="${W / 2}" y="${y}" font-size="20" font-weight="bold" font-family="Arial,Helvetica,sans-serif" text-anchor="middle">${escapeXml((style && style.style_no) || '')}</text>`);
  y += 30;

  compLines.forEach(line => {
    parts.push(`<text x="${W / 2}" y="${y}" font-size="11" font-family="Arial,Helvetica,sans-serif" text-anchor="middle" fill="#333">${escapeXml(line)}</text>`);
    y += 16;
  });
  y += 14;

  // Icon row itself is composited in afterward (see below) - just reserve
  // the same vertical space here so everything below still lines up.
  const iconRowY = y;
  y += ICON_TARGET_HEIGHT + 14;

  careLines.forEach(line => {
    parts.push(`<text x="${W / 2}" y="${y}" font-size="10" font-family="Arial,Helvetica,sans-serif" text-anchor="middle" fill="#222">${escapeXml(line)}</text>`);
    y += 15;
  });
  y += 16;

  parts.push(`<line x1="20" y1="${y - 8}" x2="${W - 20}" y2="${y - 8}" stroke="#ccc" stroke-width="1"/>`);

  const footerLines = [
    factory && factory.country ? `Made in ${factory.country}` : null,
    factory && factory.importer_vendor_code ? `Importer/Vendor code: ${factory.importer_vendor_code}` : null,
    style && style.art_no ? `Art. No: ${style.art_no}` : null,
    style && style.season ? `Season: ${style.season}` : null,
  ].filter(Boolean);
  footerLines.forEach(line => {
    parts.push(`<text x="${W / 2}" y="${y}" font-size="10" font-family="Arial,Helvetica,sans-serif" text-anchor="middle" fill="#000">${escapeXml(line)}</text>`);
    y += 16;
  });

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join('')}</svg>`;
  const baseBuffer = await sharp(Buffer.from(svg)).png().toBuffer();

  const icons = await Promise.all(ICON_ROW.map(async file => {
    const buf = await sharp(path.join(ICONS_DIR, file)).resize({ height: ICON_TARGET_HEIGHT }).png().toBuffer();
    const meta = await sharp(buf).metadata();
    return { buf, width: meta.width };
  }));
  const totalWidth = icons.reduce((sum, ic) => sum + ic.width, 0) + ICON_GAP * (icons.length - 1);
  let cursorX = (W - totalWidth) / 2;
  const composites = icons.map(ic => {
    const layer = { input: ic.buf, left: Math.round(cursorX), top: Math.round(iconRowY) };
    cursorX += ic.width + ICON_GAP;
    return layer;
  });

  return sharp(baseBuffer).composite(composites).png().toBuffer();
}

module.exports = { buildWashcareLabelPng };
