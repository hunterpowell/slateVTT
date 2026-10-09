// How much of the bottom of the screen an on-screen keyboard covers, as the CSS
// variable `--kb`. The phone layout lifts the right-hand column by it, so the
// chat box stays above the keyboard while someone types.
//
// Android Chrome and Firefox shrink the page for the keyboard themselves
// (`interactive-widget=resizes-content` in the viewport tag), and this reads 0
// there. iOS Safari ignores that flag and only shrinks the visual viewport,
// which is what this measures. See `docs/frontend.md`, *A player's phone*.

export function trackKeyboard(): void {
  const vv = window.visualViewport;
  if (vv === null || vv === undefined) return;
  const update = (): void => {
    const covered = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop));
    document.documentElement.style.setProperty('--kb', `${Math.round(covered)}px`);
  };
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  update();
}
