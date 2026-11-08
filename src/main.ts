import '@fontsource-variable/manrope/wght.css';
import '@fontsource/rozha-one/latin-400.css';
import '@fontsource/rozha-one/devanagari-400.css';
import './style.css';
import { App } from './ui/app';

const app = new App();

// A small handle for the end-to-end tests and for curious visitors.
declare global {
  interface Window {
    __patakha: unknown;
  }
}
window.__patakha = {
  app,
  stats: () => ({
    listening: document.documentElement.classList.contains('listening'),
    fast: app.session.meter.fast,
    leq: app.session.leq,
    seconds: app.session.duration,
    ...app.session.totals,
    logged: app.session.bursts.length,
  }),
};
