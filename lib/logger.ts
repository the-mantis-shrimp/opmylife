/** Minimal structured logger. Pipeline stages tag lines with project/stage. */
type Fields = Record<string, unknown>;

function emit(level: string, msg: string, fields?: Fields) {
  const line = {
    t: new Date().toISOString(),
    level,
    msg,
    ...fields,
  };
  const out = level === "error" ? console.error : console.log;
  out(JSON.stringify(line));
}

export const log = {
  info: (msg: string, fields?: Fields) => emit("info", msg, fields),
  warn: (msg: string, fields?: Fields) => emit("warn", msg, fields),
  error: (msg: string, fields?: Fields) => emit("error", msg, fields),
};
