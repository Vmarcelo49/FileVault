// ============================================================
// log.js — Pino-style structured logger (no external deps).
// ISO timestamps + level + optional JSON extra. Goes to stdout/stderr.
// ============================================================
const log = {
  _fmt(level, msg, extra) {
    const ts = new Date().toISOString();
    const x = extra ? ' ' + JSON.stringify(extra) : '';
    return `${ts} [${level}] ${msg}${x}`;
  },
  info(msg, extra) { console.log(this._fmt('INFO', msg, extra)); },
  warn(msg, extra) { console.warn(this._fmt('WARN', msg, extra)); },
  error(msg, extra) { console.error(this._fmt('ERROR', msg, extra)); },
  debug(msg, extra) {
    if (process.env.DEBUG) console.log(this._fmt('DEBUG', msg, extra));
  },
};

module.exports = log;
