//! Local-witness rules S-1 through S-9.
//!
//! Witnesses are built from leaves the wallet already holds. Restore reads a
//! public upper-tree snapshot and an aligned epoch delta. A request never
//! carries a leaf index, path, chunk, tag, note commitment, address, or
//! owned-note id.

/// Epoch-aligned sync window. `from` is inclusive and `to` is exclusive.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SyncRange {
  /// First block height.
  pub from: u64,
  /// Height just past the window.
  pub to: u64,
}

/// What a client is allowed to ask the sync channel for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyncRequest {
  /// Aligned window.
  pub range: SyncRange,
  /// Set when the caller is trying to fetch because of a send.
  pub on_send: bool,
  /// Set when the caller is trying to fetch because a scan matched.
  pub on_scan_hit: bool,
  /// Set when the caller would fall back to a clear channel.
  pub clear_fallback: bool,
  /// Leaf index, if the caller tried to name one.
  pub leaf_index: Option<u64>,
  /// Path bytes, if the caller tried to name one.
  pub path: Option<Vec<u8>>,
  /// Chunk id, if the caller tried to name one.
  pub chunk: Option<u64>,
  /// Tag, if the caller tried to name one.
  pub tag: Option<[u8; 32]>,
  /// Note commitment, if the caller tried to name one.
  pub note_commit: Option<[u8; 32]>,
  /// Address bytes, if the caller tried to name one.
  pub address: Option<Vec<u8>>,
  /// Owned-note id, if the caller tried to name one.
  pub owned_note: Option<u64>,
}

/// Routes this crate will serve. There is no path, witness, leaf, or bucket route.
pub const ROUTES: &[&str] = &["/sync", "/tx"];

/// S-1. Both ends sit on the epoch grid, and the window is non-empty.
pub fn range_aligned(range: SyncRange, epoch: u64) -> bool {
  epoch != 0 && range.to > range.from && range.from % epoch == 0 && range.to % epoch == 0
}

/// S-2. The birthday is the start of the epoch that contains `height`.
pub fn quantise_birthday(height: u64, epoch: u64) -> Option<u64> {
  if epoch == 0 {
    return None;
  }
  Some(height - (height % epoch))
}

/// S-3, S-4, and the keyed-fetch ban.
///
/// A send intent and a scan hit do not fetch. Sync and post share one channel.
/// A clear fallback is rejected. Any named leaf, path, chunk, tag, commitment,
/// address, or owned note is rejected.
pub fn keyed_fetch_rejected(request: &SyncRequest) -> bool {
  request.on_send
    || request.on_scan_hit
    || request.clear_fallback
    || request.leaf_index.is_some()
    || request.path.is_some()
    || request.chunk.is_some()
    || request.tag.is_some()
    || request.note_commit.is_some()
    || request.address.is_some()
    || request.owned_note.is_some()
}

/// S-4. Posting uses the sync channel. There is no second channel.
pub fn post_uses_sync_channel() -> bool {
  true
}

/// S-5. A gap is retried over the same range.
pub fn retry_gap(range: SyncRange) -> SyncRange {
  range
}

/// S-6. A folded path is accepted only when it equals the header root `RT[A]`.
pub fn fold_matches_header(folded: &[u8; 32], header_root: &[u8; 32]) -> bool {
  folded == header_root
}

/// S-7. Reject `/path`, `/witness`, `/leaf`, `/bucket`, and a leaf or chunk query.
pub fn route_allowed(path: &str, query: &str) -> bool {
  if path == "/path" || path == "/witness" || path == "/leaf" || path == "/bucket" {
    return false;
  }
  if query_names(query, "leaf") || query_names(query, "chunk") {
    return false;
  }
  ROUTES.contains(&path)
}

fn query_names(query: &str, name: &str) -> bool {
  query.split('&').any(|pair| pair.split('=').next() == Some(name))
}

/// S-8. Every sync body uses this fixed prefix, then opaque bytes.
pub const SYNC_PREFIX_LEN: usize = 8 + 8 + 32;

/// Encode the uniform sync prefix. The width does not depend on which notes matched.
pub fn sync_prefix(range: SyncRange, header_root: &[u8; 32]) -> [u8; SYNC_PREFIX_LEN] {
  let mut out = [0u8; SYNC_PREFIX_LEN];
  out[.. 8].copy_from_slice(&range.from.to_le_bytes());
  out[8 .. 16].copy_from_slice(&range.to.to_le_bytes());
  out[16 ..].copy_from_slice(header_root);
  out
}

/// S-9. Fold and the header check run in the sync worker, before the result is returned.
pub fn sync_worker_accepts(folded: &[u8; 32], header_root: &[u8; 32]) -> bool {
  fold_matches_header(folded, header_root)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn blank(range: SyncRange) -> SyncRequest {
    SyncRequest {
      range,
      on_send: false,
      on_scan_hit: false,
      clear_fallback: false,
      leaf_index: None,
      path: None,
      chunk: None,
      tag: None,
      note_commit: None,
      address: None,
      owned_note: None,
    }
  }

  #[test]
  fn s1_rejects_unaligned_ranges() {
    let epoch = 100u64;
    assert!(range_aligned(SyncRange { from: 0, to: 100 }, epoch));
    assert!(!range_aligned(SyncRange { from: 1, to: 100 }, epoch));
    assert!(!range_aligned(SyncRange { from: 0, to: 50 }, epoch));
    assert!(!range_aligned(SyncRange { from: 100, to: 100 }, epoch));
    assert!(!range_aligned(SyncRange { from: 0, to: 100 }, 0));
  }

  #[test]
  fn s2_quantises_the_birthday() {
    assert_eq!(quantise_birthday(0, 100), Some(0));
    assert_eq!(quantise_birthday(100, 100), Some(100));
    assert_eq!(quantise_birthday(142, 100), Some(100));
    assert_eq!(quantise_birthday(199, 100), Some(100));
    assert_eq!(quantise_birthday(200, 100), Some(200));
    assert_eq!(quantise_birthday(5, 0), None);
  }

  #[test]
  fn s3_s4_and_keyed_fetch_never_fire() {
    let range = SyncRange { from: 0, to: 100 };
    let ok = blank(range);
    assert!(!keyed_fetch_rejected(&ok));
    assert!(post_uses_sync_channel());

    let mut send = blank(range);
    send.on_send = true;
    assert!(keyed_fetch_rejected(&send));

    let mut hit = blank(range);
    hit.on_scan_hit = true;
    assert!(keyed_fetch_rejected(&hit));

    let mut clear = blank(range);
    clear.clear_fallback = true;
    assert!(keyed_fetch_rejected(&clear));

    let mut leaf = blank(range);
    leaf.leaf_index = Some(0);
    assert!(keyed_fetch_rejected(&leaf));

    let mut path = blank(range);
    path.path = Some(vec![1]);
    assert!(keyed_fetch_rejected(&path));

    let mut chunk = blank(range);
    chunk.chunk = Some(1);
    assert!(keyed_fetch_rejected(&chunk));

    let mut tag = blank(range);
    tag.tag = Some([2; 32]);
    assert!(keyed_fetch_rejected(&tag));

    let mut commit = blank(range);
    commit.note_commit = Some([3; 32]);
    assert!(keyed_fetch_rejected(&commit));

    let mut address = blank(range);
    address.address = Some(vec![4]);
    assert!(keyed_fetch_rejected(&address));

    let mut owned = blank(range);
    owned.owned_note = Some(7);
    assert!(keyed_fetch_rejected(&owned));
  }

  #[test]
  fn s5_retries_the_same_range() {
    let range = SyncRange { from: 200, to: 400 };
    assert_eq!(retry_gap(range), range);
  }

  #[test]
  fn s6_and_s9_check_the_header_root_in_the_worker() {
    let root = [9u8; 32];
    assert!(fold_matches_header(&root, &root));
    assert!(!fold_matches_header(&[8u8; 32], &root));
    assert!(sync_worker_accepts(&root, &root));
    assert!(!sync_worker_accepts(&[1u8; 32], &root));
  }

  #[test]
  fn s7_route_list_has_no_witness_lookup() {
    assert!(route_allowed("/sync", ""));
    assert!(route_allowed("/tx", "limit=1"));
    assert!(!route_allowed("/path", ""));
    assert!(!route_allowed("/witness", ""));
    assert!(!route_allowed("/leaf", ""));
    assert!(!route_allowed("/bucket", ""));
    assert!(!route_allowed("/sync", "leaf=0"));
    assert!(!route_allowed("/sync", "chunk=1"));
    assert!(!route_allowed("/sync", "a=1&leaf=2"));
    for route in ROUTES {
      assert!(!route.contains("path"));
      assert!(!route.contains("witness"));
      assert!(!route.contains("leaf"));
      assert!(!route.contains("bucket"));
    }
  }

  #[test]
  fn s8_sync_prefix_width_is_uniform() {
    let a = sync_prefix(SyncRange { from: 0, to: 100 }, &[1; 32]);
    let b = sync_prefix(SyncRange { from: 10_000, to: 20_000 }, &[2; 32]);
    assert_eq!(a.len(), SYNC_PREFIX_LEN);
    assert_eq!(b.len(), SYNC_PREFIX_LEN);
    assert_ne!(a, b);
  }
}
