import { main } from './commands.js';

const flush = (stream: NodeJS.WriteStream): Promise<void> =>
  new Promise((resolve) => stream.write('', () => resolve()));

main(process.argv.slice(2))
  .then(async (code) => {
    await Promise.all([flush(process.stdout), flush(process.stderr)]);
    process.exit(code);
  })
  .catch((e: unknown) => {
    process.stderr.write(`paces: ${e instanceof Error ? e.stack : String(e)}\n`);
    process.exit(1);
  });
