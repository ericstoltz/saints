/* Dancing Saints settings. Paths are relative so the folder works at any URL,
 * such as saintgregorys.org/saints/ or a GitHub Pages test site. */
window.CONFIG = {
  // Parish logo and loading image, bundled in img/. The site URLs are fallbacks.
  logo: ['img/logo.png', 'https://saintgregorys.org/wp-content/uploads/2024/10/SGN-LOGO-renew2024final.png'],
  loadingImage: ['img/loading.webp', 'https://saintgregorys.org/wp-content/uploads/2024/10/SGN-web-footer-1-768x1024.png'],
  // Camera matching: frame width analyzed (smaller is faster, larger sees more detail).
  analysisWidth: 480,
  faceAnalysisWidth: 640,   // picture width for the face finder
  faceMinSim: 0.82,         // a circle shows only if its face looks this much like some saint's portrait
  // How long hotspots stay on screen after the mural is lost (ms).
  holdMs: 700,
  // Bump with each release so phones fetch fresh pictures and data instead of cached ones.
  version: '20261022i'
};
