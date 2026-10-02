'use strict';
// Preloaded by `npm test` (node --require ./test/harness/install.js --test test/*.test.js).
// tmpdir first: the run root claims a private squad-test-<pid> TMPDIR and passes it down through
// the environment (children inherit AGENTS_SQUAD_TEST_TMPDIR and create nothing). Then procguard,
// whose pidfile dir must stay in the real system tmpdir (AGENTS_SQUAD_REAL_TMP, set by tmpdir) so
// crashed runs still leave their pids reappable across runs. See docs/testing.md.
require('./tmpdir').install();
require('./procguard').install();
