import { shallowRef } from 'vue';

type Theme = 'light' | 'dark';

const root = document.documentElement;
const system = window.matchMedia('(prefers-color-scheme: dark)');
let preference: Theme | undefined;
try {
  const saved = localStorage.getItem('kinetic.theme');
  if (saved === 'light' || saved === 'dark') preference = saved;
} catch {
  // The page can still follow the system and switch themes for this visit.
}
const current = shallowRef<Theme>(preference ?? (system.matches ? 'dark' : 'light'));
export const theme: Readonly<typeof current> = current;

function applyTheme(value: Theme) {
  root.dataset.theme = value;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', getComputedStyle(root).getPropertyValue('--page').trim());
  current.value = value;
}

export function installTheme() {
  function syncSystem() {
    if (!preference) applyTheme(system.matches ? 'dark' : 'light');
  }
  applyTheme(current.value);
  system.addEventListener('change', syncSystem);
  return () => system.removeEventListener('change', syncSystem);
}

export function toggleTheme() {
  const next = current.value === 'dark' ? 'light' : 'dark';
  preference = next;
  applyTheme(next);
  try {
    localStorage.setItem('kinetic.theme', next);
  } catch {
    // Retain the selection in memory for this visit.
  }
}
