import type { Logger } from "./types.js";

const RED = "\x1b[0;31m";
const GREEN = "\x1b[0;32m";
const YELLOW = "\x1b[1;33m";
const BLUE = "\x1b[0;34m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const NC = "\x1b[0m";

export const colors = { RED, GREEN, YELLOW, BLUE, BOLD, DIM, NC };

export const consoleLogger: Logger = {
  info(message: string) {
    console.log(`${GREEN}\u2713${NC} ${message}`);
  },
  warn(message: string) {
    console.error(`${YELLOW}\u26a0${NC} ${message}`);
  },
  error(message: string) {
    console.error(`${RED}\u2717${NC} ${message}`);
  },
  step(message: string) {
    console.log(`\n${BLUE}---${NC} ${message}`);
  },
  header(message: string) {
    const bar = `${BLUE}\u2501`.repeat(60) + NC;
    console.log(bar);
    console.log(`${BLUE}  ${message}${NC}`);
    console.log(bar);
  },
};

export function createSilentLogger(): Logger {
  return {
    info() {},
    warn() {},
    error() {},
    step() {},
    header() {},
  };
}
