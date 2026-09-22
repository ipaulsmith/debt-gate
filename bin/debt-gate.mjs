#!/usr/bin/env node

import { runCli } from '../src/cli.mjs';

process.exitCode = runCli(process.argv.slice(2));
