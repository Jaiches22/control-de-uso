import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addPending, creditedSeconds, effectiveRemaining, keysFor, limitMatches, madridDay, normalizeDomain,
  type Limit, type Pending, type State,
} from '../../shared/core.ts';
import { normalizePackage, normalizeProcess } from '../../shared/limits-ui.ts';

const limit = (name: string, daily: number, remaining: number, targets: [string, string][]): Limit => ({
  id: name, name, daily_seconds: daily, used_seconds: daily - remaining, remaining_seconds: remaining,
  allow_extra: false, pending_daily_seconds: null, pending_delete: false, pending_effective: null,
  targets: targets.map(([kind, value]) => ({ kind: kind as never, value, remove_on: null })),
});

test('normalizeDomain', () => {
  assert.equal(normalizeDomain(' https://www.Instagram.com/reels/?x=1 '), 'instagram.com');
  assert.equal(normalizeDomain('m.youtube.com'), 'm.youtube.com');
  assert.equal(normalizeDomain('localhost'), null);
  assert.equal(normalizeDomain('no es un dominio'), null);
});

test('keysFor', () => {
  assert.deepEqual(keysFor('https://www.instagram.com/p/abc'), [{ kind: 'domain', value: 'instagram.com' }]);
  assert.deepEqual(keysFor('https://www.youtube.com/watch?v=1'), [{ kind: 'domain', value: 'youtube.com' }]);
  assert.deepEqual(keysFor('https://m.youtube.com/shorts/abc'), [
    { kind: 'domain', value: 'm.youtube.com' }, { kind: 'special', value: 'youtube_shorts' },
  ]);
  assert.equal(keysFor('chrome-extension://abc/blocked.html'), null);
  assert.equal(keysFor('brave://settings'), null);
});

test('un dominio cubre sus subdominios pero no dominios parecidos', () => {
  const ig = limit('Instagram', 720, 720, [['domain', 'instagram.com']]);
  assert.ok(limitMatches(ig, keysFor('https://instagram.com/')!));
  assert.ok(limitMatches(ig, keysFor('https://help.instagram.com/')!));
  assert.ok(!limitMatches(ig, keysFor('https://notinstagram.com/')!));
});

test('Shorts se limita sin tocar el resto de YouTube', () => {
  const shorts = limit('Shorts', 300, 300, [['special', 'youtube_shorts']]);
  assert.ok(limitMatches(shorts, keysFor('https://www.youtube.com/shorts/x')!));
  assert.ok(!limitMatches(shorts, keysFor('https://www.youtube.com/watch?v=x')!));
  assert.ok(!limitMatches(shorts, keysFor('https://www.youtube.com/')!));
});

test('effectiveRemaining descuenta lo pendiente de hoy y se reinicia al cambiar de día', () => {
  const ig = limit('Instagram', 720, 100, [['domain', 'instagram.com']]);
  const state: State = { day: '2026-11-14', server_time: '', resets_at: '', limits: [ig] };
  const pending: Pending = {};
  addPending(pending, keysFor('https://www.instagram.com/')!, 30, '2026-11-14');
  addPending(pending, keysFor('https://www.instagram.com/')!, 20, '2026-11-14');
  addPending(pending, keysFor('https://example.com/')!, 999, '2026-11-14');
  assert.equal(Object.keys(pending).length, 2);
  assert.equal(effectiveRemaining(ig, state, pending, '2026-11-14'), 50);
  addPending(pending, keysFor('https://www.instagram.com/')!, 500, '2026-11-14');
  assert.equal(effectiveRemaining(ig, state, pending, '2026-11-14'), 0);
  assert.equal(effectiveRemaining(ig, state, {}, '2026-11-15'), 720);
});

test('un Short cuenta una sola vez aunque el límite incluya youtube.com y Shorts', () => {
  const yt = limit('YT', 600, 600, [['domain', 'youtube.com'], ['special', 'youtube_shorts']]);
  const state: State = { day: 'd', server_time: '', resets_at: '', limits: [yt] };
  const pending: Pending = {};
  addPending(pending, keysFor('https://www.youtube.com/shorts/x')!, 40, 'd');
  assert.equal(effectiveRemaining(yt, state, pending, 'd'), 560);
  assert.deepEqual(Object.values(pending)[0].also, [{ kind: 'special', value: 'youtube_shorts' }]);
});

test('creditedSeconds ignora huecos de suspensión', () => {
  assert.equal(creditedSeconds(900), 0);
  assert.equal(creditedSeconds(30_400), 30);
  assert.equal(creditedSeconds(75_000), 60);
  assert.equal(creditedSeconds(3_600_000), 0);
});

test('madridDay cambia a medianoche de Madrid', () => {
  assert.equal(madridDay(new Date('2026-11-14T22:59:59Z')), '2026-11-14');
  assert.equal(madridDay(new Date('2026-11-14T23:00:00Z')), '2026-11-15');
  assert.equal(madridDay(new Date('2026-07-01T21:59:59Z')), '2026-07-01');
  assert.equal(madridDay(new Date('2026-07-01T22:00:00Z')), '2026-07-02');
});

test('normalizeProcess', () => {
  assert.equal(normalizeProcess(' Spotify.EXE '), 'spotify.exe');
  assert.equal(normalizeProcess('C:\\Program Files\\Steam\\steam.exe'), 'steam.exe');
  assert.equal(normalizeProcess('discord'), 'discord.exe');
  assert.equal(normalizeProcess('   '), null);
  assert.equal(normalizePackage('com.instagram.android'), 'com.instagram.android');
  assert.equal(normalizePackage('Instagram'), null);
});
