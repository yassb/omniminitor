import { dispatch } from './cli.js';

dispatch(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
