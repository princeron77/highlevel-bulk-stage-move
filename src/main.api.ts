/** Entry point of the API process. The worker has its own entry point (main.worker.ts). */
import { apiPort } from './config.js';
import { createApp } from './api/create-app.js';

const app = await createApp();
await app.listen(apiPort(), '0.0.0.0');
