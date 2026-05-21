#!/usr/bin/env node

import { runConnector } from './runner.js';
import { runOAuthLogin } from './oauthLogin.js';

const command = process.argv[2];

(command === 'login' ? runOAuthLogin() : runConnector()).catch((error) => {
  console.error('[6ducklearn-connector] fatal error:', error);
  process.exit(1);
});
