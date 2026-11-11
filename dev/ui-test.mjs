// Browser tests: the cards in headless Chrome, on the offline preview (fake hass, synthetic house), clicked through
// the way a user would. Starts dev/serve.py itself when nothing is listening.
//
//   node dev/ui-test.mjs            (CHROME=/path/to/chrome to choose the browser)
//
// Exits non-zero when a check fails. Runs in CI next to the unit tests.

import { launchChrome, startServer } from './cdp.mjs';

const PORT = Number(process.env.PORT || 8766);
const BASE = `http://127.0.0.1:${PORT}/dev/card-preview.html?`;
const READY = "!!window.fake && !!document.getElementById('schedules')?.shadowRoot?.querySelector('.bars') && !!document.getElementById('shabbat')?.shadowRoot?.querySelector('.mode')";

// Helpers available inside every check.
const PRELUDE = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const S = () => document.getElementById('schedules').shadowRoot;
  const B = () => document.getElementById('shabbat').shadowRoot;
  const D = () => S().querySelector('dialog');
  const must = (cond, msg) => { if (!cond) throw new Error(msg); };
  const click = (el, what) => { must(el, 'missing: ' + what); el.click(); };
  const type = (el, v, what) => { must(el, 'missing: ' + what); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
  const toggle = (el, v, what) => { must(el, 'missing: ' + what); el.checked = v; el.dispatchEvent(new Event('change', { bubbles: true })); };
  const posts = () => fake.calls.filter((c) => c.method === 'POST');
  const openEditor = async (id) => { click(S().querySelector('.row[data-id="' + id + '"]'), id); await sleep(400); must(D(), 'no dialog'); };
  const addRange = async (day, from, to) => {
    click(D().querySelector('[data-act=add][data-day="' + day + '"]'), 'add ' + day);
    D().querySelector('#from').value = from;
    D().querySelector('#to').value = to;
    click(D().querySelector('[data-act=rangeOk]'), 'ok');
  };
  // Day names never run into the ranges beside them.
  const noOverlap = () => {
    const rtl = D().getAttribute('dir') === 'rtl';
    for (const line of D().querySelectorAll('.day-line')) {
      const name = line.querySelector('.dname').getBoundingClientRect();
      const ranges = line.querySelector('.ranges').getBoundingClientRect();
      must(rtl ? name.left >= ranges.right - 1 : name.right <= ranges.left + 1, 'day name overlaps: ' + line.querySelector('.dname').textContent);
    }
  };
`;

const CHECKS = [
  ['both cards render the house', '', `
    must(S().querySelectorAll('.row').length === 7, 'rows: ' + S().querySelectorAll('.row').length);
    must(S().querySelectorAll('.row .bars').length === 7, 'every schedule has its week, YAML too');
    must(S().querySelectorAll('.row[data-id]').length === 6, 'the YAML schedule is not editable');
    must([...S().querySelectorAll('.row')].some((r) => !r.dataset.id && r.textContent.includes('YAML')), 'the YAML schedule says so');
    must(!S().querySelector('.body .ic') && !B().querySelector('.body .ic'), 'no icons in the cards');
    must(B().querySelectorAll('.mode').length === 3, 'three modes');
    must([...B().querySelectorAll('.mode')].map((m) => m.classList[1]).join() === 'vacation,shabbat,chag', 'vacation first');
    must(B().querySelectorAll('[data-automode][value=auto]').length === 3, 'automatic vacation, Shabbat and chag');
    must(B().querySelector('.cal-date').textContent.includes('טבת'), 'calendar');
    // The calendar sits above Shabbat, below vacation.
    const order = [...B().querySelector('.scroll').children].map((el) => el.classList.contains('cal') ? 'cal' : el.classList[1]).filter(Boolean);
    must(order.join() === 'vacation,cal,shabbat,chag', 'order: ' + order.join());
    must(B().querySelector('h2').textContent === 'מצבים', 'title');
  `],
  ['the card types from before 2.0 still render', '', `
    for (const tag of ['beit-schedule-card', 'beit-shabbat-card']) {
      const el = document.createElement(tag);
      el.setConfig({});
      el.hass = fake.snapshot();
      document.body.appendChild(el);
      await sleep(300);
      must(el.shadowRoot?.querySelector(tag === 'beit-schedule-card' ? '.row' : '.mode'), tag + ' renders');
      el.remove();
    }
    must(!window.customCards.some((c) => c.type.startsWith('beit-')), 'old names are not offered in the picker');
  `],
  ['a non-admin sees everything, edits nothing', 'admin=0', `
    must(!S().querySelector('[data-act=new]'), 'no New schedule');
    must(S().querySelectorAll('.row[data-id]').length === 0, 'no editable rows');
    must(S().querySelectorAll('.row .bars').length === 7, 'weeks via get_schedule');
    must([...B().querySelectorAll('[data-automode]')].every((i) => i.disabled), 'automatic switches disabled');
    must(!B().querySelector('[data-act=members]'), 'no Choose automations');
  `],
  ['create a schedule: device, action, hours, mode', 'schedules=' + encodeURIComponent('{"show_modes":true}'), `
    click(S().querySelector('[data-act=new]'), 'new');
    await sleep(200);
    click(D().querySelector('[data-act=pick]'), 'pick');
    await sleep(500);
    click(D().querySelector('[data-act=domain][data-v=climate]'), 'type chip');
    must([...D().querySelectorAll('.pick')].every((b) => b.dataset.id.startsWith('climate.')), 'chip filters');
    click(D().querySelector('[data-id="climate.kids_ac"]'), 'device');
    click(D().querySelector('[data-act=hvac][data-v=heat]'), 'heat');
    toggle(D().querySelector('[data-field=useTemp]'), true, 'temp');
    click(D().querySelector('[data-act=mode][data-mode="חג"]'), 'chag');
    await addRange(4, '7', '0');
    must(D().querySelector('.range').textContent.trim() === '07:00–24:00', 'typed 7 and 0: ' + D().querySelector('.range')?.textContent);
    click(D().querySelector('[data-act=save]'), 'save');
    await sleep(1500);
    must(!D(), 'dialog closed');
    const create = fake.calls.find((c) => c.type === 'schedule/create');
    must(create && create.thursday[0].to === '24:00:00', 'schedule/create');
    const on = posts()[0].body.actions[0].choose[0].sequence[0];
    must(on.action === 'climate.set_temperature' && on.data.hvac_mode === 'heat' && on.data.temperature === 25, JSON.stringify(on));
    must(fake.entities['schedule.mzgn_yldym'].labels.includes('khg'), 'labelled chag');
    must(S().querySelector('.row[data-id="schedule.mzgn_yldym"]'), 'row appears');
  `],
  ['edit a schedule: rename and change what it does', '', `
    await openEditor('schedule.living_room_ac_shabbat');
    must(D().querySelector('.device'), 'What it does section');
    click(D().querySelector('[data-act=temp][data-v="-1"]'), 'minus');
    type(D().querySelector('#name'), 'מזגן סלון לשבת', 'name');
    click(D().querySelector('[data-act=save]'), 'save');
    await sleep(800);
    must(posts().length === 1, 'one rewrite: ' + posts().length);
    const p = posts()[0];
    must(p.path === 'config/automation/config/1767000000001', p.path);
    must(p.body.alias === 'Beit · מזגן סלון לשבת', p.body.alias);
    must(p.body.actions[0].choose[0].sequence[0].data.temperature === 23, 'temperature');
  `],
  ['a hand-edited automation is never rewritten', '', `
    await openEditor('schedule.balcony_light');
    must(!D().querySelector('.device'), 'no device section for a hand-written automation');
    click(D().querySelector('[data-act=save]'), 'save');
    await sleep(500);
    must(posts().length === 0, 'nothing rewritten');
  `],
  ['the editor opens on the week HA has now, not a stale copy', '', `
    // Someone adds a Tuesday range elsewhere; the schedule's state does not change, so the card is not told.
    fake._schedules = fake._schedules.map((x) => (x.id === 'hot_plate_shabbat' ? { ...x, tuesday: [{ from: '10:00:00', to: '11:00:00' }] } : x));
    await openEditor('schedule.hot_plate_shabbat');
    must([...D().querySelectorAll('.day')][2].querySelector('.range')?.textContent.trim() === '10:00–11:00', 'Tuesday from HA');
  `],
  ['the dialog cannot be closed while it saves', '', `
    await openEditor('schedule.hot_plate_shabbat');
    fake.stateDelay = 0;
    const slow = fake.callWS.bind(fake);
    fake.callWS = async (m) => { if (m.type === 'schedule/update') await sleep(400); return slow(m); };
    click(D().querySelector('[data-act=save]'), 'save');
    await sleep(50);
    must(D().querySelector('[data-act=close]').disabled, 'close disabled while saving');
    D().querySelector('[data-act=close]').click();
    must(D(), 'still open');
    await sleep(700);
    must(!D(), 'closes once saved');
  `],
  ['range times: 24-hour text, errors kept in place', '', `
    await openEditor('schedule.bedroom_ac_shabbat');
    must(D().querySelector('[data-act=add]'), 'editor');
    click(D().querySelector('[data-act=add][data-day="1"]'), 'add');
    must(D().querySelector('#from').type === 'text', 'a text field, not the browser clock');
    D().querySelector('#from').value = 'abc';
    click(D().querySelector('[data-act=rangeOk]'), 'ok');
    must(D().querySelector('.panel .error'), 'error shown');
    must(D().querySelector('#from').value === 'abc', 'what was typed is kept');
    D().querySelector('#from').value = '20';
    D().querySelector('#to').value = '19';
    click(D().querySelector('[data-act=rangeOk]'), 'ok');
    must(/לפני/.test(D().querySelector('.panel .error').textContent), 'reversed range');
  `],
  ['delete keeps hand-written automations and says so', '', `
    await openEditor('schedule.living_room_ac_shabbat');
    click(D().querySelector('[data-act=askDelete]'), 'delete');
    click(D().querySelector('[data-act=doDelete]'), 'confirm');
    await sleep(600);
    must(!fake.states['schedule.living_room_ac_shabbat'], 'schedule gone');
    must(!fake.states['automation.beit_living_room_ac_shabbat'], 'Beit automation gone');
    must(fake.states['automation.living_room_fan_shabbat'], 'hand-written one kept');
    const toasts = [...S().children].filter((c) => c.classList.contains('toast'));
    must(toasts.length === 1, 'one toast element: ' + toasts.length);
    must(!toasts[0].hidden && toasts[0].textContent.includes('מאוורר סלון בשבת'), 'kept list shown');
  `],
  ['day names fit, Hebrew', '', `
    await openEditor('schedule.bedroom_ac_shabbat');
    noOverlap();
  `],
  ['day names fit, English', 'lang=en', `
    await openEditor('schedule.bedroom_ac_shabbat');
    noOverlap();
  `],
  ['day names fit on a phone', 'lang=en&width=390', `
    await openEditor('schedule.bedroom_ac_shabbat');
    noOverlap();
  `],
  ['the mode switch turns every member on', '', `
    toggle(B().querySelector('[data-master="שבת"]'), true, 'master');
    await sleep(300);
    for (const id of ['automation.beit_bedroom_ac_shabbat', 'automation.beit_hot_plate_shabbat', 'automation.living_room_fan_shabbat']) {
      must(fake.states[id].state === 'on', id);
    }
  `],
  ['taking an automation out keeps a schedule another member follows', '', `
    click(B().querySelector('[data-act=members][data-mode="שבת"]'), 'Choose automations');
    await sleep(200);
    const dlg = B().querySelector('dialog');
    must(![...dlg.querySelectorAll('[data-id]')].some((b) => b.closest('label').textContent.includes('אוטומטי')), 'automatic ones are not offered');
    toggle(dlg.querySelector('[data-id="automation.living_room_fan_shabbat"]'), false, 'fan');
    await sleep(500);
    must(!fake.entities['automation.living_room_fan_shabbat'].labels.includes('shbt'), 'fan out');
    must(fake.entities['schedule.living_room_ac_shabbat'].labels.includes('shbt'), 'schedule still in the mode');
  `],
  ['automatic Shabbat: a start before candle lighting, off disables', '', `
    click(B().querySelector('[data-act=startEdit][data-mode="שבת"]'), 'change start');
    toggle(B().querySelector('[data-start-kind][value=hoursBefore]'), true, 'hours before');
    type(B().getElementById('start-hb'), '3', 'hours');
    click(B().querySelector('[data-act=startSave]'), 'save start');
    await sleep(100);
    toggle(B().querySelector('[data-automode="שבת"][value=auto]'), true, 'switch on');
    await sleep(1200);
    const p = posts().find((c) => c.body.alias === 'Beit · מצב שבת אוטומטי');
    must(p && p.body.triggers[0].at.offset === '-03:00:00', 'offset: ' + JSON.stringify(p?.body.triggers[0]));
    toggle(B().querySelector('[data-automode="שבת"][value=manual]'), true, 'switch off');
    await sleep(600);
    const id = Object.keys(fake.states).find((k) => fake.states[k].attributes.friendly_name === 'Beit · מצב שבת אוטומטי');
    must(id && fake.states[id].state === 'off', 'disabled, still there');
    must(!fake.calls.some((c) => c.method === 'DELETE'), 'never deleted');
  `],
  ['an automatic mode locks the switches; manual frees them', '', `
    const master = () => B().querySelector('[data-master="שבת"]');
    const memberSwitches = () => [...B().querySelectorAll('.mode.shabbat [data-auto]')];
    must(!master().disabled && memberSwitches().every((i) => !i.disabled), 'manual: switches free');
    toggle(B().querySelector('[data-automode="שבת"][value=auto]'), true, 'automatic Shabbat');
    await sleep(1200);
    must(B().querySelector('.next-line'), 'says when it comes on next');
    must(master().disabled, 'mode switch locked');
    must(memberSwitches().length && memberSwitches().every((i) => i.disabled), 'automation switches locked');
    toggle(B().querySelector('[data-automode="שבת"][value=manual]'), true, 'manual');
    await sleep(1200);
    must(!master().disabled && memberSwitches().every((i) => !i.disabled), 'free again');
  `],
  ['a Shabbat schedule that starts before the mode comes on is named', '', `
    click(B().querySelector('[data-act=startEdit][data-mode="שבת"]'), 'change start');
    type(B().getElementById('start-at'), '16:30', 'start');
    click(B().querySelector('[data-act=startSave]'), 'save start');
    await sleep(100);
    toggle(B().querySelector('[data-automode="שבת"][value=auto]'), true, 'automatic Shabbat');
    await sleep(1500);
    const warns = [...B().querySelectorAll('.auto .warn')].map((w) => w.textContent);
    must(warns.length === 2, 'two warnings: ' + JSON.stringify(warns));
    must(warns.some((w) => w.includes('15:00')) && warns.some((w) => w.includes('16:00')), 'hot plate and living room');
  `],
  ['automatic chag is created with the Jewish Calendar', '', `
    toggle(B().querySelector('[data-automode="חג"][value=auto]'), true, 'chag on');
    await sleep(1200);
    const p = posts().find((c) => c.body.alias === 'Beit · מצב חג אוטומטי');
    must(p, 'created');
    must(p.body.triggers[1].entity_id[0].startsWith('binary_sensor.jewish_calendar_issur_melacha'), 'ends with issur melacha');
    must(B().querySelector('[data-automode="חג"][value=auto]').checked, 'shown on');
  `],
  ['by default the schedules card shows Shabbat and chag only in a home that has their labels', '', `
    // This house has both labels: shown.
    must(S().querySelector('.list .chip'), 'mode chips');
    // A house with neither: left out.
    const { FakeHass } = await import('../tests/fake-hass.mjs');
    const names = ['states', 'schedule_list', 'automation_configs', 'label_registry', 'entity_registry_display', 'area_registry', 'device_registry', 'yaml_schedules'];
    const fx = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await (await fetch('../tests/fixtures/' + n + '.json')).json()])));
    const bare = new FakeHass({ ...fx, label_registry: [] }, { language: 'en' });
    const card = document.createElement('schedule-helper-card');
    card.setConfig({});
    document.body.appendChild(card);
    card.hass = bare.snapshot();
    await sleep(500);
    must(card.shadowRoot.querySelector('.row') && !card.shadowRoot.querySelector('.list .chip'), 'no mode chips without labels');
    card.remove();
  `],
  ['show_modes: false hides Shabbat and chag even where the labels exist', 'schedules=' + encodeURIComponent('{"show_modes":false}'), `
    must(!S().querySelector('.list .chip'), 'no mode chips');
    await openEditor('schedule.bedroom_ac_shabbat');
    must(!D().querySelector('.seg'), 'no mode choice');
  `],
  ['show_modes: true shows the mode chips and the mode choice', 'schedules=' + encodeURIComponent('{"show_modes":true}'), `
    must(S().querySelector('.list .chip'), 'mode chips');
    await openEditor('schedule.bedroom_ac_shabbat');
    must(D().querySelector('.seg'), 'mode choice');
  `],
  ['no height set: the card grows up to 700px, then scrolls', '', `
    const card = S().querySelector('ha-card');
    must(Math.round(card.getBoundingClientRect().height) === 700, 'height ' + card.getBoundingClientRect().height);
  `],
  ['a fixed height scrolls inside the card', 'schedules=' + encodeURIComponent('{"height":"400px"}'), `
    const card = S().querySelector('ha-card');
    must(Math.round(card.getBoundingClientRect().height) === 400, 'height ' + card.getBoundingClientRect().height);
    const sc = S().querySelector('.scroll');
    must(sc.scrollHeight > sc.clientHeight && getComputedStyle(sc).overflowY === 'auto', 'scrolls');
  `],
  ['the visual editor creates the Schedule Helper dashboard, once', 'editors=1', `
    const ed = document.querySelector('schedule-helper-card-editor').shadowRoot;
    await sleep(200);
    click(ed.querySelector('[data-act=makeDash]'), 'create button');
    await sleep(300);
    must(fake._dashboards.some((d) => d.url_path === 'schedule-helper'), 'dashboard created');
    must(fake._lovelace['schedule-helper'].views[0].cards.length === 2, 'with both cards');
    must(ed.querySelector('[data-dash] a[href="/schedule-helper"]'), 'Open link');
    must(!ed.querySelector('[data-act=makeDash]'), 'no second button');
  `],
  ['a non-admin editor offers no dashboard', 'editors=1&admin=0', `
    await sleep(300);
    must(document.querySelector('schedule-helper-card-editor').shadowRoot.querySelector('[data-dash]').hidden, 'hidden');
  `],
  ['the visual editor limits device types', 'editors=1', `
    const ed = document.querySelector('schedule-helper-card-editor').shadowRoot;
    toggle(ed.querySelector('[data-domain=climate]'), false, 'climate');
    await sleep(100);
    click(S().querySelector('[data-act=new]'), 'new');
    await sleep(200);
    click(D().querySelector('[data-act=pick]'), 'pick');
    await sleep(500);
    must(![...D().querySelectorAll('.pick')].some((b) => b.dataset.id.startsWith('climate.')), 'no air conditioners offered');
  `],
  ['hours changed elsewhere show up, even when the state does not change', '', `
    // HA's own editor (or another device) changes Saturday only: same state, same next_event, so no state change.
    const item = fake._schedules.find((s) => s.id === 'water_heater_weekdays');
    const week = Object.fromEntries(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((d) => [d, item[d] || []]));
    const row = () => S().querySelector('.row[data-id="schedule.water_heater_weekdays"] .bars').innerHTML;
    const before = row();
    const elsewhere = (saturday) => fake.callWS({ type: 'schedule/update', schedule_id: item.id, name: item.name, ...week, saturday });
    await elsewhere([{ from: '10:00:00', to: '20:00:00' }]);
    await sleep(600);
    must(row() !== before, 'the week on the card follows');
    // With the editor open, it says so instead of silently saving over it.
    await openEditor('schedule.water_heater_weekdays');
    must(!D().querySelector('[data-act=reloadRemote]'), 'no warning yet');
    await elsewhere([{ from: '09:00:00', to: '11:00:00' }]);
    await sleep(400);
    click(D().querySelector('[data-act=reloadRemote]'), 'load the new version');
    await sleep(100);
    must(!D().querySelector('[data-act=reloadRemote]'), 'warning gone');
    click(D().querySelector('[data-act=save]'), 'save');
    await sleep(800);
    must(fake._schedules.find((s) => s.id === item.id).saturday[0].from === '09:00:00', 'their version kept');
  `],
  ['an automatic mode edited in HA shows its new start', '', `
    toggle(B().querySelector('[data-automode="שבת"][value=auto]'), true, 'automatic Shabbat');
    await sleep(1500);
    const st = Object.values(fake.snapshot().states).find((e) => e.attributes?.friendly_name === 'Beit · מצב שבת אוטומטי');
    const cfg = (await fake.callWS({ type: 'automation/config', entity_id: st.entity_id })).config;
    const next = { ...cfg, triggers: cfg.triggers.map((t) => (t.id === 'erev_shabbat' ? { ...t, at: '14:30:00' } : t)) };
    await fake.callApi('POST', 'config/automation/config/' + cfg.id, next);
    await sleep(1200);
    must(B().querySelector('.start-line').textContent.includes('14:30'), 'start shown: ' + B().querySelector('.start-line').textContent);
  `],
  ['an automation edited by hand after the editor opened is not saved over', '', `
    await openEditor('schedule.living_room_ac_shabbat');
    await sleep(400);
    const id = 'automation.beit_living_room_ac_shabbat';
    const cfg = (await fake.callWS({ type: 'automation/config', entity_id: id })).config;
    await fake.callApi('POST', 'config/automation/config/' + cfg.id, { ...cfg, mode: 'restart' }); // by hand, in HA
    toggle(D().querySelector('[data-field=turnOff]'), false, 'turn off at the end');
    click(D().querySelector('[data-act=save]'), 'save');
    await sleep(800);
    const after = (await fake.callWS({ type: 'automation/config', entity_id: id })).config;
    must(after.mode === 'restart', 'the hand edit is kept');
    must(D()?.querySelector('.error'), 'the dialog says why');
  `],
  ['a schedule whose automations are all off says it will not run', 'lang=en', `
    await sleep(500);
    const state = (id) => S().querySelector('.row[data-id="' + id + '"] .state')?.textContent;
    must(state('schedule.bedroom_ac_shabbat') === 'Automation off', 'bedroom: ' + state('schedule.bedroom_ac_shabbat'));
    click(B().querySelector('[data-auto="automation.beit_bedroom_ac_shabbat"]'), 'switch it on');
    await sleep(600);
    must(state('schedule.bedroom_ac_shabbat') === 'Off', 'back to its own state: ' + state('schedule.bedroom_ac_shabbat'));
    // Without search/related, a schedule in a mode that is off says so.
    const callWS = fake.callWS.bind(fake);
    fake.callWS = (m) => (m.type === 'search/related' && m.item_type === 'entity' ? Promise.reject({ code: 'unauthorized', message: 'no' }) : callWS(m));
    const card = document.createElement('schedule-helper-card');
    card.setConfig({});
    document.body.appendChild(card);
    card.hass = fake.snapshot();
    await sleep(800);
    const chag = [...card.shadowRoot.querySelectorAll('.row')].find((r) => r.textContent.includes('Kids AC afternoons'));
    must(chag?.querySelector('.state').textContent === 'Chag mode off', 'fallback: ' + chag?.querySelector('.state').textContent);
    card.remove();
    fake.callWS = callWS;
  `],
  ['a schedule nothing uses gets a device, and the card writes its automation in its mode', 'lang=en', `
    const days = Object.fromEntries(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((d) => [d, []]));
    await fake.callWS({ type: 'schedule/create', name: 'Garden lights', ...days, friday: [{ from: '18:00:00', to: '22:00:00' }] });
    await sleep(1200);
    // It is a Shabbat schedule already (its label), with no automation.
    const labels = (await fake.callWS({ type: 'config/label_registry/list' }));
    const shbt = labels.find((l) => l.name === 'שבת').label_id;
    await fake.callWS({ type: 'config/entity_registry/update', entity_id: 'schedule.garden_lights', labels: [shbt] });
    await sleep(600);
    must(S().querySelector('.row[data-id="schedule.garden_lights"] .state').textContent === 'No automation', 'no automation yet');
    await openEditor('schedule.garden_lights');
    await sleep(300);
    click(D().querySelector('[data-act=pick]'), 'choose a device');
    await sleep(600);
    click(D().querySelector('[data-act=choose][data-id="light.balcony"]'), 'balcony light');
    click(D().querySelector('[data-act=save]'), 'save');
    await sleep(1500);
    const post = fake.calls.filter((c) => c.method === 'POST').at(-1);
    must(post?.body?.triggers?.[0]?.entity_id?.[0] === 'schedule.garden_lights', 'automation for the schedule');
    const auto = Object.values(fake.snapshot().states).find((e) => e.attributes?.id === post.path.split('/').pop());
    const reg = await fake.callWS({ type: 'config/entity_registry/get', entity_id: auto.entity_id });
    must(reg.labels.includes(shbt), 'the automation joined Shabbat mode');
    must(S().querySelector('.row[data-id="schedule.garden_lights"] .state').textContent !== 'No automation', 'the row knows');
  `],
  ['a device added to a schedule is not added twice when a later step fails', 'lang=en', `
    const days = Object.fromEntries(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((d) => [d, []]));
    await fake.callWS({ type: 'schedule/create', name: 'Porch', ...days, friday: [{ from: '18:00:00', to: '22:00:00' }] });
    await sleep(1200);
    const shbt = (await fake.callWS({ type: 'config/label_registry/list' })).find((l) => l.name === 'שבת').label_id;
    await fake.callWS({ type: 'config/entity_registry/update', entity_id: 'schedule.porch', labels: [shbt] });
    await sleep(1200);
    await openEditor('schedule.porch');
    await sleep(300);
    click(D().querySelector('[data-act=pick]'), 'choose a device');
    await sleep(600);
    click(D().querySelector('[data-act=choose][data-id="light.balcony"]'), 'balcony light');
    fake.failNext('config/entity_registry/update', 'Nope');
    click(D().querySelector('[data-act=save]'), 'save');
    await sleep(1500);
    must(!D(), 'the dialog closed, so it cannot be saved again');
    const driving = fake.calls.filter((c) => c.method === 'POST' && c.body?.triggers?.[0]?.entity_id?.[0] === 'schedule.porch');
    must(driving.length === 1, 'one automation: ' + driving.length);
  `],
  ['Save with a range panel open keeps the typed range, and drops an untouched one', 'lang=en', `
    await openEditor('schedule.water_heater_weekdays');
    click(D().querySelector('[data-act=add][data-day="6"]'), 'add Saturday');
    D().querySelector('#from').value = '18:00';
    D().querySelector('#to').value = '22:00';
    click(D().querySelector('[data-act=save]'), 'save');
    await sleep(800);
    const item = () => fake._schedules.find((x) => x.id === 'water_heater_weekdays');
    must(item().saturday?.[0]?.from === '18:00:00', 'typed range saved: ' + JSON.stringify(item().saturday));
    await openEditor('schedule.water_heater_weekdays');
    click(D().querySelector('[data-act=add][data-day="5"]'), 'add Friday, left as it opened');
    click(D().querySelector('[data-act=save]'), 'save');
    await sleep(800);
    must(!(item().friday || []).length, 'untouched panel not saved: ' + JSON.stringify(item().friday));
  `],
  ['automatic: the choice shows at once, the switches follow the calendar, the editor locks them', 'lang=en', `
    const apply = fake._setState.bind(fake);
    const radio = () => B().querySelector('[data-automode="שבת"][value=auto]');
    toggle(radio(), true, 'automatic');
    await sleep(30);
    must(radio().checked, 'shown as chosen while it is written');
    await sleep(1500);
    // A Sunday: outside Shabbat, so every Shabbat automation is off now.
    const members = Object.keys(fake.entities).filter((id) => id.startsWith('automation.') && fake.entities[id].labels?.includes('shbt'))
      .filter((id) => fake.states[id]?.attributes.friendly_name !== 'Beit · מצב שבת אוטומטי');
    must(members.length && members.every((id) => fake.states[id].state === 'off'), 'members off: ' + members.map((id) => fake.states[id].state));
    await openEditor('schedule.living_room_ac_shabbat');
    await sleep(500);
    const sw = D().querySelector('[data-field=auto]');
    must(sw && sw.disabled, 'locked in the editor too');
  `],
  ['a non-admin can go manual from an automatic mode', '', `
    toggle(B().querySelector('[data-automode="שבת"][value=auto]'), true, 'automatic (admin)');
    await sleep(1500);
    const card = document.createElement('schedule-helper-shabbat-card');
    card.setConfig({});
    document.body.appendChild(card);
    card.hass = { ...fake.snapshot(), user: { is_admin: false } };
    await sleep(800);
    const r = card.shadowRoot;
    must(!r.querySelector('[data-automode="שבת"][value=manual]').disabled, 'manual can be chosen');
    must(!r.querySelector('.next-line'), 'no start shown that it cannot read');
    card.remove();
  `],
  ['a reconnect that sends the list again is not a change made elsewhere', 'lang=en', `
    await openEditor('schedule.water_heater_weekdays');
    click(D().querySelector('[data-act=add][data-day="6"]'), 'add Saturday');
    D().querySelector('#from').value = '18:00';
    D().querySelector('#to').value = '22:00';
    click(D().querySelector('[data-act=rangeOk]'), 'ok');
    await sleep(100);
    // What home-assistant-js-websocket does after a reconnect: the whole collection again, as "added".
    for (const item of fake._schedules) fake._scheduleChanged('added', item);
    await sleep(400);
    must(!D().querySelector('[data-act=reloadRemote]'), 'no banner');
    must(D().querySelector('[data-act=edit][data-day="6"]'), 'the local edit is still there');
  `],
  ['a closed range panel hands the focus back to its day', 'lang=en', `
    await openEditor('schedule.water_heater_weekdays');
    const active = () => D().getRootNode().activeElement;
    click(D().querySelector('[data-act=add][data-day="2"]'), 'add Tuesday');
    await sleep(50);
    click(D().querySelector('[data-act=rangeCancel]'), 'cancel');
    await sleep(50);
    must(active()?.dataset?.focus === 'add-2', 'focus on add: ' + active()?.outerHTML?.slice(0, 80));
    click(D().querySelector('[data-act=add][data-day="2"]'), 'add Tuesday');
    D().querySelector('#from').value = '20:00';
    D().querySelector('#to').value = '21:00';
    click(D().querySelector('[data-act=rangeOk]'), 'ok');
    await sleep(50);
    must(active()?.dataset?.focus === 'add-2', 'focus after OK');
  `],
  ['typing a start time keeps the caret through a redraw', '', `
    click(B().querySelector('[data-act=startEdit][data-mode="שבת"]'), 'change start');
    const f = B().getElementById('start-at');
    f.focus();
    f.value = '13:4';
    f.dispatchEvent(new Event('input', { bubbles: true }));
    f.setSelectionRange(4, 4);
    B().host._render(true);
    const g = B().getElementById('start-at');
    must(g.selectionStart === 4 && g.value === '13:4', 'caret ' + g.selectionStart + ' in ' + g.value);
  `],
  ['a renamed automatic automation is not offered as a member', '', `
    toggle(B().querySelector('[data-automode="שבת"][value=auto]'), true, 'automatic Shabbat');
    await sleep(1500);
    const id = Object.keys(fake.states).find((k) => fake.states[k].attributes.friendly_name === 'Beit · מצב שבת אוטומטי');
    fake._setState(id, { ...fake.states[id], attributes: { ...fake.states[id].attributes, friendly_name: 'Our Shabbat' } });
    await sleep(600);
    click(B().querySelector('[data-act=members][data-mode="שבת"]'), 'choose automations');
    await sleep(400);
    const dlg = B().querySelector('dialog');
    must(dlg && dlg.querySelectorAll('[data-id]').length, 'the list');
    must(!dlg.querySelector('[data-id="' + id + '"]'), 'not offered');
  `],
  ['a flipped switch stays put until HA catches up, and goes back if the call fails', '', `
    // In HA the state change arrives after the service call returns; the fake applies it at once unless told otherwise.
    const apply = fake._setState.bind(fake);
    fake._setState = (id, st) => setTimeout(() => apply(id, st), 400);
    const watch = async (sel) => {
      const from = B().querySelector(sel).checked;
      click(B().querySelector(sel), sel);
      for (let i = 0; i < 8; i++) {
        must(B().querySelector(sel).checked === !from, sel + ' jumped back after ' + i * 80 + ' ms');
        await sleep(80);
      }
    };
    await watch('[data-auto]');
    await watch('.mode.shabbat [data-master]');
    fake.failNext('automation.turn_on', 'Nope');
    fake.failNext('automation.turn_off', 'Nope');
    const sw = B().querySelector('[data-auto]');
    const was = sw.checked;
    click(sw, 'member');
    await sleep(200);
    must(B().querySelector('[data-auto]').checked === was, 'a failed call leaves the switch where HA has it');
  `],
  // ---- vacation (2.5) ----
  ['automatic vacation: dates in a panel, then one automation; the switches lock; manual disables it', 'lang=en', `
    // Two automations in vacation mode first, so it has members to switch.
    await fake.callWS({ type: 'config/label_registry/create', name: 'Vacation', icon: 'mdi:airplane', color: 'teal' });
    const vac = fake._labels.find((l) => l.name === 'Vacation').label_id;
    for (const id of ['automation.beit_water_heater_weekdays', 'schedule.water_heater_weekdays']) {
      await fake.callWS({ type: 'config/entity_registry/update', entity_id: id, labels: [...(fake.entities[id]?.labels || []), vac] });
    }
    await sleep(600);
    const sec = () => B().querySelector('.mode.vacation');
    must(sec().querySelector('[data-auto="automation.beit_water_heater_weekdays"]'), 'member listed');
    must(!sec().querySelector('.cal'), 'no Jewish calendar inside vacation');
    toggle(sec().querySelector('[data-automode=vacation][value=auto]'), true, 'automatic');
    await sleep(200);
    must(B().querySelector('.vacation-panel'), 'the dates panel opens');
    must(sec().querySelector('[data-automode=vacation][value=auto]').checked, 'Automatic shown while choosing dates');
    must(!posts().length, 'nothing written before Save');
    // The end before the start: refused, nothing written.
    type(B().querySelector('#vac-from'), '2030-07-08T08:00', 'from');
    type(B().querySelector('#vac-to'), '2030-07-01T18:00', 'to');
    click(B().querySelector('[data-act=startSave]'), 'save');
    await sleep(300);
    must(/after the start/.test(B().querySelector('.vacation-panel .error')?.textContent || ''), 'order error');
    must(!posts().length, 'still nothing written');
    type(B().querySelector('#vac-from'), '2030-07-01T08:00', 'from');
    type(B().querySelector('#vac-to'), '2030-07-08T18:30', 'to');
    click(B().querySelector('[data-act=startSave]'), 'save');
    await sleep(1200);
    const p = posts().find((c) => c.body.alias === 'Beit · Automatic vacation');
    must(p, 'created');
    must(p.body.variables.vacation_from === '2030-07-01 08:00' && p.body.variables.vacation_to === '2030-07-08 18:30', 'dates ' + JSON.stringify(p.body.variables));
    must(posts().filter((c) => c.body.alias === 'Beit · Automatic vacation').length === 1, 'one automation');
    must(!B().querySelector('.vacation-panel'), 'panel closed');
    must(/Vacation: .*1 Jul.* – .*8 Jul/.test(sec().textContent), 'dates shown: ' + sec().querySelector('.auto').textContent.replace(/\s+/g, ' '));
    must(/Comes on/.test(sec().textContent), 'next start');
    must(fake.states['automation.beit_water_heater_weekdays'].state === 'off', 'before the trip its members are off');
    must(sec().querySelector('[data-master]').disabled && sec().querySelector('[data-auto]').disabled, 'switches locked');
    // Change the dates: the same automation is rewritten.
    click(sec().querySelector('[data-act=startEdit]'), 'change');
    await sleep(200);
    must(B().querySelector('#vac-from').value === '2030-07-01T08:00', 'panel opens with the current dates');
    type(B().querySelector('#vac-to'), '2030-07-10T12:00', 'to');
    click(B().querySelector('[data-act=startSave]'), 'save');
    await sleep(1000);
    const again = posts().filter((c) => c.body.alias === 'Beit · Automatic vacation');
    must(again.length === 2 && again[1].body.id === again[0].body.id && again[1].body.variables.vacation_to === '2030-07-10 12:00', 'rewritten in place');
    // Manual: the automation is disabled, never deleted.
    toggle(sec().querySelector('[data-automode=vacation][value=manual]'), true, 'manual');
    await sleep(800);
    const autoId = Object.values(fake.states).find((e) => e.attributes?.friendly_name === 'Beit · Automatic vacation').entity_id;
    must(fake.states[autoId].state === 'off', 'disabled');
    must(!fake.calls.some((c) => c.method === 'DELETE'), 'not deleted');
    must(!sec().querySelector('[data-master]').disabled, 'unlocked');
  `],
  ['cancelling the vacation panel goes back to Manual and writes nothing', 'lang=en', `
    const sec = () => B().querySelector('.mode.vacation');
    toggle(sec().querySelector('[data-automode=vacation][value=auto]'), true, 'automatic');
    await sleep(200);
    click(B().querySelector('.vacation-panel [data-act=startCancel]'), 'cancel');
    await sleep(200);
    must(!B().querySelector('.vacation-panel'), 'closed');
    must(sec().querySelector('[data-automode=vacation][value=manual]').checked, 'manual again');
    must(!posts().length, 'nothing written');
  `],
  ['a non-admin cannot choose automatic vacation (it needs dates written)', 'admin=0', `
    must(B().querySelector('[data-automode=vacation][value=auto]').disabled, 'disabled');
  `],
  ['a new schedule in vacation mode creates the label in the user language', 'schedules=' + encodeURIComponent('{}'), `
    click(S().querySelector('[data-act=new]'), 'new');
    await sleep(200);
    const seg = [...D().querySelectorAll('[data-act=mode]')].map((b) => b.textContent.trim());
    must(seg.join() === 'רגיל,חופשה,שבת,חג', 'choices ' + seg.join());
    click(D().querySelector('[data-act=pick]'), 'pick');
    await sleep(500);
    click(D().querySelector('[data-id="media_player.kitchen_speaker"]'), 'a speaker');
    await sleep(100);
    click(D().querySelector('[data-act=mode][data-mode=vacation]'), 'vacation');
    must(/מכרטיס "מצבים"/.test(D().textContent), 'hint names the Modes card');
    await addRange(1, '07:00', '08:00');
    click(D().querySelector('[data-act=save]'), 'save');
    await sleep(1500);
    must(!D(), 'closed');
    const label = fake._labels.find((l) => l.name === 'חופשה');
    must(label && label.icon === 'mdi:airplane', 'label created');
    const sched = Object.keys(fake.states).find((id) => id.startsWith('schedule.') && fake.entities[id]?.labels?.includes(label.label_id));
    must(sched, 'schedule in vacation');
    await sleep(500);
    must([...S().querySelectorAll('.chip.vacation')].length === 1, 'vacation chip on the row');
    must(B().querySelector('.mode.vacation .sched'), 'listed under vacation in the Modes card');
  `],
  ['a home without Shabbat or chag: vacation only, no calendar', '', `
    const { FakeHass } = await import('../tests/fake-hass.mjs');
    const names = ['states', 'schedule_list', 'automation_configs', 'label_registry', 'entity_registry_display', 'area_registry', 'device_registry', 'yaml_schedules'];
    const fx = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await (await fetch('../tests/fixtures/' + n + '.json')).json()])));
    const plain = new FakeHass({ ...fx, label_registry: [], states: fx.states.filter((s) => !/jewish_calendar|hebcal/.test(s.entity_id)) }, { language: 'en' });
    const modes = document.createElement('schedule-helper-modes-card');
    modes.setConfig({});
    document.body.appendChild(modes);
    modes.hass = plain.snapshot();
    const sched = document.createElement('schedule-helper-card');
    sched.setConfig({});
    document.body.appendChild(sched);
    sched.hass = plain.snapshot();
    await sleep(700);
    const kinds = [...modes.shadowRoot.querySelectorAll('.mode')].map((m) => m.classList[1]);
    must(kinds.join() === 'vacation', 'modes: ' + kinds.join());
    must(!modes.shadowRoot.querySelector('.cal'), 'no calendar');
    must(modes.shadowRoot.querySelector('h2').textContent === 'Modes', 'title');
    sched.shadowRoot.querySelector('.row[data-id]').click();
    await sleep(500);
    const seg = [...sched.shadowRoot.querySelectorAll('dialog [data-act=mode]')].map((b) => b.textContent.trim());
    must(seg.join() === 'Regular,Vacation', 'choices ' + seg.join());
    sched.shadowRoot.querySelector('dialog').close();
    modes.remove();
    sched.remove();
  `],
  ['the Shabbat card type is unchanged: Shabbat and chag, its own title', '', `
    const el = document.createElement('schedule-helper-shabbat-card');
    el.setConfig({});
    document.body.appendChild(el);
    el.hass = fake.snapshot();
    await sleep(500);
    must([...el.shadowRoot.querySelectorAll('.mode')].map((m) => m.classList[1]).join() === 'shabbat,chag', 'modes');
    must(el.shadowRoot.querySelector('h2').textContent === 'שבת וחג', 'title');
    must(el.shadowRoot.querySelector('.cal'), 'calendar');
    must(window.customCards.some((c) => c.type === 'schedule-helper-modes-card'), 'Modes card offered');
    must(!window.customCards.some((c) => c.type === 'schedule-helper-shabbat-card'), 'Shabbat card no longer offered');
    el.remove();
  `],
  ['the Modes card shows vacation alone by default; Shabbat and chag are ticked on in its editor', '', `
    const card = document.createElement('schedule-helper-modes-card');
    card.setConfig({});
    document.body.appendChild(card);
    card.hass = fake.snapshot();
    await sleep(500);
    must([...card.shadowRoot.querySelectorAll('.mode')].map((m) => m.classList[1]).join() === 'vacation', 'vacation only, even in a home with Shabbat');
    must(!card.shadowRoot.querySelector('.cal'), 'no calendar');
    const ed = document.createElement('schedule-helper-modes-card-editor');
    ed.hass = fake.snapshot();
    ed.setConfig({});
    document.body.appendChild(ed);
    let emitted = null;
    ed.addEventListener('config-changed', (e) => { emitted = e.detail.config; card.setConfig(emitted); ed.setConfig(emitted); });
    await sleep(200);
    const box = (m) => ed.shadowRoot.querySelector('[data-mode="' + m + '"]');
    must(box('vacation').checked && !box('שבת').checked && !box('חג').checked, 'editor: vacation only');
    must(!ed.shadowRoot.querySelector('[data-bool=show_calendar]'), 'no calendar option yet');
    toggle(box('שבת'), true, 'Shabbat on');
    await sleep(500);
    must(JSON.stringify(emitted.modes) === JSON.stringify(['vacation', 'שבת']), 'config ' + JSON.stringify(emitted));
    must([...card.shadowRoot.querySelectorAll('.mode')].map((m) => m.classList[1]).join() === 'vacation,shabbat', 'card follows');
    must(card.shadowRoot.querySelector('.cal'), 'calendar above Shabbat');
    must(ed.shadowRoot.querySelector('[data-bool=show_calendar]'), 'calendar option appears');
    toggle(box('שבת'), false, 'Shabbat off');
    await sleep(300);
    must(!('modes' in emitted), 'back to the default: no modes line');
    card.remove();
    ed.remove();
  `],
  ['the Modes card editor lists vacation first; unticking writes the list', 'editors=1', `
    const ed = document.querySelectorAll('ha-card > *')[1];
    await sleep(300);
    const boxes = [...ed.shadowRoot.querySelectorAll('[data-mode]')];
    must(boxes.map((b) => b.dataset.mode).join() === 'vacation,שבת,חג', 'order');
    must(boxes.every((b) => b.checked), 'all on in this home');
    toggle(boxes[2], false, 'chag off');
    await sleep(300);
    must([...B().querySelectorAll('.mode')].map((m) => m.classList[1]).join() === 'vacation,shabbat', 'card follows');
  `],
];

const stopServer = await startServer(PORT);
const page = await launchChrome();
let failed = 0;
try {
  for (const [name, query, body] of CHECKS) {
    const width = Number(new URLSearchParams(query).get('width')) || 1000;
    try {
      if (!(await page.open(BASE + query, { width, height: 900, ready: READY }))) {
        throw new Error(`page not ready: ${page.errors.join(' | ') || 'no error reported'}`);
      }
      await page.eval(`(async () => { ${PRELUDE}\n${body}\n })()`);
      console.log(`✔ ${name}`);
    } catch (err) {
      failed++;
      console.log(`✖ ${name}\n    ${String(err.message).split('\n')[0]}`);
    }
  }
} finally {
  page.close();
  stopServer();
}
console.log(`\n${CHECKS.length - failed}/${CHECKS.length} passed`);
process.exitCode = failed ? 1 : 0;
