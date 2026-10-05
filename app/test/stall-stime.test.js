// t_c69c2170 leftover: Linux `ps -o time=` reports day-scale CPU as '2-03:12:45' (DD-HH:MM:SS).
// Without the day segment Number('2-03') is NaN and runAlive()'s cpuMs comparisons all go false —
// a CPU-busy run reads as stalled and the watchdog kills healthy work.
const test = require('node:test');
const assert = require('node:assert/strict');
const { stimeToMs } = require('../src/stall-watchdog');

test('stimeToMs parses every `ps -o time=` shape, including a day segment', () => {
  assert.equal(stimeToMs('12:05.44'), 12 * 60000 + 5440); // MM:SS.cc
  assert.equal(stimeToMs('12:05'), 725000); // MM:SS, no centiseconds
  assert.equal(stimeToMs('1:02:03'), 3723000); // H:MM:SS
  assert.equal(stimeToMs('2-03:12:45'), ((2 * 24 + 3) * 3600 + 12 * 60 + 45) * 1000); // DD-HH:MM:SS
  assert.equal(stimeToMs('0-00:00:01'), 1000); // zero day segment
});

test('stimeToMs: unknowable time is null, not 0', () => {
  assert.equal(stimeToMs('12:'), null); // empty seconds segment
  assert.equal(stimeToMs(''), null);
  assert.equal(stimeToMs(undefined), null);
});
