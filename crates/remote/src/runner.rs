//! The async shell around [`GatewayCore`]: one loop that moves bytes between the transport, the event bus, the control channel
//! and a coarse timer. It runs on the slot's single thread and ends when the slot drops it; there is nothing else in this crate
//! that spawns, binds or schedules.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::SyncSender;
use std::sync::Arc;
use std::time::Duration;

use intely_agent_core::bus::{EventBus, RecvError};
use tokio::sync::mpsc;

use crate::gateway::{GatewayCore, HostEvent, Out};
use crate::identity::Identity;
use crate::pairing::OfferView;
use crate::transport::{Inbound, Outbound, Transport, TransportHandle};
use crate::wire::Capability;

pub type Reply<T> = SyncSender<T>;

pub enum Control {
    PairStart(Reply<OfferView>),
    PairConfirm { accept: bool, name: Option<String>, capability: Capability },
    PairCancel,
    /// The registry changed on the Mac (revoke, promote, demote): drop or update live sessions now.
    RegistryChanged,
    CapabilityChanged(String),
    /// Send the build-signing key to every live session.
    SendWelcome,
    Kill(Reply<()>),
    Panic(Reply<()>),
    Shutdown,
}

#[derive(Default)]
pub struct RunnerState {
    pub online: AtomicBool,
    pub running: AtomicBool,
}

const TICK: Duration = Duration::from_secs(2);

fn dispatch(outs: Vec<Out>, handle: &TransportHandle, host: &(dyn Fn(HostEvent) + Send + Sync)) {
    for o in outs {
        match o {
            Out::Frame { link, bytes } => {
                let _ = handle.tx.try_send(Outbound::Frame { link, bytes });
            }
            Out::Admin(a) => {
                let _ = handle.tx.try_send(Outbound::Admin(a));
            }
            Out::Close(l) => {
                let _ = handle.tx.try_send(Outbound::Close(l));
            }
            Out::Host(h) => host(h),
        }
    }
}

pub async fn run(
    mut core: GatewayCore,
    bus: EventBus,
    transport: Box<dyn Transport>,
    identity: Identity,
    mut ctl: mpsc::UnboundedReceiver<Control>,
    host: Arc<dyn Fn(HostEvent) + Send + Sync>,
    state: Arc<RunnerState>,
) {
    state.running.store(true, Ordering::SeqCst);
    let mut handle = transport.start(&identity);
    let mut bus_rx = bus.subscribe();
    let mut tick = tokio::time::interval(TICK);
    loop {
        let outs = tokio::select! {
            inb = handle.rx.recv() => match inb {
                None => break,
                Some(Inbound::Frame { link, bytes }) => core.on_frame(&link, &bytes),
                Some(Inbound::PeerDown(l)) => { core.on_peer_down(&l); vec![] }
                Some(Inbound::Connected) => { state.online.store(true, Ordering::SeqCst); vec![] }
                Some(Inbound::Disconnected) => { state.online.store(false, Ordering::SeqCst); vec![] }
            },
            ev = bus_rx.recv() => match ev {
                Ok(e) => core.on_event(&e),
                Err(RecvError::Lagged(_)) => core.on_lagged(),
                Err(RecvError::Closed) => break,
            },
            c = ctl.recv() => match c {
                None | Some(Control::Shutdown) => break,
                Some(Control::PairStart(reply)) => { let (view, outs) = core.pair_start(); let _ = reply.send(view); outs }
                Some(Control::PairConfirm { accept, name, capability }) => core.pair_confirm(accept, name, capability),
                Some(Control::PairCancel) => core.pair_cancel(),
                Some(Control::RegistryChanged) => core.on_registry_changed(),
                Some(Control::CapabilityChanged(id)) => core.on_capability_changed(&id),
                Some(Control::SendWelcome) => core.send_welcome_all(),
                Some(Control::Kill(reply)) => { let outs = core.kill(); dispatch(outs, &handle, host.as_ref()); let _ = reply.send(()); break }
                Some(Control::Panic(reply)) => { let outs = core.panic(); dispatch(outs, &handle, host.as_ref()); let _ = reply.send(()); break }
            },
            _ = tick.tick() => core.tick(),
        };
        let stop = !core.is_enabled();
        dispatch(outs, &handle, host.as_ref());
        if stop {
            break;
        }
    }
    state.online.store(false, Ordering::SeqCst);
    state.running.store(false, Ordering::SeqCst);
    // let queued frames (bye, revoked, the room wipe) leave before the socket is dropped
    let deadline = tokio::time::Instant::now() + Duration::from_millis(1000);
    while handle.tx.capacity() < handle.tx.max_capacity() && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    tokio::time::sleep(Duration::from_millis(50)).await;
}
