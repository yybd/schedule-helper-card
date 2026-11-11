// The README screenshots, from the offline preview (the synthetic house, in English). Starts dev/serve.py itself
// when nothing is listening.
//
//   node dev/screenshots.mjs        (CHROME=/path/to/chrome to choose the browser)
//
// Each shot waits until the page is really drawn: plain `chrome --screenshot` often captures an empty page.

import { writeFileSync } from 'node:fs';
import { launchChrome, startServer, sleep } from './cdp.mjs';

const PORT = Number(process.env.PORT || 8766);
const BASE = `http://127.0.0.1:${PORT}/dev/card-preview.html?clean=1&`;
const CARDS = "!!document.getElementById('schedules')?.shadowRoot?.querySelector('.bars') && !!document.getElementById('shabbat')?.shadowRoot?.querySelector('.mode')";
const DIALOG = "!!document.getElementById('schedules')?.shadowRoot?.querySelector('dialog[open] .days')";
const q = (config) => encodeURIComponent(JSON.stringify(config));
const SHOTS = [
  ['card.png', 880, 1210, `lang=en&automations=on&demo=vacation&schedules=${q({ height: 'auto' })}&shabbat=${q({ height: 'auto' })}`, CARDS],
  ['editor.png', 760, 1000, `lang=en&automations=on&demo=vacation&open=schedule.balcony_light`, `${DIALOG} && !!document.getElementById('schedules').shadowRoot.querySelector('dialog .linked .opt')`],
  ['new-schedule.png', 760, 1000, `lang=en&automations=on&open=new&device=climate.living_room_ac`, `${DIALOG} && !!document.getElementById('schedules').shadowRoot.querySelector('dialog [data-field=useTemp]')`],
  ['dark-english.png', 880, 1000, `lang=en&automations=on&demo=vacation&theme=dark&schedules=${q({ height: 900 })}&shabbat=${q({ height: 900 })}`, CARDS],
  ['mobile.png', 390, 844, `lang=en&automations=on&demo=vacation&open=schedule.balcony_light`, DIALOG],
];

const stopServer = await startServer(PORT);
const page = await launchChrome();
try {
  for (const [file, width, height, query, ready] of SHOTS) {
    const ok = await page.open(BASE + query, { width, height, ready });
    await sleep(600);
    writeFileSync(new URL(`../docs/${file}`, import.meta.url), await page.screenshot());
    console.log(file, ok ? 'ready' : `NOT READY ${page.errors.join(' | ')}`);
  }
} finally {
  page.close();
  stopServer();
}
