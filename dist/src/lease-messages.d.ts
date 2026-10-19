/**
 * The text of the lease's two user-facing lines, shared by the CLI and hook mode so they cannot drift apart. ship-dag's
 * give-up rule matches the `lease: no slot after` prefix. Does no work at load, so the library barrel can import it.
 */
import type { LeaseHandle, LeaseRefusal, LeaseStatus } from "./lease.js";
export declare const seconds: (ms: number) => number;
/** The admitted line; the hook prints the same text as `additionalContext`. */
export declare function formatAdmitted(a: LeaseHandle["admission"]): string;
/** The no-slot line; the hook denies with it as the reason. */
export declare function formatNoSlot(refusal: LeaseRefusal, status: LeaseStatus): string;
/** The disk-full line; the hook denies with it and the CLI prints it. Unlike `formatNoSlot` it says not to rerun. */
export declare function formatDiskFull(refusal: LeaseRefusal): string;
/** The one text of any refusal: the disk-full line for `disk-full`, else the no-slot line. */
export declare const formatRefusal: (refusal: LeaseRefusal, status: LeaseStatus) => string;
/** Why a refusal stops work: `disk-full` for a full disk, else `memory-critical`. */
export declare const refusalStopReason: (refusal: LeaseRefusal) => "memory-critical" | "disk-full";
/** The CLI's exit code for a refusal: 74 for a full disk, else 75 (no slot). */
export declare const refusalExitCode: (refusal: LeaseRefusal) => number;
