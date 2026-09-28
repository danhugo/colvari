const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { ProjectManager, defaultRoot, isolateTestRoot } = require('../src/projects');

const withEnv = (patch, fn) => {
  const saved = { ...patch };
  for (const k of Object.keys(patch)) { saved[k] = process.env[k]; if (patch[k] === undefined) delete process.env[k]; else process.env[k] = patch[k]; }
  try { fn(); } finally { for (const k of Object.keys(patch)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
};

test('live mode defaultRoot unchanged: AGENTS_SQUAD_HOME still wins over AGENTS_SQUAD_PROJECT', () => {
  withEnv({ AGENTS_SQUAD_HOME: '/live/root', AGENTS_SQUAD_PROJECT: '/test/root' }, () => {
    assert.equal(defaultRoot(), '/live/root');
  });
  withEnv({ AGENTS_SQUAD_HOME: undefined, AGENTS_SQUAD_PROJECT: '/test/root' }, () => {
    assert.equal(defaultRoot(), '/test/root');
  });
});

test('isolateTestRoot: explicit AGENTS_SQUAD_PROJECT wins over ambient AGENTS_SQUAD_HOME', () => {
  const r = isolateTestRoot({ AGENTS_SQUAD_HOME: '/live/root', AGENTS_SQUAD_PROJECT: '/test/root' }, os.tmpdir());
  assert.equal(r, '/test/root');
});

test('isolateTestRoot: no roots set -> fresh temp root, never the real data root', () => {
  const env = { AGENTS_SQUAD_HOME: '/live/root' };
  const r = isolateTestRoot(env, os.tmpdir());
  assert.ok(fs.existsSync(r), 'temp root pre-created');
  assert.ok(r.startsWith(os.tmpdir()) && path.basename(r).startsWith('agents-squad-e2e-'), r);
  assert.notEqual(r, path.join(os.homedir(), '.agents-squad'));
  assert.equal(env.AGENTS_SQUAD_PROJECT, r, 'set into env so defaultRoot()/ProjectManager pick it up');
  assert.equal(env.AGENTS_SQUAD_HOME, undefined, 'ambient live root dropped');
});

test('isolateTestRoot on process.env wires a bare ProjectManager to the temp root', () => {
  withEnv({ AGENTS_SQUAD_PROJECT: undefined, AGENTS_SQUAD_HOME: undefined }, () => {
    const r = isolateTestRoot();
    assert.equal(process.env.AGENTS_SQUAD_PROJECT, r);
    assert.equal(new ProjectManager().root, r);
  });
});
