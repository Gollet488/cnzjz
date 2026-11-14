const selector = '.button-glow, .el-button--primary, .heading-actions .el-button';

export function installButtonGlow() {
  const motion = window.matchMedia(
    '(any-hover: hover) and (any-pointer: fine) and (prefers-reduced-motion: no-preference)',
  );
  let active: HTMLButtonElement | undefined;

  function reset() {
    if (!active) return;
    active.style.removeProperty('--glow-x');
    active.style.removeProperty('--glow-y');
    active = undefined;
  }

  function move(event: PointerEvent) {
    if (!motion.matches || event.pointerType === 'touch') return;
    const button =
      event.target instanceof Element
        ? (event.target.closest<HTMLButtonElement>(selector) ?? undefined)
        : undefined;
    if (button !== active) reset();
    if (!button || button.matches(':disabled, .is-loading, [aria-disabled="true"]')) return;

    active = button;
    const { left, top, width, height } = button.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (event.clientX - left) / width));
    const y = Math.min(1, Math.max(0, (event.clientY - top) / height));
    button.style.setProperty('--glow-x', `${x * 100}%`);
    button.style.setProperty('--glow-y', `${y * 100}%`);
  }

  function leave(event: PointerEvent) {
    if (active && !(event.relatedTarget instanceof Node && active.contains(event.relatedTarget)))
      reset();
  }

  document.addEventListener('pointermove', move, { passive: true });
  document.addEventListener('pointerout', leave, { passive: true });
  window.addEventListener('blur', reset);
  motion.addEventListener('change', reset);
  return () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerout', leave);
    window.removeEventListener('blur', reset);
    motion.removeEventListener('change', reset);
    reset();
  };
}
