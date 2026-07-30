require('dotenv').config();
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const { toFile } = require('openai');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function mimeFromExt(p){
  const ext = path.extname(p).toLowerCase();
  if (ext === '.webp') return 'image/webp';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  return 'image/png';
}

async function main(){
  const photo1Path = process.argv[2];
  const photo2Path = process.argv[3];

  if (!photo1Path || !photo2Path) {
    console.log('Usage: node test-cad-ai.js <photo-1-path> <photo-2-path>');
    process.exit(1);
  }

  console.log('API key present:', !!process.env.OPENAI_API_KEY, '- starts with:', (process.env.OPENAI_API_KEY||'').slice(0,7));
  console.log('Model: gpt-image-1.5');

  // Stripped right down: no description, no labels, no layout, no logo,
  // no detail callouts - just identify front/back and redraw both as
  // accurately as possible.
  const prompt = `Using the attached reference images, create a production-quality fashion flat CAD of the garment.

The attached images are the ONLY source of truth.

Your task is to accurately reproduce the garment exactly as shown.

DO NOT redesign, reinterpret, improve, simplify, modernize, balance or invent any construction details.

This is a replication task, not a design task.

\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
PRIMARY OBJECTIVE
\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

Create a professional apparel flat suitable for a factory tech pack.

The output must match the reference garment as closely as possible.

Image similarity target: 99%.

Every visible detail must be preserved.

\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
GARMENT CONSTRUCTION
\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

Accurately reproduce every visible construction detail including but not limited to:

\u2022 overall silhouette
\u2022 proportions
\u2022 fit
\u2022 shape
\u2022 balance
\u2022 panel construction
\u2022 seam placement
\u2022 stitch placement
\u2022 seam types
\u2022 topstitching
\u2022 edge stitching
\u2022 waist construction
\u2022 neckline
\u2022 collar
\u2022 hood
\u2022 sleeve construction
\u2022 cuffs
\u2022 plackets
\u2022 fly construction
\u2022 zipper placement
\u2022 button placement
\u2022 snap placement
\u2022 pocket construction
\u2022 welt pockets
\u2022 patch pockets
\u2022 cargo pockets
\u2022 pocket flaps
\u2022 yokes
\u2022 pleats
\u2022 darts
\u2022 gathers
\u2022 tucks
\u2022 elastic sections
\u2022 hems
\u2022 vents
\u2022 side slits
\u2022 facings
\u2022 bindings
\u2022 trims
\u2022 piping
\u2022 drawcords
\u2022 toggles
\u2022 hardware
\u2022 rivets
\u2022 eyelets
\u2022 labels if visible
\u2022 every visible construction line

\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
ARTWORK
\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

If the garment contains:

\u2022 embroidery
\u2022 print
\u2022 artwork
\u2022 appliqu\u00e9
\u2022 patches
\u2022 quilting
\u2022 embossing
\u2022 laser effects
\u2022 distressing
\u2022 washing
\u2022 fading
\u2022 graphics
\u2022 logos
\u2022 decorative stitching

reproduce every element exactly.

Do NOT

\u2022 move artwork
\u2022 resize artwork
\u2022 rotate artwork
\u2022 simplify artwork
\u2022 evenly distribute artwork
\u2022 clean up artwork
\u2022 redraw artwork differently

Copy every visible artwork element exactly where it appears on the garment.

\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
FABRIC
\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

Preserve the appearance of the original fabric including:

\u2022 colour
\u2022 wash
\u2022 grain
\u2022 weave
\u2022 texture
\u2022 thickness
\u2022 drape
\u2022 fading
\u2022 distressing
\u2022 coating
\u2022 brushing
\u2022 denim character
\u2022 knit texture
\u2022 woven texture

Do not substitute another fabric appearance.

\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
PROPORTIONS
\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

Do not alter:

\u2022 garment proportions
\u2022 pocket proportions
\u2022 sleeve proportions
\u2022 leg proportions
\u2022 body length
\u2022 hem width
\u2022 shoulder width
\u2022 rise
\u2022 collar size

Maintain the exact proportions shown in the reference.

\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
PRESENTATION
\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

Present the garment as a professional apparel flat.

\u2022 Front and back side by side (when both references are provided)
\u2022 Perfectly flat
\u2022 Symmetrical
\u2022 White background
\u2022 No mannequin
\u2022 No model
\u2022 No styling
\u2022 No shadows
\u2022 No reflections
\u2022 No wrinkles unless they are part of the construction
\u2022 No unnecessary folds
\u2022 No props
\u2022 No text
\u2022 No dimensions
\u2022 No callouts

\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
STYLE
\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

This is NOT:

\u2022 a fashion illustration
\u2022 a concept sketch
\u2022 a stylized drawing
\u2022 an artistic rendering
\u2022 a redesigned garment

This IS:

A production-quality apparel flat suitable for a professional factory tech pack.

Maintain realistic fabric texture, stitching and construction while presenting the garment perfectly flat.

\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
IMPORTANT
\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

Treat the reference images as engineering drawings.

Do not infer hidden construction.

Do not invent missing details.

Do not "improve" the garment.

Do not modify symmetry.

Do not modify proportions.

Do not modify construction.

Do not modify artwork.

Replicate only what is visible.

The final image should appear to be the original garment laid perfectly flat for factory development.`;

  try {
    const images = await Promise.all([photo1Path, photo2Path].map(p =>
      toFile(fs.createReadStream(p), null, { type: mimeFromExt(p) })
    ));

    console.log('Generating flats with gpt-image-1.5...');
    const result = await client.images.edit({
      model: 'gpt-image-1.5',
      image: images,
      input_fidelity: 'high',
      quality: 'high',
      prompt,
      size: '1536x1024'
    });

    const pngBuffer = Buffer.from(result.data[0].b64_json, 'base64');
    fs.writeFileSync('test-output-flats.png', pngBuffer);

    console.log('SUCCESS - wrote test-output-flats.png in this folder');
  } catch (e) {
    console.error('FAILED');
    console.error('Message:', e.message);
    if (e.status) console.error('Status:', e.status);
    if (e.error) console.error('Details:', JSON.stringify(e.error, null, 2));
  }
}
main();