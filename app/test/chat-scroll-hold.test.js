// Chat scroll hold: reading history must not be yanked to the bottom by new/streaming messages.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const Chat = require('../src/chat');
const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');

test('scrolled up: anchorScroll tracks growth above (not used for appends)', () => {
  assert.strictEqual(Chat.anchorScroll(500, 3000, 3400), 900); // shifts by growth: only valid for content added ABOVE
});
test('draw pins only when within 40px of the bottom, or after an own send', () => {
  assert.match(src, /const atBottom = CH\.stickNext \|\| room\.scrollHeight - room\.scrollTop - room\.clientHeight < 40;/);
  assert.match(src, /CH\.stickNext = true;\s*\n\s*refresh\(\);/);
  assert.match(src, /else \{ room\.scrollTop = prevTop;/);
});
