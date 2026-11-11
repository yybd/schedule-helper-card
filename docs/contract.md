# The data contract shared with the Beit app

The card and the Beit native app (`../app`, Flutter) edit **the same HA objects**. Anything one creates, the other
must read and be able to edit or delete. Change this contract in both places or not at all.

The Dart that implements it today lives in the Beit app: `lib/ha/schedule.dart` (week model, automation builder,
marker), `test/schedule_test.dart` (cases to port 1:1), `lib/store/home_store.dart` (every HA call and its order),
`lib/ui/schedule_editor.dart` and `lib/ui/shabbat_screen.dart` (the UI this card mirrors).

## 1. Schedules

- The HA `schedule` helper, UI-managed, via WebSocket `schedule/list | create | update | delete`.
- Days are HA's keys, shown Sunday first: `sunday … saturday`.
- A block is `{"from": "HH:MM:SS", "to": "HH:MM:SS"}`.
  - `"24:00:00"` means "until midnight" (HA accepts it; verified on 2026.8).
  - Read `"23:59:59"` as 24:00; the app writes it back as `"24:00:00"`.
  - Minute precision.
- Blocks within a day must not overlap, and `to > from`. HA rejects the write otherwise.
- Reading a week without editing it: the `schedule.get_schedule` action with `return_response`. Unlike
  `schedule/list` it is open to non-admins and covers YAML schedules too.
- `schedule/create` generates the id as a slug of the name. The entity is usually `schedule.<id>`, or `schedule.<id>_2`
  when that entity id is taken; the entity's registry `unique_id` is the helper id, so resolve it from there
  (`config/entity_registry/get`). A user may rename the entity.
- A block may carry an extra `data` object; keep it on every write.
- `schedule/update` takes the full body: `schedule_id`, `name` and all seven days.

## 2. The automation a schedule drives

Written with `POST /api/config/automation/config/<id>`. From a card this is `hass.callApi('POST', 'config/automation/config/<id>', body)`. `<id>` is `Date.now()` as a string.

```json
{
  "id": "<ms timestamp>",
  "alias": "Beit · <schedule name>",
  "description": "נוצר באפליקציית Beit — <device name> לפי schedule.<id>",
  "triggers": [
    {"trigger": "state", "entity_id": ["schedule.<id>"], "to": ["on"],  "not_from": ["unavailable", "unknown"], "id": "schedule_on"},
    {"trigger": "state", "entity_id": ["schedule.<id>"], "to": ["off"], "not_from": ["unavailable", "unknown"], "id": "schedule_off"}
  ],
  "conditions": [],
  "actions": [{"choose": [
    {"conditions": [{"condition": "trigger", "id": "schedule_on"}],  "sequence": ["<on actions>"]},
    {"conditions": [{"condition": "trigger", "id": "schedule_off"}], "sequence": ["<off actions>"]}
  ]}],
  "mode": "queued"
}
```

- **The marker.** The description contains `נוצר באפליקציית Beit`. That string is the marker. **Only automations carrying it may be rewritten or deleted.** Hand-written automations are listed, never touched.
- **When the device stays on at the end of the range,** there is no `schedule_off` trigger and no off branch.
- **On actions, per domain:**
  - `climate`: `climate.set_temperature {temperature, hvac_mode}` when a temperature is set; otherwise `climate.set_hvac_mode {hvac_mode}`.
  - `water_heater`: `turn_on`, plus `set_temperature` if one is set.
  - `light`: `turn_on`, with `brightness_pct` if set.
  - `cover`: `open_cover`.
  - `valve`: `open_valve`.
  - Anything else: `<domain>.turn_on`.
- **Off actions:** `close_cover`, `close_valve`, `media_player.media_pause`, otherwise `<domain>.turn_off`.
- **Order when creating:**
  1. `schedule/create`.
  2. Wait for `schedule.<id>` to appear in `hass.states`.
  3. POST the automation.
  4. If the POST fails, `schedule/delete`, so the card never leaves a helper that drives nothing.
- **A schedule that nothing uses** (no automation found by `search/related`): the card can write its automation later,
  the same shape, when the user picks a device for it; it then joins the schedule's mode, if it has one. Nothing new to
  read: to the app it is an ordinary automation carrying the marker.
- **Changing what a schedule does** (its device, HVAC mode, temperature, brightness, turning off at the end): the one
  related automation that carries the marker **and** is still exactly in the shape above is POSTed again under the same
  id, rebuilt with the new target. An automation edited by hand is never rewritten; the user changes it in HA.
- **Renaming a schedule:** each related automation carrying the marker and still named `Beit · <old name>` is POSTed
  again with `alias: "Beit · <new name>"` and nothing else changed. An alias the user changed is left alone.
- **Finding a schedule's automations:** `search/related {item_type: "entity", item_id: "schedule.<id>"}` → `.automation[]`.
- **Reading one automation:** `automation/config {entity_id}` → `.config`.
- **Deleting a schedule:**
  1. For each related automation carrying the marker: `DELETE /api/config/automation/config/<config id>`.
  2. `schedule/delete`.
  3. Report the related automations that were kept.

## 3. Modes: vacation, Shabbat, chag

Three modes share everything in this section. Vacation is the general one (§3b covers what is its own); Shabbat and
chag are the ones a Jewish calendar times.

- **A mode is an HA label.** Labels are identified by **name**, never by id: vacation by `Vacation` **or** `חופשה`
  (either is recognised; the card creates the one in the user's language), Shabbat by `שבת`, chag by `חג`. HA slugs Hebrew names (for example `shbt`), and the slug is not guaranteed.
- **Creating a missing label:** `config/label_registry/create {name, icon: "mdi:airplane" | "mdi:candle" | "mdi:star-david", color: "teal" | "amber" | "indigo"}`.
- **Membership:** an automation, and the schedules it follows, carry the label. Write it with `config/entity_registry/update {entity_id, labels: [...]}`. That call **replaces** the list, so merge with the entity's existing labels, read just before from `config/entity_registry/get` → `labels` (`list_for_display` leaves out disabled entities).
- **Changing a schedule's mode from the schedule editor** moves the schedule and only the automations carrying the
  marker that drive it; an automation the user wrote may only mention the schedule. Those automations then follow the
  mode: joining a mode that is on or off switches them to match; leaving every mode switches them on.
  - Joining an **empty** mode (no other member) follows the calendar instead: off when the mode is over and not about
    to begin (the facts below, under *Catch-up*), on otherwise. Without a readable calendar they are left as they are.
    *(Card 2.0.2. The Beit app still leaves them as they are; to be aligned.)*
  - For **chag**, Jewish Calendar's `issur_melacha_in_effect*` and `erev_shabbat_hag*` are on every Shabbat too. A
    plain Shabbat counts as outside chag: issur is on and `upcoming_havdalah*` equals `upcoming_shabbat_havdalah*`, or
    erev is on and `upcoming_candle_lighting*` equals `upcoming_shabbat_candle_lighting*`. *(Card 2.4; only this join
    check. The catch-up template below is unchanged, and the Beit app does not make this distinction yet.)*
- **Taking an automation out of a mode** also takes out the schedules its config refers to, except those another
  automation of the mode still refers to.
- **Switching a mode:** `automation.turn_on` / `automation.turn_off` with target `{label_id}`, or with the member list. The switch shows:
  - "on" when every member is on;
  - "partial" when some are;
  - "off" when none are.
- **Switching automations off mid-range** (a mode, or one automation): a schedule they follow that is on now would
  leave its device on, since nothing runs at the end of the range any more. So, after `automation.turn_off`, the
  steps the automation runs when that schedule turns off are called directly: the `choose` branch picked by a trigger
  to `off` on the schedule (the shape above), or by a `state` condition that the schedule is `off` (a common
  hand-written shape). Only plain action calls, no templates; an automation that cannot be read this way is left as
  it is and named to the user. *(Card 2.4; the Beit app does not do this yet, to be aligned.)*
- **Automatic Shabbat.** One automation, alias `Beit · מצב שבת אוטומטי`, carrying the marker:
  - Fridays at 12:00 it turns the label on. That is before typical Friday-afternoon schedules; candle lighting is too late.
    The start trigger (`id: erev_shabbat`) may instead be a time of day `HH:MM:00`, or
    `{at: {entity_id: sensor.jewish_calendar_upcoming_shabbat_candle_lighting*, offset: "-HH:MM:00"}}`; the
    `weekday: [fri]` condition stays. Changing the start replaces only that trigger (and the description while it is
    still the one the card wrote).
  - When Shabbat ends (see §4), it waits until every `schedule.*` carrying the label is off (6 h timeout), then turns the label off with `stop_actions: false`.
  - **Catch-up after a restart** *(card 2.0.2; the Beit app does not write it yet, to be aligned)*. A restart drops a
    run that is waiting for the schedules, and an end that comes while HA is down never fires, so the mode would stay
    on all week. A third trigger `{trigger: "homeassistant", event: "start", id: "ha_start"}` and a third `choose`
    branch for it:
    1. `wait_template` until each calendar entity below is neither `unknown` nor `unavailable` (10 min, then give up);
    2. a template `condition` that the mode is over and not about to begin:
       - Jewish Calendar: `issur_melacha_in_effect*` is `off` and `erev_shabbat_hag*` is `off`;
       - otherwise, Shabbat only: `motzei_shabbat_hag*` is `on`, or Hebcal's `is_shabbat` is `False`;
       - Shabbat also `now().weekday() != 4`: on a Friday the mode may already be on from noon;
    3. the same wait for the schedules and the same turn-off as the end branch.

    A mode switched on by hand on a weekday is therefore switched off again by a restart while the automatic mode is on.
  - **Upgrading.** An automatic automation without the catch-up that carries the marker and is otherwise exactly what
    the card writes (same start and end trigger) is POSTed again with it, when an admin opens the card. One changed by
    hand is left alone.
  - The card creates it on request, and **recognises** an existing one, so there is never a second: by its alias, or, if
    renamed, as an automation found by `search/related` for the label that carries the marker and an `erev_*` trigger.
  - Switching it off **disables** it (`automation.turn_off`). The card never deletes it, so changes the user made to it survive.
- **Automatic chag.** The same shape with alias `Beit · מצב חג אוטומטי` and the `חג` label. Jewish Calendar only.
  - Start trigger `id: erev_chag`: a time of day, or an offset before `sensor.jewish_calendar_upcoming_candle_lighting*`.
    Condition, a template: the `erev_shabbat_hag*` sensor is on, and the day is not Friday unless the stretch from
    upcoming candle lighting to upcoming havdalah is longer than 36 h (Shabbat joined by a chag).
  - End trigger `id: motzei_chag`: `issur_melacha_in_effect*` from `on` to `off`, then the same wait and turn-off as Shabbat.
  - A chag that falls on Shabbat alone is covered by Shabbat mode.
  - Neither automatic automation is ever a member of a mode: it would switch itself off.
  - The Beit app does not create automatic chag yet; it sees it as an ordinary automation carrying the marker.

## 3a. The Schedule Helper dashboard

On request (a button in either card's visual editor, admins only) the card creates one new storage dashboard:
`lovelace/dashboards/create {url_path: "schedule-helper", title: "Schedule Helper", icon: "mdi:calendar-clock", show_in_sidebar: true,
require_admin: false, mode: "storage"}`, then `lovelace/config/save` with one view holding `custom:schedule-helper-card` and `custom:schedule-helper-modes-card` (2.5; before, the Shabbat card).
The Modes card gets `modes: [vacation, שבת, חג]` in a home that has a `שבת` or `חג` label or a Jewish calendar; otherwise
it has no `modes` (vacation only). If a dashboard with
that `url_path` exists, nothing is written. If the save fails, the new dashboard is deleted again
(`lovelace/dashboards/delete {dashboard_id}`). No existing dashboard is ever changed. A dashboard at `beit-schedules` (the address before 2.0) counts as
existing too.

## 3b. Vacation

*(Card 2.5. The Beit app does not know the vacation mode yet: it sees its label as an ordinary label and the automatic
automation as an ordinary automation carrying the marker. To be aligned.)*

- Membership, the switch, switching off mid-range and moving a schedule between modes are §3 unchanged.
- **Joining an empty vacation mode:** off, unless an automatic vacation that is switched on says the trip is on now.
- **Automatic vacation.** One automation, alias `Beit · Automatic vacation`, carrying the marker:

  ```json
  {
    "id": "<ms timestamp>",
    "alias": "Beit · Automatic vacation",
    "description": "נוצר באפליקציית Beit — …",
    "variables": {"vacation_from": "YYYY-MM-DD HH:MM", "vacation_to": "YYYY-MM-DD HH:MM"},
    "triggers": [
      {"trigger": "time", "at": "<from's HH:MM>:00", "id": "vacation_start"},
      {"trigger": "time", "at": "<to's HH:MM>:00", "id": "vacation_end"},
      {"trigger": "homeassistant", "event": "start", "id": "ha_start"}
    ],
    "conditions": [],
    "actions": [{"choose": [
      {"conditions": [{"condition": "trigger", "id": ["vacation_start", "ha_start"]},
                      {"condition": "template", "value_template": "{{ vacation_from <= now().strftime('%Y-%m-%d %H:%M') and now().strftime('%Y-%m-%d %H:%M') < vacation_to }}"}],
       "sequence": [{"action": "automation.turn_on", "target": {"label_id": "<vacation label>"}}]},
      {"conditions": [{"condition": "trigger", "id": ["vacation_end", "ha_start"]},
                      {"condition": "template", "value_template": "{{ now().strftime('%Y-%m-%d %H:%M') >= vacation_to }}"}],
       "sequence": ["<the same wait for the label's schedules as Shabbat (6 h)>",
                    {"action": "automation.turn_off", "target": {"label_id": "<vacation label>"}, "data": {"stop_actions": false}},
                    {"action": "automation.turn_off", "target": {"entity_id": "{{ this.entity_id }}"}, "data": {"stop_actions": false}}]}
    ]}],
    "mode": "single"
  }
  ```

  - Dates are HA's local time, compared as text.
  - After the end it disables itself, so the mode is manual again and its switches unlock.
  - The dates are read from `variables`. The card rewrites it (same id) only while it is exactly this shape; one edited
    by hand is only switched on and off.
  - Creating it, or giving it new dates, also switches the members to match the dates: off before the trip, on during it.
  - It is never a member of a mode, and it is never deleted (switching to manual disables it).

## 4. Calendar sources

Find these entities by prefix, not by exact id: HA may add suffixes such as `_2` or `_3`.

- **Jewish Calendar (core integration). Preferred.**
  - `binary_sensor.jewish_calendar_issur_melacha_in_effect*` covers Shabbat **and** yom tov.
  - Also `…_erev_shabbat_hag*`, `…_motzei_shabbat_hag*`, `sensor.jewish_calendar_upcoming_candle_lighting*` and `…_upcoming_havdalah*`.
- **Hebcal (custom integration). Optional.**
  - `sensor.hebcal_is_shabbat` (`True`/`False`) is reliable for Shabbat.
  - `sensor.hebcal_is_yomtov` has been seen reporting "אין מידע" through Sukkot, so do not use it for chag.
  - Its sensors pass through `unknown` on every HA restart, so triggers on them must use explicit `from`/`to`.
