'use strict';
// Loads ./.env (next to package.json) into process.env. Variables already set in the environment win, so Vercel / CI settings are never overridden.
const { existsSync } = require('node:fs');
const { join } = require('node:path');

const file = join(__dirname, '..', '.env');
if (existsSync(file)) process.loadEnvFile(file);
