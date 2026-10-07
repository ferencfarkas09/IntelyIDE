// Qwen Code profile on the generic ACP adapter. Loaded lazily like every adapter; never run against the real program yet.
import { makeAcpProvider } from './index.js';
import { QWEN } from './profiles.js';

export default makeAcpProvider(QWEN);
