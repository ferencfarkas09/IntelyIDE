//! Certificate chains for the TLS fake. One test CA per `Pki`; leaf certificates are issued per scenario.

use std::net::Ipv4Addr;
use std::sync::Arc;

use rcgen::{BasicConstraints, CertificateParams, DnType, ExtendedKeyUsagePurpose, IsCa, Issuer, KeyPair, KeyUsagePurpose, SanType};
use tokio_rustls::rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use tokio_rustls::rustls::server::WebPkiClientVerifier;
use tokio_rustls::rustls::{crypto::aws_lc_rs, RootCertStore, ServerConfig};

pub struct Pki {
    ca: rcgen::Certificate,
    /// The CA's own parameters and key: what signs the leaf certificates.
    issuer: Issuer<'static, KeyPair>,
    pub ca_pem: String,
}

/// What the leaf certificate is valid for.
pub enum Names {
    /// IP SAN 127.0.0.1: matches a client that connects to `127.0.0.1`.
    Loopback,
    /// DNS SAN only: a client that connects to an IP, or to another name, must refuse it.
    Dns(&'static str),
}

pub struct Leaf {
    pub chain: Vec<CertificateDer<'static>>,
    pub key_der: Vec<u8>,
    /// Certificate and key as one PEM file (a client certificate file for `tlsCertificateKeyFile`).
    pub combined_pem: String,
}

impl Pki {
    pub fn new(name: &str) -> Self {
        let mut p = CertificateParams::new(Vec::<String>::new()).unwrap();
        p.distinguished_name.push(DnType::CommonName, name);
        p.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        p.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
        let ca_key = KeyPair::generate().unwrap();
        let ca = p.self_signed(&ca_key).unwrap();
        let ca_pem = ca.pem();
        Self { ca, issuer: Issuer::new(p, ca_key), ca_pem }
    }

    fn issue(&self, names: Names, client: bool, expired: bool) -> Leaf {
        let mut p = CertificateParams::new(Vec::<String>::new()).unwrap();
        p.distinguished_name.push(DnType::CommonName, if client { "fake-client" } else { "fake-server" });
        p.subject_alt_names = match names {
            Names::Loopback => vec![SanType::IpAddress(Ipv4Addr::LOCALHOST.into())],
            Names::Dns(n) => vec![SanType::DnsName(n.try_into().unwrap())],
        };
        p.extended_key_usages = vec![if client { ExtendedKeyUsagePurpose::ClientAuth } else { ExtendedKeyUsagePurpose::ServerAuth }];
        if expired {
            p.not_before = rcgen::date_time_ymd(2000, 1, 1);
            p.not_after = rcgen::date_time_ymd(2001, 1, 1);
        }
        let key = KeyPair::generate().unwrap();
        let cert = p.signed_by(&key, &self.issuer).unwrap();
        Leaf {
            chain: vec![cert.der().clone()],
            key_der: key.serialize_der(),
            combined_pem: format!("{}{}", cert.pem(), key.serialize_pem()),
        }
    }

    pub fn server(&self, names: Names) -> Leaf {
        self.issue(names, false, false)
    }
    pub fn expired_server(&self, names: Names) -> Leaf {
        self.issue(names, false, true)
    }
    pub fn client(&self) -> Leaf {
        self.issue(Names::Dns("fake-client.test"), true, false)
    }
}

/// `client_ca`: demand a client certificate signed by that CA.
pub fn server_config(leaf: &Leaf, client_ca: Option<&Pki>) -> Arc<ServerConfig> {
    let provider = Arc::new(aws_lc_rs::default_provider());
    let b = ServerConfig::builder_with_provider(provider.clone()).with_safe_default_protocol_versions().unwrap();
    let b = match client_ca {
        None => b.with_no_client_auth(),
        Some(ca) => {
            let mut roots = RootCertStore::empty();
            roots.add(ca.ca.der().clone()).unwrap();
            b.with_client_cert_verifier(WebPkiClientVerifier::builder_with_provider(Arc::new(roots), provider).build().unwrap())
        }
    };
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(leaf.key_der.clone()));
    Arc::new(b.with_single_cert(leaf.chain.clone(), key).unwrap())
}
