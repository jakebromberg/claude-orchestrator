/** One row of scripted `ps` output; omitted columns take the defaults of an ordinary process owned by uid 501 that started two hours ago. */
export interface PsTextRow {
  pid: number;
  ppid: number;
  pgid: number;
  uid?: number;
  stat?: string;
  etime?: string;
  command: string;
}

/** The text `ps -axo pid=,ppid=,pgid=,uid=,stat=,etime=,command=` prints for `rows`: the one fixture the parser, `suspensions` and `watchdog` suites share, so no test calls the real `ps`. */
export const psText = (rows: PsTextRow[]): string => rows.map(({ pid, ppid, pgid, uid = 501, stat = "S", etime = "02:00:00", command }) => `${pid} ${ppid} ${pgid} ${uid} ${stat} ${etime} ${command}`).join("\n");
