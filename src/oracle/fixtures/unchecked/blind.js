/**
 * The file the guard exists for. `checkJs` is off, so the checker reports
 * nothing about this one — not the two modules it cannot find, and not the
 * call written through them. Every reference here reaches nothing, and without
 * a resolution check that reads as our recall problem rather than its silence.
 */

const { mount } = require('./missing');
const finalhandler = require('finalhandler');

function boot(app) {
  return mount(app, finalhandler);
}

module.exports = { boot };
