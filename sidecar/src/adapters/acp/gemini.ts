// Gemini CLI profile on the generic ACP adapter (A4): `gemini --acp`. Loaded lazily like every adapter.
import { makeAcpProvider } from './index.js';
import { GEMINI } from './profiles.js';

export default makeAcpProvider(GEMINI);
