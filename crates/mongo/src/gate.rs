//! The dial gate of a jailed session (feature `mongo`, unix).
//!
//! The member pre-flight (`driver::preflight_members`) asks every seed once, before the real client exists. That is a point in time:
//! a seed that was silent then, or a set that changes its member list later, makes the driver's topology monitor dial a member
//! nobody looked at. The gate closes that for good: in a jailed session whose topology the driver discovers, the real client reaches
//! every server through this loopback SOCKS5 server, which judges EACH destination against the seeds the user described
//! ([`SeedRule`], the rule the pre-flight uses) at the moment the driver dials it. An outsider is refused before any socket to it
//! exists (so a LAN address nobody asked for sees no connection at all), and its name is kept so the connection check can say so.
//!
//! It is plain forwarding: no TLS is touched (the driver verifies the real server name end to end), nothing is logged, nothing is
//! written to disk. Random per-gate credentials keep other local processes out of it, and it dies with the session that owns it.

use std::io;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use tokio::io::AsyncWriteExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::task::{JoinHandle, JoinSet};

use crate::host::SeedRule;
use crate::tunnel::socks::{self, ct_eq, reply, Dest, SocksError};

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// The driver opens a handful of sockets per member; a runaway local client cannot exhaust descriptors through the gate.
const MAX_STREAMS: usize = 256;
const MAX_REFUSED: usize = 32;

struct Shared {
    rule: SeedRule,
    user: String,
    pass: String,
    connect: Duration,
    refused: Mutex<Vec<String>>,
    streams: AtomicUsize,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

struct Slot(Arc<Shared>);

impl Slot {
    fn acquire(sh: &Arc<Shared>) -> Option<Slot> {
        if sh.streams.fetch_add(1, Ordering::SeqCst) >= MAX_STREAMS {
            sh.streams.fetch_sub(1, Ordering::SeqCst);
            None
        } else {
            Some(Slot(sh.clone()))
        }
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        self.0.streams.fetch_sub(1, Ordering::SeqCst);
    }
}

pub struct DialGate {
    shared: Arc<Shared>,
    port: u16,
    task: Option<JoinHandle<()>>,
}

impl std::fmt::Debug for DialGate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // never the credentials
        f.debug_struct("DialGate").field("port", &self.port).finish()
    }
}

fn random_hex() -> io::Result<String> {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).map_err(|e| io::Error::other(e.to_string()))?;
    Ok(b.iter().map(|x| format!("{x:02x}")).collect())
}

impl DialGate {
    /// Binds `127.0.0.1:0` and starts accepting. `connect` bounds one dial to a server.
    pub async fn start(rule: SeedRule, connect: Duration) -> io::Result<DialGate> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let port = listener.local_addr()?.port();
        let shared = Arc::new(Shared { rule, user: random_hex()?, pass: random_hex()?, connect, refused: Mutex::new(Vec::new()), streams: AtomicUsize::new(0) });
        let task = tokio::spawn(accept_loop(shared.clone(), listener));
        Ok(DialGate { shared, port, task: Some(task) })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// The per-gate credentials the driver authenticates with.
    pub fn credentials(&self) -> (String, String) {
        (self.shared.user.clone(), self.shared.pass.clone())
    }

    /// The destinations refused so far (`host:port`, deduplicated, at most 32).
    pub fn refused(&self) -> Vec<String> {
        lock(&self.shared.refused).clone()
    }
}

impl Drop for DialGate {
    /// Works without a runtime: aborting the accept task drops its listener and every stream task with their sockets.
    fn drop(&mut self) {
        if let Some(t) = self.task.take() {
            t.abort();
        }
    }
}

async fn accept_loop(sh: Arc<Shared>, listener: TcpListener) {
    let mut tasks: JoinSet<()> = JoinSet::new();
    loop {
        tokio::select! {
            Some(_) = tasks.join_next(), if !tasks.is_empty() => {}
            accepted = listener.accept() => match accepted {
                Ok((sock, _)) => {
                    tasks.spawn(handle_conn(sh.clone(), sock));
                }
                // out of descriptors or a transient accept error: back off instead of spinning
                Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
            },
        }
    }
}

async fn handshake(sh: &Shared, sock: &mut TcpStream) -> Result<socks::Request, SocksError> {
    let methods = socks::read_greeting(sock).await?;
    let method = socks::choose_method(&methods);
    socks::write_method(sock, method).await?;
    if method.is_none() {
        return Err(SocksError::NoAcceptableMethod);
    }
    let (user, pass) = socks::read_password_auth(sock).await?;
    // both comparisons always run
    let ok = ct_eq(&user, sh.user.as_bytes()) & ct_eq(&pass, sh.pass.as_bytes());
    socks::write_auth_status(sock, ok).await?;
    if !ok {
        return Err(SocksError::Auth);
    }
    match socks::read_request(sock).await {
        Ok(r) => Ok(r),
        Err(e) => {
            let _ = socks::write_reply(sock, e.reply_code()).await;
            Err(e)
        }
    }
}

fn dial_failure(e: &io::Error) -> u8 {
    match e.kind() {
        io::ErrorKind::ConnectionRefused => reply::CONNECTION_REFUSED,
        io::ErrorKind::TimedOut => reply::HOST_UNREACHABLE,
        _ => reply::NETWORK_UNREACHABLE,
    }
}

async fn handle_conn(sh: Arc<Shared>, mut sock: TcpStream) {
    let _ = sock.set_nodelay(true);
    let req = match tokio::time::timeout(HANDSHAKE_TIMEOUT, handshake(&sh, &mut sock)).await {
        Ok(Ok(r)) => r,
        _ => return,
    };
    let host = match req.dest {
        // the request does not keep the address, so it cannot be judged: refused (loopback sets name their seeds by IPv4 or name)
        Dest::Ipv6 => {
            let _ = socks::write_reply(&mut sock, reply::ADDRESS_TYPE_NOT_SUPPORTED).await;
            return;
        }
        Dest::Ipv4(ip) => ip.to_string(),
        Dest::Name(n) => n,
    };
    let member = format!("{host}:{}", req.port);
    if sh.rule.outside(std::slice::from_ref(&member)) {
        {
            let mut list = lock(&sh.refused);
            if list.len() < MAX_REFUSED && !list.contains(&member) {
                list.push(member);
            }
        }
        let _ = socks::write_reply(&mut sock, reply::NOT_ALLOWED).await;
        return;
    }
    let Some(_slot) = Slot::acquire(&sh) else {
        let _ = socks::write_reply(&mut sock, reply::GENERAL_FAILURE).await;
        return;
    };
    let mut upstream = match tokio::time::timeout(sh.connect, TcpStream::connect((host.as_str(), req.port))).await {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => {
            let _ = socks::write_reply(&mut sock, dial_failure(&e)).await;
            return;
        }
        Err(_) => {
            let _ = socks::write_reply(&mut sock, reply::HOST_UNREACHABLE).await;
            return;
        }
    };
    let _ = upstream.set_nodelay(true);
    if socks::write_reply(&mut sock, reply::SUCCEEDED).await.is_err() {
        return;
    }
    let _ = tokio::io::copy_bidirectional(&mut sock, &mut upstream).await;
    let _ = sock.shutdown().await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn rule(hosts: &[&str]) -> SeedRule {
        SeedRule::from_hosts(hosts.iter().map(|h| h.to_string()).collect())
    }

    /// A SOCKS5 client: greeting, password auth, CONNECT to a domain name. Returns the reply code and the open socket.
    async fn connect_via(gate: &DialGate, user: &str, pass: &str, host: &str, port: u16) -> io::Result<(u8, TcpStream)> {
        let mut s = TcpStream::connect(("127.0.0.1", gate.port())).await?;
        s.write_all(&[5, 1, 2]).await?;
        let mut m = [0u8; 2];
        s.read_exact(&mut m).await?;
        assert_eq!(m, [5, 2]);
        let mut auth = vec![1, user.len() as u8];
        auth.extend(user.as_bytes());
        auth.push(pass.len() as u8);
        auth.extend(pass.as_bytes());
        s.write_all(&auth).await?;
        let mut st = [0u8; 2];
        s.read_exact(&mut st).await?;
        if st[1] != 0 {
            return Ok((0xff, s));
        }
        let mut req = vec![5, 1, 0, 3, host.len() as u8];
        req.extend(host.as_bytes());
        req.extend(port.to_be_bytes());
        s.write_all(&req).await?;
        let mut rep = [0u8; 10];
        s.read_exact(&mut rep).await?;
        Ok((rep[1], s))
    }

    #[tokio::test]
    async fn a_seed_is_forwarded_and_an_outsider_is_refused_without_a_socket() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let echo = tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut b = [0u8; 4];
            s.read_exact(&mut b).await.unwrap();
            s.write_all(&b).await.unwrap();
        });
        let trap = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let trap_port = trap.local_addr().unwrap().port();
        let hits = Arc::new(AtomicUsize::new(0));
        let h = hits.clone();
        let trap_task = tokio::spawn(async move {
            while trap.accept().await.is_ok() {
                h.fetch_add(1, Ordering::SeqCst);
            }
        });
        // the rule is the seeds only; the trap runs on loopback here, so judge it by a name that is not a seed and not loopback
        let gate = DialGate::start(rule(&["127.0.0.1"]), Duration::from_secs(2)).await.unwrap();
        let (u, p) = gate.credentials();
        let (code, mut s) = connect_via(&gate, &u, &p, "127.0.0.1", port).await.unwrap();
        assert_eq!(code, reply::SUCCEEDED);
        s.write_all(b"ping").await.unwrap();
        let mut back = [0u8; 4];
        s.read_exact(&mut back).await.unwrap();
        assert_eq!(&back, b"ping", "bytes pass both ways");
        // a destination outside the seeds: refused, remembered, never dialled
        for outsider in ["10.255.255.254", "db3.corp.example"] {
            let (code, _s) = connect_via(&gate, &u, &p, outsider, trap_port).await.unwrap();
            assert_eq!(code, reply::NOT_ALLOWED, "{outsider}");
        }
        assert_eq!(gate.refused(), vec![format!("10.255.255.254:{trap_port}"), format!("db3.corp.example:{trap_port}")]);
        assert_eq!(hits.load(Ordering::SeqCst), 0);
        // the same refusal twice is one entry
        let _ = connect_via(&gate, &u, &p, "10.255.255.254", trap_port).await.unwrap();
        assert_eq!(gate.refused().len(), 2);
        echo.await.unwrap();
        trap_task.abort();
    }

    #[tokio::test]
    async fn wrong_credentials_and_no_password_method_get_nothing() {
        let gate = DialGate::start(rule(&["127.0.0.1"]), Duration::from_secs(1)).await.unwrap();
        let (code, _s) = connect_via(&gate, "nobody", "nothing", "127.0.0.1", 1).await.unwrap();
        assert_eq!(code, 0xff, "wrong credentials end at the authentication step");
        let mut s = TcpStream::connect(("127.0.0.1", gate.port())).await.unwrap();
        s.write_all(&[5, 1, 0]).await.unwrap(); // only "no authentication" offered
        let mut m = [0u8; 2];
        s.read_exact(&mut m).await.unwrap();
        assert_eq!(m, [5, 0xff]);
        assert!(gate.refused().is_empty());
    }

    #[tokio::test]
    async fn a_refused_dial_reports_the_server_side_failure() {
        let closed = {
            let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
            l.local_addr().unwrap().port()
        };
        let gate = DialGate::start(rule(&["127.0.0.1"]), Duration::from_secs(1)).await.unwrap();
        let (u, p) = gate.credentials();
        let (code, _s) = connect_via(&gate, &u, &p, "127.0.0.1", closed).await.unwrap();
        assert_eq!(code, reply::CONNECTION_REFUSED);
        assert!(gate.refused().is_empty(), "a refused dial is not a refused destination");
    }

    #[tokio::test]
    async fn dropping_the_gate_closes_its_port() {
        let gate = DialGate::start(rule(&["127.0.0.1"]), Duration::from_secs(1)).await.unwrap();
        let port = gate.port();
        drop(gate);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(TcpStream::connect(("127.0.0.1", port)).await.is_err());
    }
}
