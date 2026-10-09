/**
 * Produces a transient grid-overlay copy for a vision request. The source
 * image remains the asset used by the browser cutout; this guide is never
 * saved or returned to a client.
 */
export async function createPhotoCutoutCoordinateGuide(
  sourceDataUrl: string,
  width: number,
  height: number,
): Promise<string> {
  const match =
    /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(
      sourceDataUrl,
    );
  if (!match) throw new Error('A PNG, JPEG, or WebP source image is required.');
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1
  ) {
    throw new Error('Coordinate guide dimensions are invalid.');
  }

  const { default: sharp } = await import('sharp');
  const source = Buffer.from(match[1], 'base64');
  const metadata = await sharp(source).metadata();
  if (
    !metadata.width ||
    !metadata.height ||
    metadata.width * metadata.height > 16_000_000
  ) {
    throw new Error('Coordinate guide source dimensions are invalid.');
  }
  const oriented = await sharp(source).rotate().toBuffer({
    resolveWithObject: true,
  });
  if (oriented.info.width !== width || oriented.info.height !== height) {
    throw new Error('Coordinate guide dimensions do not match the source.');
  }
  const grid = coordinateGridSvg(width, height);
  const png = await sharp(oriented.data)
    .composite([{ input: Buffer.from(grid) }])
    .png()
    .toBuffer();
  return `data:image/png;base64,${png.toString('base64')}`;
}

function coordinateGridSvg(width: number, height: number): string {
  const line = (fraction: number) => {
    const x = Math.round(width * fraction);
    const y = Math.round(height * fraction);
    return `<path d="M${x} 0V${height}M0 ${y}H${width}"/>`;
  };
  const label = (fraction: number) => {
    const x = Math.round(width * fraction);
    const y = Math.round(height * fraction);
    const value = Math.round(fraction * 1000);
    return `<text x="${Math.min(x + 4, width - 30)}" y="16">${value}</text><text x="4" y="${Math.min(y - 4, height - 4)}">${value}</text>`;
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <g fill="none" stroke="#00e5ff" stroke-opacity=".58" stroke-width="1">${Array.from({ length: 9 }, (_, index) => line((index + 1) / 10)).join('')}</g>
  <rect x=".5" y=".5" width="${width - 1}" height="${height - 1}" fill="none" stroke="#00e5ff" stroke-width="1"/>
  <g fill="#ffffff" stroke="#00151a" stroke-width="2" paint-order="stroke" font-family="monospace" font-size="12">${[0, 0.25, 0.5, 0.75, 1].map(label).join('')}</g>
</svg>`;
}
