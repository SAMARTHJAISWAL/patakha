import '@fontsource/barlow/latin-400.css';
import '@fontsource/barlow/latin-500.css';
import '@fontsource/barlow/latin-600.css';
import '@fontsource/barlow-condensed/latin-600.css';
import '@fontsource/barlow-condensed/latin-700.css';
import '@fontsource/mukta/devanagari-600.css';
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
