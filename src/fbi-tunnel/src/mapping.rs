use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq)]
pub struct Override {
    pub local: u16,
    pub remote: u16,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Mapping {
    pub local: u16,
    pub remote: u16,
}

pub fn merge_mappings(discovered: &[u16], overrides: &[Override]) -> Vec<Mapping> {
    let mut by_remote: HashMap<u16, u16> = discovered.iter().map(|&p| (p, p)).collect();
    for o in overrides {
        by_remote.insert(o.remote, o.local);
    }
    let mut out: Vec<Mapping> = by_remote
        .into_iter()
        .map(|(remote, local)| Mapping { local, remote })
        .collect();
    out.sort_by_key(|m| m.remote);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovered_with_no_overrides() {
        let result = merge_mappings(&[5173, 9229], &[]);
        let mut ports: Vec<u16> = result.iter().map(|m| m.remote).collect();
        ports.sort();
        assert_eq!(ports, vec![5173, 9229]);
        for m in &result {
            assert_eq!(m.local, m.remote);
        }
    }

    #[test]
    fn override_replaces_local_for_matching_remote() {
        let result = merge_mappings(
            &[5173],
            &[Override {
                local: 8080,
                remote: 5173,
            }],
        );
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].remote, 5173);
        assert_eq!(result[0].local, 8080);
    }

    #[test]
    fn override_adds_mapping_not_in_discovered() {
        let result = merge_mappings(
            &[],
            &[Override {
                local: 3000,
                remote: 5173,
            }],
        );
        assert_eq!(result.len(), 1);
        assert_eq!(
            result[0],
            Mapping {
                local: 3000,
                remote: 5173
            }
        );
    }

    #[test]
    fn empty_both() {
        assert_eq!(merge_mappings(&[], &[]), vec![]);
    }

    #[test]
    fn override_wins_over_same_remote() {
        let result = merge_mappings(
            &[5173],
            &[Override {
                local: 8080,
                remote: 5173,
            }],
        );
        assert_eq!(result[0].local, 8080);
    }
}
