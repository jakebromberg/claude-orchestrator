import type { Logger } from "./types.js";
export declare const colors: {
    RED: string;
    GREEN: string;
    YELLOW: string;
    BLUE: string;
    BOLD: string;
    DIM: string;
    NC: string;
};
export declare const consoleLogger: Logger;
export declare function createSilentLogger(): Logger;
