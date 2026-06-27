#!/usr/bin/env node

import { runConnector } from './runner.js';
import { runOAuthLogin } from './oauthLogin.js';
import { runProfileCommand } from './profileCommands.js';

const command = process.argv[2];

(
  command === 'login'
    ? runOAuthLogin()
    : command === 'profile' || command === 'sync'
      ? runProfileCommand()
      : runConnector()
).catch((error) => {
  console.error('[6ducklearn-connector] fatal error:', error);
  process.exit(1);
});
