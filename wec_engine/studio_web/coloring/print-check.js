/* Planning checks only. The exported PDF and KDP acceptance need separate review. */
export const PRINT_PROFILE = Object.freeze({
  id: 'letter-bw-white-no-bleed-v1', width: 8.5, height: 11, margin: 0.5,
  minimumPages: 24, maximumPages: 590, targetPpi: 300, checkedOn: '2026-10-21',
  sources: ['https://kdp.amazon.com/help/topic/G201857950',
    'https://kdp.amazon.com/help/topic/GVBQ3CMEQW3W2VL6',
    'https://kdp.amazon.com/help/topic/G202169030'],
});

export function fittedArtwork(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw Error('Artwork needs positive pixel dimensions.');
  }
  const boxWidth = PRINT_PROFILE.width - 2 * PRINT_PROFILE.margin;
  const boxHeight = PRINT_PROFILE.height - 2 * PRINT_PROFILE.margin;
  const ppi = Math.max(width / boxWidth, height / boxHeight);
  const printWidth = width / ppi, printHeight = height / ppi;
  return {width_inches: printWidth, height_inches: printHeight, effective_ppi: ppi,
    meets_target: ppi >= PRINT_PROFILE.targetPpi,
    pixels_at_target: [Math.ceil(printWidth * PRINT_PROFILE.targetPpi), Math.ceil(printHeight * PRINT_PROFILE.targetPpi)]};
}

function gutterFor(pages) {
  if (pages <= 150) return .375;
  if (pages <= 300) return .5;
  if (pages <= 500) return .625;
  if (pages <= 700) return .75;
  return .875;
}

export function checkBook(images, blankBacks, title = '') {
  if (!Array.isArray(images) || typeof blankBacks !== 'boolean' || typeof title !== 'string') {
    throw Error('Invalid print-check input.');
  }
  const exportedPages = images.length * (blankBacks ? 2 : 1);
  const kdpPages = exportedPages + exportedPages % 2;
  const inside = gutterFor(kdpPages), rows = images.map((image, index) => ({
    illustration: index + 1, pdf_page: index * (blankBacks ? 2 : 1) + 1,
    name: image.name, width_pixels: image.width, height_pixels: image.height,
    ...fittedArtwork(image.width, image.height),
  }));
  const lowResolution = rows.filter(row => !row.meets_target);
  const checks = [
    {code: 'page_count', passes: kdpPages >= PRINT_PROFILE.minimumPages && kdpPages <= PRINT_PROFILE.maximumPages,
      message: `${exportedPages} exported pages; ${kdpPages} after KDP even-page rounding. Profile range: 24–590 pages.`},
    {code: 'layout_margin', passes: PRINT_PROFILE.margin >= inside && PRINT_PROFILE.margin >= .25,
      message: `Planned inset: 0.5 in on each edge. Inside minimum for this page range: ${inside} in; outside minimum without bleed: 0.25 in.`},
    {code: 'image_resolution', passes: rows.length > 0 && lowResolution.length === 0,
      message: rows.length ? `${lowResolution.length} of ${rows.length} illustrations are below 300 PPI at their fitted print size.` : 'Add artwork to check image resolution.'},
  ];
  const notices = [
    'Profile: paperback, black ink on white paper, Letter 8.5 × 11 in, no bleed. Other print options need different checks.',
    'These calculations inspect the open book, not a PDF file. Browser print settings can change the result.',
    'Review the final PDF page size/count, margins, blank backs, line clarity, transparency and grayscale before upload. A cover and any front matter are separate work.',
    'Use KDP Print Previewer and a physical proof for publishing review. Passing these checks is not KDP approval.',
  ];
  if (exportedPages % 2) notices.unshift('The export has an odd page count. KDP may add a final blank page; check the resulting pagination.');
  if (lowResolution.length) notices.unshift('Use higher-resolution originals or a smaller print size. Changing a DPI tag or enlarging pixels does not restore missing detail.');
  return {schema_version: 1, title, profile: PRINT_PROFILE, illustrations: images.length,
    blank_backs: blankBacks, exported_pages: exportedPages, kdp_rounded_pages: kdpPages,
    required_inside_margin_inches: inside, basic_checks_pass: checks.every(check => check.passes),
    publishing_review_required: true, pdf_file_inspected: false, checks, notices, pages: rows};
}
