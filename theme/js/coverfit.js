/*
 * Gatefold · coverfit.js — covers that are not square are shown whole.
 *
 * Tiles and rows have square frames. A cover that is not square (an LP-proportioned sleeve, a scan of
 * a whole booklet front, a CD single) used to be cropped to fill them. Now, as soon as such a picture
 * loads, it is fitted inside the frame and the rest of the frame is filled with a blurred, darkened
 * copy of the same picture (the way Apple Music shows them). On the album page and on Now Playing the
 * frame itself takes the picture's proportions.
 * One listener for the whole page (image load events, captured): nothing to call from the views.
 */
const BOX = '.tile .cov, .vtile .cov, .c-cov, .sim-tile .cov, .atile .cov, .pb-art, .cp-preview';
const TRUE = '#view-album .album-cover, .np-art';                 // frames that take the picture's proportions
const NEAR = 0.035;                                               // |ln(w/h)| below this counts as square

function fit(im) {
  const box = im.parentElement;
  if (!box) return;
  const own = box.matches(TRUE), framed = !own && box.matches(BOX);
  if (!own && !framed) return;
  const r = im.naturalWidth && im.naturalHeight ? im.naturalWidth / im.naturalHeight : 1;
  const odd = Math.abs(Math.log(r)) > NEAR;
  if (own) {
    if (box.classList.contains('np-art')) {
      // Now Playing: the wrap keeps the square's size on its long side
      const wrap = box.closest('.np-art-wrap');
      if (wrap) { wrap.style.aspectRatio = odd ? String(r) : ''; wrap.classList.toggle('nsq-true', odd); wrap.style.setProperty('--ar-w', odd ? String(Math.min(1, r)) : '1'); }
    } else { box.style.aspectRatio = odd ? String(Math.max(0.6, Math.min(1.6, r))) : ''; box.classList.toggle('nsq-true', odd); }
    im.classList.toggle('nsq-img', odd);
    return;
  }
  box.classList.toggle('nsq', odd);
  let bg = box.querySelector(':scope > .nsq-bg');
  if (odd) {
    if (!bg) { bg = document.createElement('i'); bg.className = 'nsq-bg'; box.prepend(bg); }
    bg.style.backgroundImage = `url("${String(im.currentSrc || im.src).replace(/"/g, '%22')}")`;
  } else if (bg) bg.remove();
}
document.addEventListener('load', (e) => { if (e.target instanceof HTMLImageElement) fit(e.target); }, true);
export const _fit = fit;
