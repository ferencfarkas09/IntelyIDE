// Bridges stdin/stdout to 127.0.0.1:<port> (what `ssh -W host:port` does over the control master).
import net from 'node:net';

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1 || port > 65535) process.exit(2);
const sock = net.connect({ host: '127.0.0.1', port, allowHalfOpen: true });
sock.on('error', () => process.exit(255));
sock.on('connect', () => {
  process.stdin.pipe(sock);
  sock.pipe(process.stdout);
});
sock.on('end', () => process.stdout.write('', () => process.exit(0)));
process.stdin.on('end', () => sock.end());
