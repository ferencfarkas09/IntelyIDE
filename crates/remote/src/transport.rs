//! The transport seam (remote-plan 2.2): Noise sits above it, so a relay WebSocket, a loopback test pipe, or later a
//! tunnel / LAN transport are interchangeable. A transport is started inside the gateway's runtime and hands back two channels;
//! dropping the handle aborts its task, which closes the socket (zero cost when Remote is off: no handle, nothing running).

use std::sync::{Arc, Mutex};

use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::identity::Identity;

/// Identifies a peer on the transport: the device id, or a temporary `pair-xxxx` id on a pairing socket.
pub type LinkId = String;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NotifyKind {
    NeedsYou,
    Finished,
    Failed,
    Brief,
}

impl NotifyKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            NotifyKind::NeedsYou => "needsYou",
            NotifyKind::Finished => "finished",
            NotifyKind::Failed => "failed",
            NotifyKind::Brief => "brief",
        }
    }
}

/// Plaintext control layer between the Mac and the relay. Never carries content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Admin {
    DevAdd { id: String, hash: String },
    DevRevoke { id: String },
    PairOpen { hash: String, ttl_ms: u64 },
    Notify { kind: NotifyKind, collapse_key: Option<String> },
    RoomWipe,
}

#[derive(Debug)]
pub enum Inbound {
    Connected,
    Disconnected,
    Frame { link: LinkId, bytes: Vec<u8> },
    PeerDown(LinkId),
}

#[derive(Debug)]
pub enum Outbound {
    Frame { link: LinkId, bytes: Vec<u8> },
    Admin(Admin),
    /// Best effort: a transport that cannot close a single peer ignores it (the gateway drops the session anyway).
    Close(LinkId),
}

pub struct TransportHandle {
    pub tx: mpsc::Sender<Outbound>,
    pub rx: mpsc::Receiver<Inbound>,
    /// Aborted when the handle drops.
    pub task: Option<JoinHandle<()>>,
}

impl Drop for TransportHandle {
    fn drop(&mut self) {
        if let Some(t) = self.task.take() {
            t.abort();
        }
    }
}

pub trait Transport: Send {
    fn name(&self) -> &'static str;
    /// Called inside the gateway runtime. `identity` carries the room id and the Mac token.
    fn start(self: Box<Self>, identity: &Identity) -> TransportHandle;
}

/// An in-process pipe for tests: the test holds the [`LoopbackPeer`] and plays relay and phones.
pub struct Loopback {
    mac_tx: mpsc::Sender<Outbound>,
    mac_rx: mpsc::Receiver<Inbound>,
}

pub struct LoopbackPeer {
    to_mac: mpsc::Sender<Inbound>,
    from_mac: mpsc::Receiver<Outbound>,
    pub admin: Arc<Mutex<Vec<Admin>>>,
}

pub fn loopback() -> (Loopback, LoopbackPeer) {
    let (out_tx, out_rx) = mpsc::channel(1024);
    let (in_tx, in_rx) = mpsc::channel(1024);
    (Loopback { mac_tx: out_tx, mac_rx: in_rx }, LoopbackPeer { to_mac: in_tx, from_mac: out_rx, admin: Arc::new(Mutex::new(Vec::new())) })
}

impl Transport for Loopback {
    fn name(&self) -> &'static str {
        "loopback"
    }

    fn start(self: Box<Self>, _identity: &Identity) -> TransportHandle {
        let Loopback { mac_tx, mac_rx } = *self;
        TransportHandle { tx: mac_tx, rx: mac_rx, task: None }
    }
}

impl LoopbackPeer {
    pub async fn connected(&self) {
        let _ = self.to_mac.send(Inbound::Connected).await;
    }

    pub async fn send(&self, link: &str, bytes: Vec<u8>) {
        let _ = self.to_mac.send(Inbound::Frame { link: link.into(), bytes }).await;
    }

    pub async fn peer_down(&self, link: &str) {
        let _ = self.to_mac.send(Inbound::PeerDown(link.into())).await;
    }

    /// The next frame the Mac sent, skipping (and recording) admin messages. `None` once the Mac closed its side.
    pub async fn recv(&mut self) -> Option<(LinkId, Vec<u8>)> {
        loop {
            match self.from_mac.recv().await? {
                Outbound::Frame { link, bytes } => return Some((link, bytes)),
                Outbound::Admin(a) => self.admin.lock().unwrap().push(a),
                Outbound::Close(_) => {}
            }
        }
    }

    pub async fn recv_timeout(&mut self, ms: u64) -> Option<(LinkId, Vec<u8>)> {
        tokio::time::timeout(std::time::Duration::from_millis(ms), self.recv()).await.ok().flatten()
    }

    /// True once the Mac side dropped its sender (gateway stopped).
    pub fn mac_closed(&mut self) -> bool {
        matches!(self.from_mac.try_recv(), Err(mpsc::error::TryRecvError::Disconnected))
    }
}
