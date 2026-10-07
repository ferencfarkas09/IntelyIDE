// GitHub Copilot CLI profile on the generic ACP adapter. Loaded lazily like every adapter; never run against the real program yet.
import { makeAcpProvider } from './index.js';
import { COPILOT } from './profiles.js';

export default makeAcpProvider(COPILOT);
