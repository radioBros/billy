// Minimal ambient types for `pino-roll` v4 (ships no `.d.ts`). Covers only the
// options Billy uses (see createLogger in ./index.ts). The builder is async and
// resolves to a SonicBoom-like duplex/writable stream usable as a pino sink.
declare module "pino-roll" {
  import type { Writable } from "node:stream";

  interface PinoRollLimit {
    /** Number of files kept IN ADDITION to the current one. */
    count: number;
    /**
     * When true, cleanup scans the directory for every file matching the base
     * pattern (age-sorted by the date in the filename), not just files created
     * in the current process run — so retention survives restarts.
     */
    removeOtherLogFiles?: boolean;
  }

  interface PinoRollOptions {
    /** Absolute or relative base path; pino-roll appends `.<date>.<n><ext>`. */
    file: string | (() => string);
    /** Max size per segment, e.g. `"20m"`. Combinable with `frequency`. */
    size?: string | number;
    /** `"daily"` | `"hourly"` | milliseconds. */
    frequency?: "daily" | "hourly" | number;
    /** Extension appended after the file number, e.g. `".log"`. */
    extension?: string;
    /** date-fns format appended to the filename, e.g. `"yyyy-MM-dd"`. */
    dateFormat?: string;
    /** Create the parent directory if missing. */
    mkdir?: boolean;
    /** Create a `current.log` symlink to the active file. */
    symlink?: boolean;
    /** Old-file retention strategy. */
    limit?: PinoRollLimit;
  }

  export default function pinoRoll(options: PinoRollOptions): Promise<Writable>;
}
