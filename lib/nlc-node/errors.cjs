'use strict';
// Closed set of error codes returned to the agent (CONTRACT 1.1). Messages are plain English.
const CODES = ['NOT_GRANTED','OUTSIDE_GRANT','PAUSED','NOT_FOUND','EXISTS','TOO_LARGE','NOT_TEXT','NO_MATCH','AMBIGUOUS','BUSY','FFMPEG_FAILED','FFMPEG_MISSING','OFFLINE','BAD_ARGUMENT'];
class NodeError extends Error {
  constructor(code, message) {
    super(message || code);
    if (!CODES.includes(code)) throw new Error('unknown NodeError code ' + code);
    this.name = 'NodeError';
    this.code = code;
  }
  toJSON() { return { code: this.code, message: this.message }; }
}
module.exports = { NodeError, CODES };
