/** Every module this one names is on disk, so it is compared as usual. */

const { boot } = require('./blind');

function start() {
  return boot({});
}

module.exports = { start };
