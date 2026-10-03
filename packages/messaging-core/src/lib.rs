use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use openmls::{
    credentials::{BasicCredential, CredentialWithKey},
    framing::{
        MlsMessageBodyIn, MlsMessageIn, MlsMessageOut, ProcessedMessageContent, ProtocolMessage,
    },
    group::{GroupId, MlsGroup, MlsGroupJoinConfig, StagedWelcome},
    key_packages::{KeyPackage, KeyPackageIn},
    prelude::{ProtocolVersion, SignatureScheme},
    treesync::RatchetTreeIn,
};
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_traits::{OpenMlsProvider, types::Ciphersuite};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use tls_codec::{DeserializeBytes, Serialize as TlsSerialize};
use wasm_bindgen::prelude::*;

const CIPHERSUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;
const MAX_SNAPSHOT_BYTES: usize = 64 * 1024 * 1024;
const MAX_SNAPSHOT_GROUPS: usize = 10_000;
const MAX_SNAPSHOT_STORAGE_ENTRIES: usize = 100_000;
const MAX_GROUP_ID_BYTES: usize = 255;

fn js(error: impl std::fmt::Display) -> JsError {
    JsError::new(&error.to_string())
}

fn serialize_message(message: &MlsMessageOut) -> Result<Vec<u8>, JsError> {
    message.tls_serialize_detached().map_err(js)
}

fn parse_key_package(provider: &OpenMlsRustCrypto, bytes: &[u8]) -> Result<KeyPackage, JsError> {
    let (package, remainder) = KeyPackageIn::tls_deserialize_bytes(bytes).map_err(js)?;
    if !remainder.is_empty() {
        return Err(js("trailing KeyPackage bytes"));
    }
    package
        .validate(provider.crypto(), ProtocolVersion::Mls10)
        .map_err(js)
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
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

#[derive(Serialize, Deserialize, Debug, PartialEq)]
struct ProcessMessageOutput {
    plaintext: String,
    sender_device_id: String,
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
        if identity.is_empty() || identity.len() > 512 {
            return Err(js("invalid MLS identity"));
        }
        let provider = OpenMlsRustCrypto::default();
        let signer = SignatureKeyPair::new(SignatureScheme::ED25519).map_err(js)?;
        signer.store(provider.storage()).map_err(js)?;
        let identity = identity.to_vec();
        let credential = CredentialWithKey {
            credential: BasicCredential::new(identity.clone()).into(),
            signature_key: signer.public().into(),
        };
        Ok(Self {
            provider,
            signer,
            credential,
            identity,
            groups: vec![],
        })
    }

    pub fn import_state(bytes: &[u8]) -> Result<MlsClient, JsError> {
        if bytes.is_empty() || bytes.len() > MAX_SNAPSHOT_BYTES {
            return Err(js("invalid MLS snapshot size"));
        }
        let snapshot: Snapshot = serde_json::from_slice(bytes).map_err(js)?;
        if snapshot.version != 1 {
            return Err(js("unsupported MLS snapshot"));
        }
        if snapshot.identity.is_empty() || snapshot.identity.len() > 512 {
            return Err(js("invalid MLS snapshot identity"));
        }
        if snapshot.groups.len() > MAX_SNAPSHOT_GROUPS
            || snapshot
                .groups
                .iter()
                .any(|group| group.is_empty() || group.len() > MAX_GROUP_ID_BYTES)
        {
            return Err(js("invalid MLS snapshot groups"));
        }
        let mut unique_groups = HashSet::with_capacity(snapshot.groups.len());
        if snapshot
            .groups
            .iter()
            .any(|group| !unique_groups.insert(group.as_slice()))
        {
            return Err(js("duplicate MLS snapshot group"));
        }
        if snapshot.storage.len() > MAX_SNAPSHOT_STORAGE_ENTRIES {
            return Err(js("invalid MLS snapshot storage"));
        }
        let provider = OpenMlsRustCrypto::default();
        {
            let mut storage = provider
                .storage()
                .values
                .write()
                .map_err(|_| js("MLS storage lock poisoned"))?;
            let mut decoded_bytes = 0usize;
            for (key, value) in snapshot.storage {
                let key = URL_SAFE_NO_PAD.decode(key).map_err(js)?;
                let value = URL_SAFE_NO_PAD.decode(value).map_err(js)?;
                decoded_bytes = decoded_bytes
                    .checked_add(key.len())
                    .and_then(|size| size.checked_add(value.len()))
                    .ok_or_else(|| js("invalid MLS snapshot storage"))?;
                if decoded_bytes > MAX_SNAPSHOT_BYTES || storage.insert(key, value).is_some() {
                    return Err(js("invalid MLS snapshot storage"));
                }
            }
        }
        let signer = SignatureKeyPair::read(
            provider.storage(),
            &snapshot.signing_public,
            SignatureScheme::ED25519,
        )
        .ok_or_else(|| js("MLS signing key missing from snapshot"))?;
        let identity = snapshot.identity;
        let credential = CredentialWithKey {
            credential: BasicCredential::new(identity.clone()).into(),
            signature_key: signer.public().into(),
        };
        for group_id in &snapshot.groups {
            if MlsGroup::load(provider.storage(), &GroupId::from_slice(group_id))
                .map_err(js)?
                .is_none()
            {
                return Err(js("MLS snapshot group state is missing"));
            }
        }
        Ok(Self {
            provider,
            signer,
            credential,
            identity,
            groups: snapshot.groups,
        })
    }

    pub fn export_state(&self) -> Result<Vec<u8>, JsError> {
        let values = self
            .provider
            .storage()
            .values
            .read()
            .map_err(|_| js("MLS storage lock poisoned"))?;
        let storage = values
            .iter()
            .map(|(key, value)| (URL_SAFE_NO_PAD.encode(key), URL_SAFE_NO_PAD.encode(value)))
            .collect();
        serde_json::to_vec(&Snapshot {
            version: 1,
            identity: self.identity.clone(),
            signing_public: self.signer.to_public_vec(),
            groups: self.groups.clone(),
            storage,
        })
        .map_err(js)
    }

    /// Returns a JSON array of base64url TLS-serialized one-time KeyPackages.
    pub fn generate_key_packages(&self, count: u16) -> Result<Vec<u8>, JsError> {
        if count == 0 || count > 100 {
            return Err(js("invalid KeyPackage count"));
        }
        let mut packages = Vec::with_capacity(count as usize);
        for _ in 0..count {
            let package = KeyPackage::builder()
                .build(
                    CIPHERSUITE,
                    &self.provider,
                    &self.signer,
                    self.credential.clone(),
                )
                .map_err(js)?;
            packages.push(
                URL_SAFE_NO_PAD.encode(package.key_package().tls_serialize_detached().map_err(js)?),
            );
        }
        serde_json::to_vec(&packages).map_err(js)
    }

    /// `key_packages_json` is a JSON array of base64url KeyPackages, one for
    /// every other device leaf that should join the initial epoch.
    pub fn create_group(
        &mut self,
        group_id: &[u8],
        key_packages_json: &[u8],
    ) -> Result<Vec<u8>, JsError> {
        if group_id.is_empty() || group_id.len() > MAX_GROUP_ID_BYTES {
            return Err(js("invalid MLS group id"));
        }
        if self.groups.len() >= MAX_SNAPSHOT_GROUPS || self.groups.iter().any(|id| id == group_id) {
            return Err(js("MLS group already exists or device group limit reached"));
        }
        let encoded: Vec<String> = serde_json::from_slice(key_packages_json).map_err(js)?;
        let packages = encoded
            .iter()
            .map(|value| URL_SAFE_NO_PAD.decode(value).map_err(js))
            .map(|bytes| bytes.and_then(|bytes| parse_key_package(&self.provider, &bytes)))
            .collect::<Result<Vec<_>, _>>()?;
        let mut group = MlsGroup::builder()
            .ciphersuite(CIPHERSUITE)
            .with_group_id(GroupId::from_slice(group_id))
            .build(&self.provider, &self.signer, self.credential.clone())
            .map_err(js)?;
        let welcome = if packages.is_empty() {
            None
        } else {
            let (_commit, welcome, _) = group
                .add_members(&self.provider, &self.signer, &packages)
                .map_err(js)?;
            group.merge_pending_commit(&self.provider).map_err(js)?;
            Some(welcome)
        };
        let tree: RatchetTreeIn = group.export_ratchet_tree().into();
        let output = CreateGroupOutput {
            // A creator-only MLS group has no recipient and therefore no
            // Welcome. It is used for the account's saved-messages room.
            welcome: welcome
                .as_ref()
                .map(serialize_message)
                .transpose()?
                .map(|bytes| URL_SAFE_NO_PAD.encode(bytes))
                .unwrap_or_default(),
            ratchet_tree: URL_SAFE_NO_PAD.encode(tree.tls_serialize_detached().map_err(js)?),
            epoch: group.epoch().as_u64(),
        };
        if !self.groups.iter().any(|id| id == group_id) {
            self.groups.push(group_id.to_vec());
        }
        serde_json::to_vec(&output).map_err(js)
    }

    pub fn join_group(
        &mut self,
        welcome_bytes: &[u8],
        tree_bytes: &[u8],
    ) -> Result<Vec<u8>, JsError> {
        if self.groups.len() >= MAX_SNAPSHOT_GROUPS {
            return Err(js("device group limit reached"));
        }
        let (message, remainder) =
            MlsMessageIn::tls_deserialize_bytes(welcome_bytes).map_err(js)?;
        if !remainder.is_empty() {
            return Err(js("trailing Welcome bytes"));
        }
        let welcome = match message.extract() {
            MlsMessageBodyIn::Welcome(welcome) => welcome,
            _ => return Err(js("expected MLS Welcome")),
        };
        let (tree, remainder) = RatchetTreeIn::tls_deserialize_bytes(tree_bytes).map_err(js)?;
        if !remainder.is_empty() {
            return Err(js("trailing ratchet tree bytes"));
        }
        let config = MlsGroupJoinConfig::builder().build();
        let staged = StagedWelcome::new_from_welcome(&self.provider, &config, welcome, Some(tree))
            .map_err(js)?;
        let id = staged.group_context().group_id().as_slice().to_vec();
        if id.is_empty()
            || id.len() > MAX_GROUP_ID_BYTES
            || self.groups.iter().any(|known| known == &id)
        {
            return Err(js("invalid or duplicate MLS group id"));
        }
        staged.into_group(&self.provider).map_err(js)?;
        self.groups.push(id.clone());
        Ok(id)
    }

    pub fn encrypt_message(
        &mut self,
        group_id: &[u8],
        plaintext: &[u8],
    ) -> Result<Vec<u8>, JsError> {
        let mut group = self.load_group(group_id)?;
        let message = group
            .create_message(&self.provider, &self.signer, plaintext)
            .map_err(js)?;
        serialize_message(&message)
    }

    /// Returns authenticated application plaintext and the MLS credential
    /// identity of its sender. Proposal/Commit/control processing returns an
    /// empty plaintext after atomically updating the local epoch.
    pub fn process_message(
        &mut self,
        group_id: &[u8],
        wire_message: &[u8],
    ) -> Result<Vec<u8>, JsError> {
        let mut group = self.load_group(group_id)?;
        let (message, remainder) = MlsMessageIn::tls_deserialize_bytes(wire_message).map_err(js)?;
        if !remainder.is_empty() {
            return Err(js("trailing MLS message bytes"));
        }
        let protocol: ProtocolMessage = match message.extract() {
            MlsMessageBodyIn::PublicMessage(message) => message.into(),
            MlsMessageBodyIn::PrivateMessage(message) => message.into(),
            _ => return Err(js("unexpected MLS message type")),
        };
        let processed = group
            .process_message(&self.provider, protocol)
            .map_err(js)?;
        let sender = BasicCredential::try_from(processed.credential().clone()).map_err(js)?;
        let sender_device_id = String::from_utf8(sender.identity().to_vec()).map_err(js)?;
        if sender_device_id.is_empty() || sender_device_id.len() > 512 {
            return Err(js("invalid MLS sender identity"));
        }
        let plaintext = match processed.into_content() {
            ProcessedMessageContent::ApplicationMessage(message) => message.into_bytes(),
            ProcessedMessageContent::ProposalMessage(proposal)
            | ProcessedMessageContent::ExternalJoinProposalMessage(proposal) => {
                group
                    .store_pending_proposal(self.provider.storage(), *proposal)
                    .map_err(js)?;
                vec![]
            }
            ProcessedMessageContent::StagedCommitMessage(commit) => {
                group
                    .merge_staged_commit(&self.provider, *commit)
                    .map_err(js)?;
                vec![]
            }
            ProcessedMessageContent::OwnPendingCommit => {
                group.merge_pending_commit(&self.provider).map_err(js)?;
                vec![]
            }
            ProcessedMessageContent::OwnPrivateMessage => vec![],
        };
        serde_json::to_vec(&ProcessMessageOutput {
            plaintext: URL_SAFE_NO_PAD.encode(plaintext),
            sender_device_id,
        })
        .map_err(js)
    }

    pub fn add_members(
        &mut self,
        group_id: &[u8],
        key_packages_json: &[u8],
    ) -> Result<Vec<u8>, JsError> {
        let encoded: Vec<String> = serde_json::from_slice(key_packages_json).map_err(js)?;
        let packages = encoded
            .iter()
            .map(|value| URL_SAFE_NO_PAD.decode(value).map_err(js))
            .map(|bytes| bytes.and_then(|bytes| parse_key_package(&self.provider, &bytes)))
            .collect::<Result<Vec<_>, _>>()?;
        let mut group = self.load_group(group_id)?;
        let (commit, welcome, _) = group
            .add_members(&self.provider, &self.signer, &packages)
            .map_err(js)?;
        group.merge_pending_commit(&self.provider).map_err(js)?;
        self.commit_output(&group, commit, Some(welcome))
    }

    /// Removes all leaves whose BasicCredential identity exactly matches one
    /// of the base64url values in `identities_json`.
    pub fn remove_members(
        &mut self,
        group_id: &[u8],
        identities_json: &[u8],
    ) -> Result<Vec<u8>, JsError> {
        let encoded: Vec<String> = serde_json::from_slice(identities_json).map_err(js)?;
        let wanted = encoded
            .iter()
            .map(|value| URL_SAFE_NO_PAD.decode(value).map_err(js))
            .collect::<Result<Vec<_>, _>>()?;
        let mut group = self.load_group(group_id)?;
        let leaves = group
            .members()
            .filter(|member| {
                BasicCredential::try_from(member.credential.clone())
                    .ok()
                    .is_some_and(|credential| {
                        wanted
                            .iter()
                            .any(|identity| credential.identity() == identity.as_slice())
                    })
            })
            .map(|member| member.index)
            .collect::<Vec<_>>();
        if leaves.is_empty() {
            return Err(js("MLS member not found"));
        }
        let (commit, _, _) = group
            .remove_members(&self.provider, &self.signer, &leaves)
            .map_err(js)?;
        group.merge_pending_commit(&self.provider).map_err(js)?;
        self.commit_output(&group, commit, None)
    }

    pub fn epoch(&self, group_id: &[u8]) -> Result<u64, JsError> {
        Ok(self.load_group(group_id)?.epoch().as_u64())
    }
}

impl MlsClient {
    fn load_group(&self, group_id: &[u8]) -> Result<MlsGroup, JsError> {
        MlsGroup::load(self.provider.storage(), &GroupId::from_slice(group_id))
            .map_err(js)?
            .ok_or_else(|| js("MLS group not found"))
    }

    fn commit_output(
        &self,
        group: &MlsGroup,
        commit: MlsMessageOut,
        welcome: Option<MlsMessageOut>,
    ) -> Result<Vec<u8>, JsError> {
        let tree: RatchetTreeIn = group.export_ratchet_tree().into();
        serde_json::to_vec(&CommitOutput {
            commit: URL_SAFE_NO_PAD.encode(serialize_message(&commit)?),
            welcome: welcome
                .as_ref()
                .map(serialize_message)
                .transpose()?
                .map(|bytes| URL_SAFE_NO_PAD.encode(bytes)),
            ratchet_tree: URL_SAFE_NO_PAD.encode(tree.tls_serialize_detached().map_err(js)?),
            epoch: group.epoch().as_u64(),
        })
        .map_err(js)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key_packages(client: &MlsClient, count: u16) -> Vec<String> {
        serde_json::from_slice(&client.generate_key_packages(count).unwrap()).unwrap()
    }

    fn create_two_member_group(
        alice: &mut MlsClient,
        bob: &mut MlsClient,
        group_id: &[u8],
    ) -> CreateGroupOutput {
        let packages = key_packages(bob, 1);
        let created: CreateGroupOutput = serde_json::from_slice(
            &alice
                .create_group(group_id, &serde_json::to_vec(&packages).unwrap())
                .unwrap(),
        )
        .unwrap();
        bob.join_group(
            &URL_SAFE_NO_PAD.decode(&created.welcome).unwrap(),
            &URL_SAFE_NO_PAD.decode(&created.ratchet_tree).unwrap(),
        )
        .unwrap();
        created
    }

    #[test]
    fn two_member_round_trip_and_snapshot() {
        let mut alice = MlsClient::new(b"@alice:example|alice-device").unwrap();
        let mut bob = MlsClient::new(b"@bob:example|bob-device").unwrap();
        create_two_member_group(&mut alice, &mut bob, b"!room:example");
        let wire = alice
            .encrypt_message(b"!room:example", b"hello over RFC 9420")
            .unwrap();
        let processed: ProcessMessageOutput =
            serde_json::from_slice(&bob.process_message(b"!room:example", &wire).unwrap()).unwrap();
        assert_eq!(
            processed.plaintext,
            URL_SAFE_NO_PAD.encode(b"hello over RFC 9420")
        );
        assert_eq!(processed.sender_device_id, "@alice:example|alice-device");
        let mut charlie = MlsClient::new(b"charlie-device").unwrap();
        let charlie_packages = key_packages(&charlie, 1);
        let added: CommitOutput = serde_json::from_slice(
            &alice
                .add_members(
                    b"!room:example",
                    &serde_json::to_vec(&charlie_packages).unwrap(),
                )
                .unwrap(),
        )
        .unwrap();
        bob.process_message(
            b"!room:example",
            &URL_SAFE_NO_PAD.decode(&added.commit).unwrap(),
        )
        .unwrap();
        charlie
            .join_group(
                &URL_SAFE_NO_PAD.decode(added.welcome.unwrap()).unwrap(),
                &URL_SAFE_NO_PAD.decode(added.ratchet_tree).unwrap(),
            )
            .unwrap();
        let from_charlie = charlie
            .encrypt_message(b"!room:example", b"hello after add")
            .unwrap();
        let alice_processed: ProcessMessageOutput = serde_json::from_slice(
            &alice
                .process_message(b"!room:example", &from_charlie)
                .unwrap(),
        )
        .unwrap();
        let bob_processed: ProcessMessageOutput = serde_json::from_slice(
            &bob.process_message(b"!room:example", &from_charlie)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            alice_processed.plaintext,
            URL_SAFE_NO_PAD.encode(b"hello after add")
        );
        assert_eq!(bob_processed, alice_processed);
        assert_eq!(bob_processed.sender_device_id, "charlie-device");

        let identities =
            serde_json::to_vec(&vec![URL_SAFE_NO_PAD.encode(b"@bob:example|bob-device")]).unwrap();
        let removed: CommitOutput =
            serde_json::from_slice(&alice.remove_members(b"!room:example", &identities).unwrap())
                .unwrap();
        let recovered_alice = MlsClient::import_state(&alice.export_state().unwrap()).unwrap();
        assert_eq!(
            recovered_alice.epoch(b"!room:example").unwrap(),
            removed.epoch
        );
        bob.process_message(
            b"!room:example",
            &URL_SAFE_NO_PAD.decode(&removed.commit).unwrap(),
        )
        .unwrap();
        charlie
            .process_message(
                b"!room:example",
                &URL_SAFE_NO_PAD.decode(&removed.commit).unwrap(),
            )
            .unwrap();
        let after_remove = alice
            .encrypt_message(b"!room:example", b"future-secret")
            .unwrap();
        let processed: ProcessMessageOutput = serde_json::from_slice(
            &charlie
                .process_message(b"!room:example", &after_remove)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            processed.plaintext,
            URL_SAFE_NO_PAD.encode(b"future-secret")
        );
        assert_eq!(processed.sender_device_id, "@alice:example|alice-device");
        let restored = MlsClient::import_state(&charlie.export_state().unwrap()).unwrap();
        assert_eq!(restored.epoch(b"!room:example").unwrap(), 3);
    }

    #[test]
    fn creator_only_group_supports_saved_messages() {
        let mut alice = MlsClient::new(b"@alice:example|alice-device").unwrap();
        let created: CreateGroupOutput = serde_json::from_slice(
            &alice.create_group(b"!saved:example", b"[]").unwrap(),
        )
        .unwrap();
        assert_eq!(created.epoch, 0);
        assert!(created.welcome.is_empty());
        assert_eq!(alice.epoch(b"!saved:example").unwrap(), 0);
        assert!(!alice.encrypt_message(b"!saved:example", b"private note").unwrap().is_empty());

        let restored = MlsClient::import_state(&alice.export_state().unwrap()).unwrap();
        assert_eq!(restored.epoch(b"!saved:example").unwrap(), 0);
    }
}
