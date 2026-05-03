const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const galleries = {
  'custom':                    'assets/custom',
  'production':                'assets/production',
  'details':                   'assets/details',
  'multifamily/orchard-grove': 'assets/multifamily/orchard-grove',
  'multifamily/parkway':       'assets/multifamily/parkway',
  'multifamily/4th-main':      'assets/multifamily/4th-main',
  'multifamily/the-crossing':  'assets/multifamily/the-crossing',
  'multifamily/altura':        'assets/multifamily/altura'
};

const IMAGE_EXTS = /\.(jpg|jpeg|png|webp)$/i;
const COVER_NAMES = /^cover\.(jpg|jpeg|png|webp)$/i;

function getGitTimestamp(filePath) {
  try {
    const ts = execSync(`git log -1 --format="%ct" -- "${filePath}"`, { encoding: 'utf8' }).trim();
    return ts ? parseInt(ts, 10) : 0;
  } catch {
    return 0;
  }
}

const manifest = {};

for (const [key, dir] of Object.entries(galleries)) {
  if (!fs.existsSync(dir)) {
    manifest[key] = { cover: null, photos: [] };
    continue;
  }

  const allFiles = fs.readdirSync(dir).filter(f => IMAGE_EXTS.test(f));

  // Find cover photo
  const coverFile = allFiles.find(f => COVER_NAMES.test(f));
  const cover = coverFile ? `${dir}/${coverFile}` : null;

  // All non-cover photos sorted newest first
  const photos = allFiles
    .filter(f => !COVER_NAMES.test(f))
    .map(f => {
      const rel = `${dir}/${f}`;
      return { path: rel, ts: getGitTimestamp(rel) };
    })
    .sort((a, b) => b.ts - a.ts)
    .map(f => f.path);

  manifest[key] = { cover, photos };
}

fs.writeFileSync('gallery-manifest.json', JSON.stringify(manifest, null, 2));
console.log('✓ Gallery manifest generated');
console.log(JSON.stringify(manifest, null, 2));
