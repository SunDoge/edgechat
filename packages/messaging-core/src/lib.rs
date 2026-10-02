use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use openmls::{
    credentials::{BasicCredential, CredentialWithKey},
    framing::{MlsMessageBodyIn, MlsMessageIn, MlsMessageOut, ProcessedMessageContent, ProtocolMessage},
    group::{GroupId, MlsGroup, MlsGroupJoinConfig, StagedWelcome},
    key_packages::{KeyPackage, KeyPackageIn},
    prelude::{ProtocolVersion, SignatureScheme},
    treesync::RatchetTreeIn,
};
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_traits::{types::Ciphersuite, OpenMlsProvider};
use serde::{Deserialize, Serialize};
use tls_codec::{DeserializeBytes, Serialize as TlsSerialize};
use wasm_bindgen::prelude::*;

const CIPHERSUITE: Ciphersuite =
    Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;

fn js(error: impl std::fmt::Display) -> JsError { JsError::new(&error.to_string()) }

fn serialize_message(message: &MlsMessageOut) -> Result<Vec<u8>, JsError> {
    message.tls_serialize_detached().map_err(js)
}

fn parse_key_package(provider: &OpenMlsRustCrypto, bytes: &[u8]) -> Result<KeyPackage, JsError> {
    let (package, remainder) = KeyPackageIn::tls_deserialize_bytes(bytes).map_err(js)?;
    if !remainder.is_empty() { return Err(js("trailing KeyPackage bytes")); }
    package.validate(provider.crypto(), ProtocolVersion::Mls10).map_err(js)
}

#[derive(Serialize, Deserialize)]
struct Snapshot {
    version: u8,
    identity: Vec<u8>,
    signing_public: Vec<u8>,
    groups: Vec<Vec<u8>>,
    storage: Vec<(String, String)>,
}

#[derive(Serialize, Deserialize)]
struct CreateGroupOutput {
    welcome: String,
    ratchet_tree: String,
    epoch: u64,
}

#[derive(Serialize, Deserialize)]
struct CommitOutput {
    commit: String,
    welcome: Option<String>,
    ratchet_tree: String,
    epoch: u64,
}

/// One MLS client per browser device. Its provider storage contains private
/// KeyPackage material, group secret trees and past-epoch secrets. Callers must
/// persist `export_state()` after every mutating operation.
#[wasm_bindgen]
pub struct MlsClient {
    provider: OpenMlsRustCrypto,
    signer: SignatureKeyPair,
    credential: CredentialWithKey,
    identity: Vec<u8>,
    groups: Vec<Vec<u8>>,
}

#[wasm_bindgen]
impl MlsClient {
    #[wasm_bindgen(constructor)]
    pub fn new(identity: &[u8]) -> Result<MlsClient, JsError> {
        if identity.is_empty() || identity.len() > 512 { return Err(js("invalid MLS identity")); }
        let provider = OpenMlsRustCrypto::default();
        let signer = SignatureKeyPair::new(SignatureScheme::ED25519).map_err(js)?;
        signer.store(provider.storage()).map_err(js)?;
        let identity = identity.to_vec();
        let credential = CredentialWithKey {
            credential: BasicCredential::new(identity.clone()).into(),
            signature_key: signer.public().into(),
        };
        Ok(Self { provider, signer, credential, identity, groups: vec![] })
    }

    pub fn import_state(bytes: &[u8]) -> Result<MlsClient, JsError> {
        let snapshot: Snapshot = serde_json::from_slice(bytes).map_err(js)?;
        if snapshot.version != 1 { return Err(js("unsupported MLS snapshot")); }
        let provider = OpenMlsRustCrypto::default();
        {
            let mut storage = provider.storage().values.write().map_err(|_| js("MLS storage lock poisoned"))?;
            for (key, value) in snapshot.storage {
                storage.insert(URL_SAFE_NO_PAD.decode(key).map_err(js)?, URL_SAFE_NO_PAD.decode(value).map_err(js)?);
            }
        }
        let signer = SignatureKeyPair::read(provider.storage(), &snapshot.signing_public, SignatureScheme::ED25519)
            .ok_or_else(|| js("MLS signing key missing from snapshot"))?;
        let identity = snapshot.identity;
        let credential = CredentialWithKey {
            credential: BasicCredential::new(identity.clone()).into(),
            signature_key: signer.public().into(),
        };
        Ok(Self { provider, signer, credential, identity, groups: snapshot.groups })
    }

    pub fn export_state(&self) -> Result<Vec<u8>, JsError> {
        let values = self.provider.storage().values.read().map_err(|_| js("MLS storage lock poisoned"))?;
        let storage = values.iter().map(|(key, value)| (URL_SAFE_NO_PAD.encode(key), URL_SAFE_NO_PAD.encode(value))).collect();
        serde_json::to_vec(&Snapshot {
            version: 1,
            identity: self.identity.clone(),
            signing_public: self.signer.to_public_vec(),
            groups: self.groups.clone(),
            storage,
        }).map_err(js)
    }

    /// Returns a JSON array of base64url TLS-serialized one-time KeyPackages.
    pub fn generate_key_packages(&self, count: u16) -> Result<Vec<u8>, JsError> {
        if count == 0 || count > 100 { return Err(js("invalid KeyPackage count")); }
        let mut packages = Vec::with_capacity(count as usize);
        for _ in 0..count {
            let package = KeyPackage::builder().build(
                CIPHERSUITE, &self.provider, &self.signer, self.credential.clone(),
            ).map_err(js)?;
            packages.push(URL_SAFE_NO_PAD.encode(package.key_package().tls_serialize_detached().map_err(js)?));
        }
        serde_json::to_vec(&packages).map_err(js)
    }

    /// `key_packages_json` is a JSON array of base64url KeyPackages, one for
    /// every other device leaf that should join the initial epoch.
    pub fn create_group(&mut self, group_id: &[u8], key_packages_json: &[u8]) -> Result<Vec<u8>, JsError> {
        if group_id.is_empty() { return Err(js("empty MLS group id")); }
        let encoded: Vec<String> = serde_json::from_slice(key_packages_json).map_err(js)?;
        if encoded.is_empty() { return Err(js("MLS group requires another device")); }
        let packages = encoded.iter().map(|value| URL_SAFE_NO_PAD.decode(value).map_err(js))
            .map(|bytes| bytes.and_then(|bytes| parse_key_package(&self.provider, &bytes))).collect::<Result<Vec<_>, _>>()?;
        let mut group = MlsGroup::builder().ciphersuite(CIPHERSUITE)
            .with_group_id(GroupId::from_slice(group_id))
            .build(&self.provider, &self.signer, self.credential.clone()).map_err(js)?;
        let (_commit, welcome, _) = group.add_members(&self.provider, &self.signer, &packages).map_err(js)?;
        group.merge_pending_commit(&mut self.provider).map_err(js)?;
        let tree: RatchetTreeIn = group.export_ratchet_tree().into();
        let output = CreateGroupOutput {
            welcome: URL_SAFE_NO_PAD.encode(serialize_message(&welcome)?),
            ratchet_tree: URL_SAFE_NO_PAD.encode(tree.tls_serialize_detached().map_err(js)?),
            epoch: group.epoch().as_u64(),
        };
        if !self.groups.iter().any(|id| id == group_id) { self.groups.push(group_id.to_vec()); }
        serde_json::to_vec(&output).map_err(js)
    }

    pub fn join_group(&mut self, welcome_bytes: &[u8], tree_bytes: &[u8]) -> Result<Vec<u8>, JsError> {
        let (message, remainder) = MlsMessageIn::tls_deserialize_bytes(welcome_bytes).map_err(js)?;
        if !remainder.is_empty() { return Err(js("trailing Welcome bytes")); }
        let welcome = match message.extract() {
            MlsMessageBodyIn::Welcome(welcome) => welcome,
            _ => return Err(js("expected MLS Welcome")),
        };
        let (tree, remainder) = RatchetTreeIn::tls_deserialize_bytes(tree_bytes).map_err(js)?;
        if !remainder.is_empty() { return Err(js("trailing ratchet tree bytes")); }
        let config = MlsGroupJoinConfig::builder().build();
        let group = StagedWelcome::new_from_welcome(&self.provider, &config, welcome, Some(tree))
            .map_err(js)?.into_group(&self.provider).map_err(js)?;
        let id = group.group_id().as_slice().to_vec();
        if !self.groups.iter().any(|known| known == &id) { self.groups.push(id.clone()); }
        Ok(id)
    }

    pub fn encrypt_message(&mut self, group_id: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, JsError> {
        let mut group = self.load_group(group_id)?;
        let message = group.create_message(&self.provider, &self.signer, plaintext).map_err(js)?;
        serialize_message(&message)
    }

    /// Returns application plaintext. Proposal/Commit/control processing
    /// returns an empty vector after atomically updating the local epoch.
    pub fn process_message(&mut self, group_id: &[u8], wire_message: &[u8]) -> Result<Vec<u8>, JsError> {
        let mut group = self.load_group(group_id)?;
        let (message, remainder) = MlsMessageIn::tls_deserialize_bytes(wire_message).map_err(js)?;
        if !remainder.is_empty() { return Err(js("trailing MLS message bytes")); }
        let protocol: ProtocolMessage = match message.extract() {
            MlsMessageBodyIn::PublicMessage(message) => message.into(),
            MlsMessageBodyIn::PrivateMessage(message) => message.into(),
            _ => return Err(js("unexpected MLS message type")),
        };
        let processed = group.process_message(&self.provider, protocol).map_err(js)?;
        match processed.into_content() {
            ProcessedMessageContent::ApplicationMessage(message) => Ok(message.into_bytes()),
            ProcessedMessageContent::ProposalMessage(proposal)
            | ProcessedMessageContent::ExternalJoinProposalMessage(proposal) => {
                group.store_pending_proposal(self.provider.storage(), *proposal).map_err(js)?; Ok(vec![])
            }
            ProcessedMessageContent::StagedCommitMessage(commit) => {
                group.merge_staged_commit(&mut self.provider, *commit).map_err(js)?; Ok(vec![])
            }
            ProcessedMessageContent::OwnPendingCommit => {
                group.merge_pending_commit(&mut self.provider).map_err(js)?; Ok(vec![])
            }
            ProcessedMessageContent::OwnPrivateMessage => Ok(vec![]),
        }
    }

    pub fn add_members(&mut self, group_id: &[u8], key_packages_json: &[u8]) -> Result<Vec<u8>, JsError> {
        let encoded: Vec<String> = serde_json::from_slice(key_packages_json).map_err(js)?;
        let packages = encoded.iter().map(|value| URL_SAFE_NO_PAD.decode(value).map_err(js))
            .map(|bytes| bytes.and_then(|bytes| parse_key_package(&self.provider, &bytes))).collect::<Result<Vec<_>, _>>()?;
        let mut group = self.load_group(group_id)?;
        let (commit, welcome, _) = group.add_members(&self.provider, &self.signer, &packages).map_err(js)?;
        group.merge_pending_commit(&mut self.provider).map_err(js)?;
        self.commit_output(&group, commit, Some(welcome))
    }

    /// Removes all leaves whose BasicCredential identity exactly matches one
    /// of the base64url values in `identities_json`.
    pub fn remove_members(&mut self, group_id: &[u8], identities_json: &[u8]) -> Result<Vec<u8>, JsError> {
        let encoded: Vec<String> = serde_json::from_slice(identities_json).map_err(js)?;
        let wanted = encoded.iter().map(|value| URL_SAFE_NO_PAD.decode(value).map_err(js)).collect::<Result<Vec<_>, _>>()?;
        let mut group = self.load_group(group_id)?;
        let leaves = group.members().filter(|member| BasicCredential::try_from(member.credential.clone()).ok()
            .is_some_and(|credential| wanted.iter().any(|identity| credential.identity() == identity.as_slice())))
            .map(|member| member.index).collect::<Vec<_>>();
        if leaves.is_empty() { return Err(js("MLS member not found")); }
        let (commit, _, _) = group.remove_members(&self.provider, &self.signer, &leaves).map_err(js)?;
        group.merge_pending_commit(&mut self.provider).map_err(js)?;
        self.commit_output(&group, commit, None)
    }

    pub fn epoch(&self, group_id: &[u8]) -> Result<u64, JsError> {
        Ok(self.load_group(group_id)?.epoch().as_u64())
    }
}

impl MlsClient {
    fn load_group(&self, group_id: &[u8]) -> Result<MlsGroup, JsError> {
        MlsGroup::load(self.provider.storage(), &GroupId::from_slice(group_id)).map_err(js)?
            .ok_or_else(|| js("MLS group not found"))
    }

    fn commit_output(&self, group: &MlsGroup, commit: MlsMessageOut, welcome: Option<MlsMessageOut>) -> Result<Vec<u8>, JsError> {
        let tree: RatchetTreeIn = group.export_ratchet_tree().into();
        serde_json::to_vec(&CommitOutput {
            commit: URL_SAFE_NO_PAD.encode(serialize_message(&commit)?),
            welcome: welcome.as_ref().map(serialize_message).transpose()?.map(|bytes| URL_SAFE_NO_PAD.encode(bytes)),
            ratchet_tree: URL_SAFE_NO_PAD.encode(tree.tls_serialize_detached().map_err(js)?),
            epoch: group.epoch().as_u64(),
        }).map_err(js)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn two_member_round_trip_and_snapshot() {
        let mut alice = MlsClient::new(b"@alice:example|alice-device").unwrap();
        let mut bob = MlsClient::new(b"@bob:example|bob-device").unwrap();
        let packages: Vec<String> = serde_json::from_slice(&bob.generate_key_packages(1).unwrap()).unwrap();
        let created: CreateGroupOutput = serde_json::from_slice(&alice.create_group(b"!room:example", &serde_json::to_vec(&packages).unwrap()).unwrap()).unwrap();
        bob.join_group(&URL_SAFE_NO_PAD.decode(created.welcome).unwrap(), &URL_SAFE_NO_PAD.decode(created.ratchet_tree).unwrap()).unwrap();
        let wire = alice.encrypt_message(b"!room:example", b"hello over RFC 9420").unwrap();
        assert_eq!(bob.process_message(b"!room:example", &wire).unwrap(), b"hello over RFC 9420");
        let mut charlie = MlsClient::new(b"charlie-device").unwrap();
        let charlie_packages: Vec<String> = serde_json::from_slice(&charlie.generate_key_packages(1).unwrap()).unwrap();
        let added: CommitOutput = serde_json::from_slice(&alice.add_members(b"!room:example", &serde_json::to_vec(&charlie_packages).unwrap()).unwrap()).unwrap();
        bob.process_message(b"!room:example", &URL_SAFE_NO_PAD.decode(&added.commit).unwrap()).unwrap();
        charlie.join_group(&URL_SAFE_NO_PAD.decode(added.welcome.unwrap()).unwrap(), &URL_SAFE_NO_PAD.decode(added.ratchet_tree).unwrap()).unwrap();
        let from_charlie = charlie.encrypt_message(b"!room:example", b"hello after add").unwrap();
        assert_eq!(alice.process_message(b"!room:example", &from_charlie).unwrap(), b"hello after add");
        assert_eq!(bob.process_message(b"!room:example", &from_charlie).unwrap(), b"hello after add");

        let identities = serde_json::to_vec(&vec![URL_SAFE_NO_PAD.encode(b"@bob:example|bob-device")]).unwrap();
        let removed: CommitOutput = serde_json::from_slice(&alice.remove_members(b"!room:example", &identities).unwrap()).unwrap();
        let recovered_alice = MlsClient::import_state(&alice.export_state().unwrap()).unwrap();
        assert_eq!(recovered_alice.epoch(b"!room:example").unwrap(), removed.epoch);
        bob.process_message(b"!room:example", &URL_SAFE_NO_PAD.decode(&removed.commit).unwrap()).unwrap();
        charlie.process_message(b"!room:example", &URL_SAFE_NO_PAD.decode(&removed.commit).unwrap()).unwrap();
        let after_remove = alice.encrypt_message(b"!room:example", b"future-secret").unwrap();
        assert_eq!(charlie.process_message(b"!room:example", &after_remove).unwrap(), b"future-secret");
        let restored = MlsClient::import_state(&charlie.export_state().unwrap()).unwrap();
        assert_eq!(restored.epoch(b"!room:example").unwrap(), 3);
    }
}
