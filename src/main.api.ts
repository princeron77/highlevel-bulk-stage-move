import { apiPort } from './config.js';
import { createApp } from './api/create-app.js';

const app = await createApp();
await app.listen(apiPort(), '0.0.0.0');
