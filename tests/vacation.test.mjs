// Modes in general, and vacation: the mode every home has (contract §3b).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FakeHass } from './fake-hass.mjs';
import {
  MODES, JEWISH_MODES, MODE_DEFS, modeKey, modeLabel, modeClass, ensureLabel, setModeMembership, modeMembers, loadRegistry,
  buildVacationAutomation, parseVacationAutomation, vacationPhase, vacationRangeError, localStamp, parseStamp,
  enableAuto, disableAuto, findAuto, alignWithMode, modeOutsideNow, hasModeLabels, keepsJewishModes, autoAvailable,
  AUTO_ALIAS, BEIT_MARKER, isAutoAlias, formatDateTime, dashboardConfig, upgradeAuto, deviceSections, buildScheduleAutomation,
  actionSummary, setModeEnabled, createScheduleWithAutomation, WeekSchedule,
} from '../dist/schedule-helper-card.js';

// Loaded here rather than imported from ops.test.mjs, which would run its tests a second time.
const NAMES = ['states', 'schedule_list', 'automation_configs', 'label_registry', 'entity_registry_display', 'area_registry', 'device_registry', 'yaml_schedules'];
const fixtures = Object.fromEntries(NAMES.map((n) => [n, JSON.parse(readFileSync(new URL(`fixtures/${n}.json`, import.meta.url)))]));

const FAST = { waitOptions: { tries: 20, every: 5 } };
const house = (opts = {}) => new FakeHass(fixtures, opts);
// Far enough ahead that "the end has passed" never trips while these tests are in use.
const TRIP = { from: '2030-07-01 08:00', to: '2030-07-08 18:30' };

// ---- the general mode model ----------------------------------------------------------------------------------------

test('vacation comes first; Shabbat and chag are the Jewish modes', () => {
  assert.deepEqual(MODES, ['vacation', 'שבת', 'חג']);
  assert.deepEqual(JEWISH_MODES, ['שבת', 'חג']);
  assert.deepEqual([MODE_DEFS.vacation.icon, MODE_DEFS.vacation.color], ['mdi:airplane', 'teal']);
  assert.deepEqual(MODES.map(modeClass), ['vacation', 'shabbat', 'chag']);
});

test('modeKey accepts keys, label names and Latin aliases', () => {
  for (const [given, key] of [['vacation', 'vacation'], ['Vacation', 'vacation'], ['חופשה', 'vacation'], ['VACATION', 'vacation'],
    ['שבת', 'שבת'], ['shabbat', 'שבת'], ['Shabbat', 'שבת'], ['חג', 'חג'], ['chag', 'חג'], [' חג ', 'חג']]) {
    assert.equal(modeKey(given), key, given);
  }
  assert.equal(modeKey('energy'), null);
  assert.equal(modeKey(null), null);
});

test('modeLabel finds the vacation label by either name, Shabbat and chag by theirs', () => {
  const labels = [{ label_id: 'a', name: 'חופשה' }, { label_id: 'b', name: 'שבת' }, { label_id: 'c', name: 'energy' }];
  assert.equal(modeLabel(labels, 'vacation').label_id, 'a');
  assert.equal(modeLabel({ labels }, 'Vacation').label_id, 'a');
  assert.equal(modeLabel([{ label_id: 'x', name: 'Vacation' }], 'vacation').label_id, 'x');
  assert.equal(modeLabel(labels, 'שבת').label_id, 'b');
  assert.equal(modeLabel(labels, 'חג'), null);
  assert.equal(modeLabel(labels, 'energy').label_id, 'c', 'any other label still by its own name');
});

test('ensureLabel creates the vacation label once, named in the user language', async () => {
  const he = house({ language: 'he' });
  const label = await ensureLabel(he, 'vacation');
  assert.deepEqual([label.name, label.icon, label.color], ['חופשה', 'mdi:airplane', 'teal']);
  assert.equal((await ensureLabel(he, 'vacation')).label_id, label.label_id);
  assert.equal(he.calls.filter((c) => c.type === 'config/label_registry/create').length, 1);
  const en = house({ language: 'en' });
  assert.equal((await ensureLabel(en, 'vacation')).name, 'Vacation');
  // An English label is found from a Hebrew profile: never a second label for the same mode.
  const mixed = new FakeHass({ ...fixtures, label_registry: [...fixtures.label_registry, { label_id: 'vac', name: 'Vacation' }] }, { language: 'he' });
  assert.equal((await ensureLabel(mixed, 'vacation')).label_id, 'vac');
  assert.ok(!mixed.calls.some((c) => c.type === 'config/label_registry/create'));
});

test('membership works the same for vacation: label merged in, members found', async () => {
  const hass = house();
  await setModeMembership(hass, 'vacation', ['automation.beit_water_heater_weekdays', 'schedule.water_heater_weekdays'], true);
  const reg = await loadRegistry(hass);
  assert.deepEqual(modeMembers(hass.states, reg, 'vacation').map((e) => e.entity_id), ['automation.beit_water_heater_weekdays']);
  assert.deepEqual(modeMembers(hass.states, reg, 'vacation', 'schedule').map((e) => e.entity_id), ['schedule.water_heater_weekdays']);
  await setModeMembership(hass, 'vacation', ['automation.beit_water_heater_weekdays'], false);
  assert.equal(modeMembers(hass.states, await loadRegistry(hass), 'vacation').length, 0);
});

test('a home "uses" Shabbat and chag by their labels or a Jewish calendar; vacation alone does not count', () => {
  assert.equal(hasModeLabels([{ name: 'חופשה' }]), false);
  assert.equal(hasModeLabels([{ name: 'שבת' }]), true);
  assert.equal(keepsJewishModes([], {}), false);
  const states = Object.fromEntries(fixtures.states.map((s) => [s.entity_id, s]));
  assert.equal(keepsJewishModes([], states), true, 'Jewish Calendar is there');
  assert.equal(autoAvailable('vacation', {}), true, 'vacation needs no calendar');
});

// ---- the automatic-vacation automation ------------------------------------------------------------------------------

test('the automatic-vacation automation matches the contract', () => {
  const a = buildVacationAutomation({ id: '9', labelId: 'vac', range: TRIP });
  assert.equal(a.alias, AUTO_ALIAS.vacation);
  assert.ok(isAutoAlias(a.alias));
  assert.ok(a.description.startsWith(BEIT_MARKER));
  assert.deepEqual(a.variables, { vacation_from: TRIP.from, vacation_to: TRIP.to });
  assert.deepEqual(a.triggers, [
    { trigger: 'time', at: '08:00:00', id: 'vacation_start' },
    { trigger: 'time', at: '18:30:00', id: 'vacation_end' },
    { trigger: 'homeassistant', event: 'start', id: 'ha_start' },
  ]);
  const [on, off] = a.actions[0].choose;
  assert.deepEqual(on.conditions[0], { condition: 'trigger', id: ['vacation_start', 'ha_start'] });
  assert.match(on.conditions[1].value_template, /vacation_from <= now\(\)\.strftime\('%Y-%m-%d %H:%M'\) and .* < vacation_to/);
  assert.deepEqual(on.sequence, [{ action: 'automation.turn_on', target: { label_id: 'vac' } }]);
  assert.deepEqual(off.conditions[0], { condition: 'trigger', id: ['vacation_end', 'ha_start'] });
  assert.match(off.conditions[1].value_template, />= vacation_to/);
  assert.match(off.sequence[0].wait_template, /label_entities\('vac'\)/);
  assert.deepEqual(off.sequence[1], { action: 'automation.turn_off', target: { label_id: 'vac' }, data: { stop_actions: false } });
  assert.deepEqual(off.sequence[2].target, { entity_id: '{{ this.entity_id }}' }, 'it switches itself off: back to manual');
  assert.equal(a.mode, 'single');
});

test('parseVacationAutomation reads the dates back, and refuses one edited by hand', () => {
  const a = buildVacationAutomation({ id: '9', labelId: 'vac', range: TRIP });
  assert.deepEqual(parseVacationAutomation(a), { ...TRIP, labelId: 'vac' });
  assert.equal(parseVacationAutomation({ ...a, mode: 'restart' }), null);
  assert.equal(parseVacationAutomation({ ...a, description: 'mine' }), null, 'no marker');
  assert.equal(parseVacationAutomation({ ...a, variables: { ...a.variables, vacation_to: 'soon' } }), null);
  // Key order is HA's business.
  const reordered = Object.fromEntries(Object.entries(a).reverse());
  assert.deepEqual(Object.keys(reordered)[0], 'mode');
  assert.deepEqual(parseVacationAutomation(reordered), { ...TRIP, labelId: 'vac' });
});

test('vacationPhase and the range checks', () => {
  const d = (s) => parseStamp(s);
  assert.equal(vacationPhase(TRIP, d('2030-06-30 23:59')), 'before');
  assert.equal(vacationPhase(TRIP, d('2030-07-01 08:00')), 'during');
  assert.equal(vacationPhase(TRIP, d('2030-07-08 18:29')), 'during');
  assert.equal(vacationPhase(TRIP, d('2030-07-08 18:30')), 'after');
  const now = d('2030-07-03 12:00');
  assert.equal(vacationRangeError(TRIP, 'en', now), null, 'a range already under way is fine');
  assert.equal(vacationRangeError({ from: TRIP.to, to: TRIP.from }, 'en', d('2030-01-01 00:00')), 'The end must be after the start');
  assert.equal(vacationRangeError(TRIP, 'en', d('2030-08-01 00:00')), 'The end has already passed');
  assert.equal(vacationRangeError({ from: '', to: TRIP.to }, 'he'), 'בחרו תאריך ושעה להתחלה ולסיום');
  assert.equal(vacationRangeError({ from: '2030-02-30 08:00', to: TRIP.to }, 'en'), 'Choose a date and time for the start and the end');
  assert.equal(localStamp(new Date(2030, 0, 5, 7, 3)), '2030-01-05 07:03');
  assert.equal(parseStamp('2030-01-05T07:03').getHours(), 7, 'a datetime-local value');
});

test('modeOutsideNow for vacation: by its dates, outside when there are none', () => {
  assert.equal(modeOutsideNow('vacation', {}, new Date()), true);
  assert.equal(modeOutsideNow('vacation', {}, parseStamp('2030-07-02 10:00'), TRIP), false);
  assert.equal(modeOutsideNow('vacation', {}, parseStamp('2030-07-09 10:00'), TRIP), true);
});

test('formatDateTime: words within the week, the date beyond it', () => {
  const now = new Date(2030, 6, 1, 9, 0);
  assert.equal(formatDateTime(new Date(2030, 6, 1, 18, 0), now, 'en'), 'today at 18:00');
  assert.match(formatDateTime(new Date(2030, 6, 20, 8, 0), now, 'en'), /20 Jul at 08:00/);
  assert.match(formatDateTime(new Date(2030, 6, 20, 8, 0), now, 'he'), /20.*ב-08:00/);
});

// ---- operations on the fake -----------------------------------------------------------------------------------------

test('enableAuto(vacation) creates the label and one automation, and a second call rewrites the dates', async () => {
  const hass = house({ language: 'en' });
  const id = await enableAuto(hass, 'vacation', { range: TRIP, ...FAST });
  const label = modeLabel(await loadRegistry(hass), 'vacation');
  assert.equal(label.name, 'Vacation');
  const found = await findAuto(hass, 'vacation');
  assert.equal(found.entityId, id);
  assert.deepEqual(parseVacationAutomation(found.config), { ...TRIP, labelId: label.label_id });
  // New dates: the same automation, rewritten; never a second one.
  const later = { from: '2030-08-01 06:00', to: '2030-08-03 22:00' };
  await disableAuto(hass, 'vacation');
  assert.equal(hass.states[id].state, 'off');
  assert.equal(await enableAuto(hass, 'vacation', { range: later, ...FAST }), id);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(hass.states[id].state, 'on', 'enabled again');
  assert.deepEqual(parseVacationAutomation((await findAuto(hass, 'vacation')).config), { ...later, labelId: label.label_id });
  const posts = hass.calls.filter((c) => c.method === 'POST');
  assert.equal(posts.length, 2);
  assert.equal(posts[0].body.id, posts[1].body.id);
  assert.equal(await upgradeAuto(hass, 'vacation', await findAuto(hass, 'vacation')), false, 'nothing to upgrade');
});

test('enableAuto(vacation) refuses bad dates and an automation edited by hand', async () => {
  const hass = house();
  await assert.rejects(enableAuto(hass, 'vacation', { range: { from: '2020-01-01 08:00', to: '2020-01-02 08:00' }, ...FAST }), /עבר/);
  assert.ok(!hass.calls.some((c) => c.method === 'POST'), 'nothing written');
  const id = await enableAuto(hass, 'vacation', { range: TRIP, ...FAST });
  const cfg = (await findAuto(hass, 'vacation')).config;
  await hass.callApi('POST', `config/automation/config/${cfg.id}`, { ...cfg, mode: 'restart' }); // the user edits it
  await assert.rejects(enableAuto(hass, 'vacation', { range: { from: '2030-09-01 08:00', to: '2030-09-02 08:00' }, ...FAST }), /ידנית/);
  assert.equal((await findAuto(hass, 'vacation')).config.mode, 'restart', 'left as the user wrote it');
  assert.ok(id);
});

test('the first automation to join an empty vacation mode is switched off, unless the trip is on now', async () => {
  const hass = house();
  const id = 'automation.beit_water_heater_weekdays';
  assert.equal(hass.states[id].state, 'on');
  await setModeMembership(hass, 'vacation', [id], true);
  await alignWithMode(hass, 'vacation', [id]);
  assert.equal(hass.states[id].state, 'off', 'not on vacation: off until the trip');
  // With an automatic vacation under way, it joins switched on.
  const now = new Date();
  const range = { from: localStamp(new Date(now.getTime() - 3600000)), to: localStamp(new Date(now.getTime() + 86400000)) };
  await enableAuto(hass, 'vacation', { range, ...FAST });
  await new Promise((r) => setTimeout(r, 20));
  await alignWithMode(hass, 'vacation', [id]);
  assert.equal(hass.states[id].state, 'on');
});

test('the dashboard the card creates holds the Schedules and Modes cards', () => {
  assert.deepEqual(dashboardConfig().views[0].cards, [{ type: 'custom:schedule-helper-card' }, { type: 'custom:schedule-helper-modes-card' }]);
});

// ---- Music Assistant: its players are ordinary media_player entities ------------------------------------------------

// A Music Assistant player as HA reports it (synthetic): platform music_assistant, on/off/play/pause supported.
const MA_PLAYER = {
  entity_id: 'media_player.living_room_speaker_ma', state: 'idle',
  attributes: { friendly_name: 'Living room speaker (MA)', app_id: 'music_assistant', mass_player_type: 'player', supported_features: 152511 },
  last_changed: '2030-01-01T00:00:00+00:00', last_updated: '2030-01-01T00:00:00+00:00',
};
const withMusicAssistant = () => ({
  ...fixtures,
  states: [...fixtures.states, MA_PLAYER],
  entity_registry_display: { ...fixtures.entity_registry_display,
    entities: [...fixtures.entity_registry_display.entities, { ei: MA_PLAYER.entity_id, pl: 'music_assistant', ai: 'living_room' }] },
});

test('a Music Assistant player is offered in the device picker, under media players and its room', () => {
  const f = withMusicAssistant();
  const states = Object.fromEntries(f.states.map((s) => [s.entity_id, s]));
  const sections = deviceSections({ states, display: f.entity_registry_display, devices: f.device_registry, areas: f.area_registry, only: 'media_player' });
  const ids = sections.flatMap((s) => s.entities.map((e) => e.entity_id));
  assert.ok(ids.includes(MA_PLAYER.entity_id), ids.join(','));
  assert.ok(sections.find((s) => s.entities.some((e) => e.entity_id === MA_PLAYER.entity_id)).areaId === 'living_room');
});

test('a schedule for a Music Assistant player: on at the start, paused at the end, in vacation mode', async () => {
  const hass = new FakeHass(withMusicAssistant(), { language: 'en' });
  const target = { entityId: MA_PLAYER.entity_id, name: MA_PLAYER.attributes.friendly_name };
  const auto = buildScheduleAutomation({ id: '1', scheduleEntityId: 'schedule.x', scheduleName: 'x', target });
  assert.deepEqual(auto.actions[0].choose.map((b) => b.sequence.map((a) => a.action)), [['media_player.turn_on'], ['media_player.media_pause']]);
  assert.equal(actionSummary(target, 'en'), 'When a range starts: turns on · when it ends: pauses');
  // Created in vacation mode: the schedule and its automation carry the vacation label; the mode switches it.
  const w = new WeekSchedule({ name: 'Wake-up music', days: { monday: [{ start: 420, end: 480 }] } });
  const id = await createScheduleWithAutomation(hass, w, target, { labelName: 'vacation', ...FAST });
  const reg = await loadRegistry(hass);
  assert.deepEqual(modeMembers(hass.states, reg, 'vacation', 'schedule').map((e) => e.entity_id), [id]);
  const [member] = modeMembers(hass.states, reg, 'vacation');
  assert.equal(member.state, 'off', 'joined an empty vacation mode with no trip: off');
  await setModeEnabled(hass, reg, 'vacation', true);
  assert.equal(hass.states[member.entity_id].state, 'on');
});
