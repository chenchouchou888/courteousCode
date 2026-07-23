use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

const KEYCHAIN_SERVICE: &str = "com.blackbox.app.provider-api-key.v1";
const CREDENTIAL_PREFIX: &str = "provider-api-key:";
const DEV_STORE_ENV: &str = "BLACKBOX_DEV_CREDENTIAL_STORE_FILE";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CredentialMetadata {
    pub credential_ref: String,
    pub credential_hint: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct IsolatedCredentialFile {
    version: u8,
    secrets: BTreeMap<String, String>,
}

pub(crate) fn reference_for_provider(provider_id: &str) -> Result<String, String> {
    let trimmed = provider_id.trim();
    if trimmed.is_empty()
        || !trimmed
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("Provider ID is not valid for credential storage".to_string());
    }
    Ok(format!("{CREDENTIAL_PREFIX}{trimmed}"))
}

pub(crate) fn hint_for_secret(secret: &str) -> String {
    let suffix: String = secret
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    if suffix.is_empty() {
        String::new()
    } else {
        format!("•••• {suffix}")
    }
}

fn account_from_reference(credential_ref: &str) -> Result<&str, String> {
    let account = credential_ref
        .strip_prefix(CREDENTIAL_PREFIX)
        .ok_or_else(|| "Credential reference has an unsupported namespace".to_string())?;
    if account.is_empty()
        || !account
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("Credential reference contains an invalid provider ID".to_string());
    }
    Ok(account)
}

fn configured_dev_store() -> Result<Option<PathBuf>, String> {
    if !cfg!(debug_assertions) {
        return Ok(None);
    }
    match std::env::var_os(DEV_STORE_ENV) {
        Some(value) if !value.is_empty() => Ok(Some(PathBuf::from(value))),
        _ => Ok(None),
    }
}

fn read_isolated_store(path: &Path) -> Result<IsolatedCredentialFile, String> {
    if !path.exists() {
        return Ok(IsolatedCredentialFile {
            version: 1,
            secrets: BTreeMap::new(),
        });
    }
    let bytes = std::fs::read(path)
        .map_err(|error| format!("Cannot read isolated credential store: {error}"))?;
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("Cannot parse isolated credential store: {error}"))
}

fn write_isolated_store(path: &Path, data: &IsolatedCredentialFile) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Isolated credential store has no parent directory".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("Cannot create isolated credential directory: {error}"))?;
    let bytes = serde_json::to_vec_pretty(data)
        .map_err(|error| format!("Cannot serialize isolated credential store: {error}"))?;
    let temp = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
    std::fs::write(&temp, bytes)
        .map_err(|error| format!("Cannot stage isolated credential store: {error}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("Cannot protect isolated credential store: {error}"))?;
    }

    std::fs::rename(&temp, path)
        .map_err(|error| format!("Cannot replace isolated credential store: {error}"))
}

fn put_isolated(path: &Path, credential_ref: &str, secret: &str) -> Result<(), String> {
    let mut data = read_isolated_store(path)?;
    data.version = 1;
    data.secrets
        .insert(credential_ref.to_string(), secret.to_string());
    write_isolated_store(path, &data)
}

fn get_isolated(path: &Path, credential_ref: &str) -> Result<String, String> {
    read_isolated_store(path)?
        .secrets
        .get(credential_ref)
        .cloned()
        .ok_or_else(|| "Provider credential is missing from the isolated store".to_string())
}

fn delete_isolated(path: &Path, credential_ref: &str) -> Result<(), String> {
    let mut data = read_isolated_store(path)?;
    data.secrets.remove(credential_ref);
    data.version = 1;
    write_isolated_store(path, &data)
}

#[cfg(target_os = "macos")]
fn put_keychain(account: &str, secret: &str) -> Result<(), String> {
    security_framework::passwords::set_generic_password(
        KEYCHAIN_SERVICE,
        account,
        secret.as_bytes(),
    )
    .map_err(|error| format!("macOS Keychain rejected the provider credential: {error}"))
}

#[cfg(target_os = "macos")]
fn get_keychain(account: &str) -> Result<String, String> {
    use security_framework::passwords::{generic_password, PasswordOptions};
    let bytes = generic_password(PasswordOptions::new_generic_password(
        KEYCHAIN_SERVICE,
        account,
    ))
    .map_err(|error| format!("Cannot read provider credential from macOS Keychain: {error}"))?;
    String::from_utf8(bytes)
        .map_err(|_| "Provider credential in macOS Keychain is not valid UTF-8".to_string())
}

#[cfg(target_os = "macos")]
fn delete_keychain(account: &str) -> Result<(), String> {
    match security_framework::passwords::delete_generic_password(KEYCHAIN_SERVICE, account) {
        Ok(()) => Ok(()),
        Err(error) if error.code() == -25_300 => Ok(()),
        Err(error) => Err(format!(
            "Cannot delete provider credential from macOS Keychain: {error}"
        )),
    }
}

pub(crate) fn store_provider_secret(
    provider_id: &str,
    secret: &str,
) -> Result<CredentialMetadata, String> {
    let secret = secret.trim();
    if secret.is_empty() {
        return Err("Provider credential cannot be empty".to_string());
    }
    let credential_ref = reference_for_provider(provider_id)?;
    let account = account_from_reference(&credential_ref)?;

    if let Some(path) = configured_dev_store()? {
        put_isolated(&path, &credential_ref, secret)?;
        let verified = get_isolated(&path, &credential_ref)?;
        if verified != secret {
            return Err("Isolated credential verification failed".to_string());
        }
    } else {
        if cfg!(debug_assertions) {
            return Err(format!(
                "Development builds refuse the real Keychain; launch through run-isolated.sh so {DEV_STORE_ENV} is configured"
            ));
        }
        #[cfg(target_os = "macos")]
        {
            put_keychain(account, secret)?;
            let verified = get_keychain(account)?;
            if verified != secret {
                return Err("macOS Keychain credential verification failed".to_string());
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = account;
            return Err(
                "Secure provider credentials are not implemented on this platform yet".to_string(),
            );
        }
    }

    Ok(CredentialMetadata {
        credential_ref,
        credential_hint: hint_for_secret(secret),
    })
}

pub(crate) fn load_provider_secret(credential_ref: &str) -> Result<String, String> {
    let account = account_from_reference(credential_ref)?;
    if let Some(path) = configured_dev_store()? {
        return get_isolated(&path, credential_ref);
    }
    if cfg!(debug_assertions) {
        return Err(format!(
            "Development builds refuse the real Keychain; {DEV_STORE_ENV} is not configured"
        ));
    }
    #[cfg(target_os = "macos")]
    {
        get_keychain(account)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = account;
        Err("Secure provider credentials are not implemented on this platform yet".to_string())
    }
}

pub(crate) fn delete_provider_secret(credential_ref: &str) -> Result<(), String> {
    let account = account_from_reference(credential_ref)?;
    if let Some(path) = configured_dev_store()? {
        return delete_isolated(&path, credential_ref);
    }
    if cfg!(debug_assertions) {
        return Err(format!(
            "Development builds refuse the real Keychain; {DEV_STORE_ENV} is not configured"
        ));
    }
    #[cfg(target_os = "macos")]
    {
        delete_keychain(account)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = account;
        Err("Secure provider credentials are not implemented on this platform yet".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        delete_isolated, get_isolated, hint_for_secret, put_isolated, reference_for_provider,
    };

    #[test]
    fn references_are_stable_and_reject_unsafe_provider_ids() {
        assert_eq!(
            reference_for_provider("relay_01").unwrap(),
            "provider-api-key:relay_01"
        );
        assert!(reference_for_provider("../relay").is_err());
        assert!(reference_for_provider("").is_err());
    }

    #[test]
    fn credential_hints_reveal_only_the_last_four_characters() {
        assert_eq!(hint_for_secret("sk-example-1234"), "•••• 1234");
        assert_eq!(hint_for_secret("abc"), "•••• abc");
        assert!(!hint_for_secret("sk-example-1234").contains("example"));
    }

    #[test]
    fn isolated_backend_round_trips_and_deletes_synthetic_secrets() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("credentials.json");
        let reference = "provider-api-key:fixture";
        put_isolated(&path, reference, "test-only-secret").unwrap();
        assert_eq!(get_isolated(&path, reference).unwrap(), "test-only-secret");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }

        delete_isolated(&path, reference).unwrap();
        assert!(get_isolated(&path, reference).is_err());
    }
}
