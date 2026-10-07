//! Classifier for the folders macOS guards with a privacy prompt (TCC), (design notes: workspaces-spec) 3.6.3.
//! Pure path arithmetic: nothing here touches the disk, so classifying never triggers a prompt.

use std::path::Path;

use crate::types::ProtectedFolder;

/// The protected folder `path` is, or lies inside. `home` is the user's home directory.
pub fn classify(path: &Path, home: &Path) -> Option<ProtectedFolder> {
    if let Ok(rest) = path.strip_prefix("/Volumes") {
        // `/Volumes` itself only lists mount names; every mount below it is guarded.
        return rest.components().next().map(|_| ProtectedFolder::Volume);
    }
    let rest = path.strip_prefix(home).ok()?;
    let mut comps = rest.components();
    let first = comps.next()?.as_os_str().to_str()?;
    match first {
        "Desktop" => Some(ProtectedFolder::Desktop),
        "Documents" => Some(ProtectedFolder::Documents),
        "Downloads" => Some(ProtectedFolder::Downloads),
        "Movies" => Some(ProtectedFolder::Movies),
        "Music" => Some(ProtectedFolder::Music),
        "Pictures" => Some(ProtectedFolder::Pictures),
        "Library" => match comps.next().and_then(|c| c.as_os_str().to_str()) {
            Some("Mobile Documents") => Some(ProtectedFolder::Icloud),
            Some("CloudStorage") => Some(ProtectedFolder::CloudStorage),
            _ => Some(ProtectedFolder::Library),
        },
        _ => None,
    }
}

/// Whether the children of `parent` must not be probed for `.git` (the folder itself is guarded).
pub fn is_guarded(parent: &Path, home: &Path) -> bool {
    classify(parent, home).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_by_name_without_touching_the_disk() {
        let home = Path::new("/Users/alice");
        assert_eq!(classify(Path::new("/Users/alice/Documents/x/y"), home), Some(ProtectedFolder::Documents));
        assert_eq!(classify(Path::new("/Users/alice/Desktop"), home), Some(ProtectedFolder::Desktop));
        assert_eq!(classify(Path::new("/Users/alice/Library/Mobile Documents/c"), home), Some(ProtectedFolder::Icloud));
        assert_eq!(classify(Path::new("/Users/alice/Library/CloudStorage"), home), Some(ProtectedFolder::CloudStorage));
        assert_eq!(classify(Path::new("/Users/alice/Library/Caches"), home), Some(ProtectedFolder::Library));
        assert_eq!(classify(Path::new("/Volumes/Backup"), home), Some(ProtectedFolder::Volume));
        assert_eq!(classify(Path::new("/Volumes"), home), None);
        assert_eq!(classify(Path::new("/Users/alice"), home), None);
        assert_eq!(classify(Path::new("/Users/alice/Projects"), home), None);
        assert_eq!(classify(Path::new("/Users/alice/Documentsx"), home), None);
    }
}
