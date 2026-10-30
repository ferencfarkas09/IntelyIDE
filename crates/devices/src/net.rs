//! The one network call of the feature: "Reload app" asks the running Metro dev server to reload the app through its HTTP
//! control endpoint. The target is always `127.0.0.1` and the port comes from the runner's detected loopback ports, never
//! from the webview, so nothing outside the machine is ever contacted.

use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::time::Duration;

use intely_core::{code, EngineError};

const TIMEOUT: Duration = Duration::from_secs(2);

/// `GET /reload` on `127.0.0.1:<port>`; succeeds on an HTTP 2xx answer.
pub fn reload(port: u16) -> Result<(), EngineError> {
    if port < 1024 {
        return Err(EngineError::new("invalidPort", "not a dev server port"));
    }
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let fail = |what: &str| EngineError::new(code::IO, format!("could not reload the app: {what}"));
    let mut stream = TcpStream::connect_timeout(&addr, TIMEOUT).map_err(|_| fail("the dev server does not answer"))?;
    let _ = stream.set_read_timeout(Some(TIMEOUT));
    let _ = stream.set_write_timeout(Some(TIMEOUT));
    stream.write_all(format!("GET /reload HTTP/1.1\r\nHost: localhost:{port}\r\nConnection: close\r\nUser-Agent: IntelyIDE\r\n\r\n").as_bytes()).map_err(|_| fail("the dev server does not answer"))?;
    let mut head = [0u8; 64];
    let n = stream.read(&mut head).map_err(|_| fail("the dev server did not answer in time"))?;
    let line = String::from_utf8_lossy(&head[..n]);
    let status = line.split_whitespace().nth(1).and_then(|s| s.parse::<u16>().ok());
    match status {
        Some(200..=299) => Ok(()),
        _ => Err(fail("the dev server refused")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    fn serve(reply: &'static str) -> (u16, std::thread::JoinHandle<String>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let h = std::thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            let mut buf = [0u8; 512];
            let n = s.read(&mut buf).unwrap();
            let _ = s.write_all(reply.as_bytes());
            String::from_utf8_lossy(&buf[..n]).into_owned()
        });
        (port, h)
    }

    #[test]
    fn reload_sends_one_get_to_loopback() {
        let (port, h) = serve("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
        reload(port).unwrap();
        let req = h.join().unwrap();
        assert!(req.starts_with("GET /reload HTTP/1.1\r\n") && req.contains(&format!("Host: localhost:{port}")), "{req}");
    }

    #[test]
    fn a_refusal_garbage_or_a_closed_port_is_an_error() {
        let (port, h) = serve("HTTP/1.1 404 Not Found\r\n\r\n");
        assert!(reload(port).is_err());
        h.join().unwrap();
        let (port, h) = serve("\u{0}garbage");
        assert!(reload(port).is_err());
        h.join().unwrap();
        let free = {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        assert!(reload(free).is_err());
        assert_eq!(reload(80).unwrap_err().code, "invalidPort");
    }
}
