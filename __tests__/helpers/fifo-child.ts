import { FIFO_READERS } from "./fifo-readers.js";

// argv: <row name> <lease dir>. Prints the row's result as JSON; `undefined` prints as `null`.
const [, , name, dir] = process.argv;
console.log(JSON.stringify(FIFO_READERS[name!]!.run(dir!) ?? null));
