//! A minimal SOCKS5 listener (no authentication) in front of the TLS fake. It records every destination the client asks
//! for and connects them all to one local target port, so a host name that does not resolve anywhere still "works" and
//! the test can prove the driver sent the NAME (domain address type) and verified the certificate against it.

use std::sync::{Arc, Mutex};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;

pub struct FakeSocks {
    pub port: u16,
    /// `(address type, host or ip text, port)` per CONNECT request.
    pub requests: Arc<Mutex<Vec<(u8, String, u16)>>>,
    task: JoinHandle<()>,
}

impl Drop for FakeSocks {
    fn drop(&mut self) {
        self.task.abort();
    }
}

pub async fn spawn_socks5(target_port: u16) -> FakeSocks {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let seen = requests.clone();
    let task = tokio::spawn(async move {
        while let Ok((s, _)) = l.accept().await {
            let seen = seen.clone();
            tokio::spawn(async move {
                let _ = handle(s, target_port, seen).await;
            });
        }
    });
    FakeSocks { port, requests, task }
}

async fn handle(mut s: TcpStream, target: u16, seen: Arc<Mutex<Vec<(u8, String, u16)>>>) -> std::io::Result<()> {
    let mut g = [0u8; 2];
    s.read_exact(&mut g).await?;
    let mut methods = vec![0u8; g[1] as usize];
    s.read_exact(&mut methods).await?;
    s.write_all(&[5, 0]).await?;
    let mut r = [0u8; 4];
    s.read_exact(&mut r).await?;
    let atyp = r[3];
    let host = match atyp {
        1 => {
            let mut a = [0u8; 4];
            s.read_exact(&mut a).await?;
            format!("{}.{}.{}.{}", a[0], a[1], a[2], a[3])
        }
        3 => {
            let mut l = [0u8; 1];
            s.read_exact(&mut l).await?;
            let mut n = vec![0u8; l[0] as usize];
            s.read_exact(&mut n).await?;
            String::from_utf8_lossy(&n).into_owned()
        }
        _ => {
            s.write_all(&[5, 8, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
            return Ok(());
        }
    };
    let mut p = [0u8; 2];
    s.read_exact(&mut p).await?;
    seen.lock().unwrap().push((atyp, host, u16::from_be_bytes(p)));
    let mut up = TcpStream::connect(("127.0.0.1", target)).await?;
    s.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
    tokio::io::copy_bidirectional(&mut s, &mut up).await?;
    Ok(())
}
