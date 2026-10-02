'use strict';
// Preloaded by `npm test` (node --require ./test/harness/install.js --test test/*.test.js) so
// every test-file process tracks and reaps its spawned children; see docs/testing.md.
require('./procguard').install();
// Every mkdtemp in a test-file process is tracked and removed at exit (t_8170a988). Loaded after
// procguard so its exit hook (which kills spawned children) runs before the removal.
require('./tmp').installGlobal();
