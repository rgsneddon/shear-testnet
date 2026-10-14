//! Local-witness rules S-1 through S-9 and the keyed-fetch ban.
//!
//! Witnesses are built from leaves the wallet already holds. Restore reads the
//! public upper tree levels and an aligned epoch delta through unkeyed `/sync`
//! reads. A request never carries a leaf index, path, chunk, chunk list,
//! snapshot, tag, note commitment, address, or owned-note id, and the wallet's
//! [`crate::TreeSnapshot`] is built locally from what those reads returned.
//!
//! [`SyncServer::handle`] is the only way a node answers a sync read, and
//! [`SyncClient`] is the only way a wallet builds one or accepts the answer.
//! `node/src/fs1_sync.js` applies the same route and keyed-fetch rules to the
//! node's HTTP routes; `vectors/sync_routes.txt` is checked by both.

/// Blocks per sync epoch. Shared with `node/src/fs1_sync.js`.
pub const SYNC_EPOCH: u64 = 64;

/// Epoch-aligned sync window. `from` is inclusive and `to` is exclusive.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SyncRange {
  /// First block height.
  pub from: u64,
  /// Height just past the window.
  pub to: u64,
}

/// What a client asked the sync channel for.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SyncRequest {
  /// Aligned window.
  pub range: Option<SyncRange>,
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
  pub tag: Option<Vec<u8>>,
  /// Note commitment, if the caller tried to name one.
  pub note_commit: Option<Vec<u8>>,
  /// Address bytes, if the caller tried to name one.
  pub address: Option<Vec<u8>>,
  /// Owned-note id, if the caller tried to name one.
  pub owned_note: Option<u64>,
}

/// Why a sync read was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SyncReject {
  /// S-7. Not a sync route, or a witness lookup route.
  Route,
  /// The keyed-fetch ban, S-3, or S-4.
  KeyedFetch,
  /// S-1. The window is not on the epoch grid.
  Range,
  /// S-8. The body did not start with a well-formed prefix.
  Prefix,
  /// S-6 and S-9. The folded root is not the header root.
  Fold,
  /// The server has no header root for this window yet.
  Unknown,
}

/// Routes the sync channel serves. There is no path, witness, leaf, or bucket route.
pub const ROUTES: &[&str] = &["/sync", "/tx"];

/// Witness and wallet-snapshot lookup routes. Always refused.
///
/// A [`crate::TreeSnapshot`] names the leaf chunks a wallet holds, so it is
/// built only inside the wallet; no node serves one.
pub const BANNED_ROUTES: &[&str] = &["/path", "/witness", "/leaf", "/bucket", "/snapshot", "/chunk", "/chunks"];

/// Query names that would key a fetch to one note. Shared with `node/src/fs1_sync.js`.
pub const KEYED_PARAMS: &[&str] = &[
  "leaf", "index", "chunk", "path", "tag", "spendtag", "commit", "notecommit", "address", "owned",
  "note", "send", "scanhit", "clear", "snapshot", "chunks", "chunkids", "held",
];

/// Most epochs one sync read may span. Shared with `node/src/fs1_sync.js`.
pub const SYNC_MAX_EPOCHS: u64 = 16;

/// S-1. Both ends sit on the epoch grid, and the window is non-empty and at
/// most [`SYNC_MAX_EPOCHS`] long.
pub fn range_aligned(range: SyncRange, epoch: u64) -> bool {
  epoch != 0 &&
    range.to > range.from &&
    range.from % epoch == 0 &&
    range.to % epoch == 0 &&
    range.to - range.from <= SYNC_MAX_EPOCHS.saturating_mul(epoch)
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

/// S-7. Reject `/path`, `/witness`, `/leaf`, `/bucket`, and anything off the route list.
pub fn route_allowed(path: &str) -> bool {
  !BANNED_ROUTES.contains(&path) && ROUTES.contains(&path)
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

fn read_prefix(body: &[u8]) -> Option<(SyncRange, [u8; 32])> {
  if body.len() < SYNC_PREFIX_LEN {
    return None;
  }
  let from = u64::from_le_bytes(body[.. 8].try_into().ok()?);
  let to = u64::from_le_bytes(body[8 .. 16].try_into().ok()?);
  let mut root = [0u8; 32];
  root.copy_from_slice(&body[16 .. SYNC_PREFIX_LEN]);
  Some((SyncRange { from, to }, root))
}

/// Parse a query string into a request. Every keyed name is recorded so the ban can see it.
pub fn parse_query(query: &str) -> SyncRequest {
  let mut request = SyncRequest::default();
  let mut from = None;
  let mut to = None;
  for pair in query.split('&').filter(|pair| !pair.is_empty()) {
    let mut split = pair.splitn(2, '=');
    let name = split.next().unwrap_or("").to_ascii_lowercase();
    let value = split.next().unwrap_or("");
    let number = value.parse::<u64>().ok();
    match name.as_str() {
      "from" => from = number,
      "to" => to = number,
      "leaf" | "index" => request.leaf_index = Some(number.unwrap_or(u64::MAX)),
      "chunk" | "chunks" | "chunkids" | "snapshot" | "held" => request.chunk = Some(number.unwrap_or(u64::MAX)),
      "path" => request.path = Some(value.as_bytes().to_vec()),
      "tag" | "spendtag" => request.tag = Some(value.as_bytes().to_vec()),
      "commit" | "notecommit" => request.note_commit = Some(value.as_bytes().to_vec()),
      "address" => request.address = Some(value.as_bytes().to_vec()),
      "owned" | "note" => request.owned_note = Some(number.unwrap_or(u64::MAX)),
      "send" => request.on_send = true,
      "scanhit" => request.on_scan_hit = true,
      "clear" => request.clear_fallback = true,
      _ => {}
    }
  }
  if let (Some(from), Some(to)) = (from, to) {
    request.range = Some(SyncRange { from, to });
  }
  request
}

/// Node side of the sync channel.
pub struct SyncServer<R, B>
where
  R: Fn(SyncRange) -> Option<[u8; 32]>,
  B: Fn(SyncRange) -> Vec<u8>,
{
  epoch: u64,
  header_root: R,
  body: B,
}

impl<R, B> SyncServer<R, B>
where
  R: Fn(SyncRange) -> Option<[u8; 32]>,
  B: Fn(SyncRange) -> Vec<u8>,
{
  /// `header_root` returns `RT[A]` at the window end. `body` returns the opaque epoch delta.
  pub fn new(epoch: u64, header_root: R, body: B) -> Self {
    Self { epoch, header_root, body }
  }

  /// Answer one read. S-7, the keyed-fetch ban, S-1, then the S-8 prefix and body.
  pub fn handle(&self, path: &str, query: &str) -> Result<Vec<u8>, SyncReject> {
    if !route_allowed(path) || path != "/sync" {
      return Err(SyncReject::Route);
    }
    let request = parse_query(query);
    if keyed_fetch_rejected(&request) {
      return Err(SyncReject::KeyedFetch);
    }
    let range = request.range.ok_or(SyncReject::Range)?;
    if !range_aligned(range, self.epoch) {
      return Err(SyncReject::Range);
    }
    let root = (self.header_root)(range).ok_or(SyncReject::Unknown)?;
    let mut out = sync_prefix(range, &root).to_vec();
    out.extend((self.body)(range));
    Ok(out)
  }
}

/// Why the wallet is about to touch the network.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClientIntent {
  /// The scheduled epoch sync.
  Scheduled,
  /// The user pressed send.
  Send,
  /// A scan matched one of the wallet's notes.
  ScanHit,
}

/// Wallet side of the sync channel.
pub struct SyncClient {
  epoch: u64,
  birthday: u64,
}

impl SyncClient {
  /// S-2. The wallet's first read starts at its quantised birthday.
  pub fn new(birth_height: u64, epoch: u64) -> Option<Self> {
    Some(Self { epoch, birthday: quantise_birthday(birth_height, epoch)? })
  }

  /// Quantised birthday.
  pub fn birthday(&self) -> u64 {
    self.birthday
  }

  /// S-1 and S-3. The request for the epoch that starts at `from`, as `(path, query)`.
  /// A send or a scan hit never fetches. `from` is snapped down to the grid.
  pub fn request(&self, intent: ClientIntent, from: u64) -> Option<(&'static str, String)> {
    if intent != ClientIntent::Scheduled {
      return None;
    }
    let start = quantise_birthday(from.max(self.birthday), self.epoch)?;
    Some(("/sync", format!("from={start}&to={}", start + self.epoch)))
  }

  /// S-4. A post goes to the sync channel's `/tx` route. There is no second channel.
  pub fn post_route(&self) -> &'static str {
    "/tx"
  }

  /// S-5. A gap is retried over the same request.
  pub fn retry(&self, request: &(&'static str, String)) -> (&'static str, String) {
    request.clone()
  }

  /// S-6, S-8, and S-9. Accept a body only when its prefix is well formed,
  /// aligned, and its header root equals the root the worker folded.
  pub fn accept(&self, body: &[u8], folded: &[u8; 32]) -> Result<SyncRange, SyncReject> {
    let (range, root) = read_prefix(body).ok_or(SyncReject::Prefix)?;
    if !range_aligned(range, self.epoch) {
      return Err(SyncReject::Range);
    }
    if &root != folded {
      return Err(SyncReject::Fold);
    }
    Ok(range)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn root_of(range: SyncRange) -> [u8; 32] {
    let mut root = [0u8; 32];
    root[.. 8].copy_from_slice(&range.to.to_le_bytes());
    root[31] = 0x5a;
    root
  }

  fn server() -> SyncServer<impl Fn(SyncRange) -> Option<[u8; 32]>, impl Fn(SyncRange) -> Vec<u8>> {
    SyncServer::new(
      SYNC_EPOCH,
      |range: SyncRange| if range.to <= 20 * SYNC_EPOCH { Some(root_of(range)) } else { None },
      |range: SyncRange| vec![0xcc; usize::try_from(range.to - range.from).unwrap()],
    )
  }

  #[test]
  fn client_and_server_round_trip_one_aligned_epoch() {
    let srv = server();
    let client = SyncClient::new(150, SYNC_EPOCH).expect("client");
    assert_eq!(client.birthday(), 128);
    let request = client.request(ClientIntent::Scheduled, 0).expect("scheduled read");
    assert_eq!(request, ("/sync", "from=128&to=192".to_string()));
    let body = srv.handle(request.0, &request.1).expect("served");
    assert_eq!(body.len(), SYNC_PREFIX_LEN + usize::try_from(SYNC_EPOCH).unwrap());
    let range = SyncRange { from: 128, to: 192 };
    assert_eq!(client.accept(&body, &root_of(range)), Ok(range));
    assert_eq!(client.accept(&body, &[0u8; 32]), Err(SyncReject::Fold));
    assert_eq!(client.accept(&body[.. 10], &root_of(range)), Err(SyncReject::Prefix));
    assert_eq!(client.request(ClientIntent::Scheduled, 200).unwrap().1, "from=192&to=256");
  }

  #[test]
  fn s3_send_and_scan_hit_never_build_a_request() {
    let client = SyncClient::new(0, SYNC_EPOCH).expect("client");
    assert_eq!(client.request(ClientIntent::Send, 0), None);
    assert_eq!(client.request(ClientIntent::ScanHit, 0), None);
    assert!(SyncClient::new(5, 0).is_none());
  }

  #[test]
  fn s4_post_uses_a_route_on_the_sync_channel() {
    let client = SyncClient::new(0, SYNC_EPOCH).expect("client");
    assert!(ROUTES.contains(&client.post_route()));
    assert_eq!(server().handle("/tx", ""), Err(SyncReject::Route));
  }

  #[test]
  fn s5_retry_is_the_same_request() {
    let client = SyncClient::new(0, SYNC_EPOCH).expect("client");
    let request = client.request(ClientIntent::Scheduled, 64).unwrap();
    let again = client.retry(&request);
    assert_eq!(again, request);
    assert_eq!(server().handle(again.0, &again.1), server().handle(request.0, &request.1));
  }

  #[test]
  fn s8_prefix_width_is_the_same_for_every_window() {
    let srv = server();
    let a = srv.handle("/sync", "from=0&to=64").unwrap();
    let b = srv.handle("/sync", "from=64&to=640").unwrap();
    assert_eq!(&a[16 .. SYNC_PREFIX_LEN], &root_of(SyncRange { from: 0, to: 64 }));
    assert_eq!(&b[16 .. SYNC_PREFIX_LEN], &root_of(SyncRange { from: 64, to: 640 }));
    assert_eq!(srv.handle("/sync", "from=1280&to=1344"), Err(SyncReject::Unknown));
  }

  /// Each line of `vectors/sync_routes.txt` is `path<TAB>query<TAB>verdict`.
  #[test]
  fn shared_route_vectors_match_the_server() {
    let srv = server();
    let mut seen = 0;
    for line in include_str!("../vectors/sync_routes.txt").lines() {
      if line.is_empty() || line.starts_with('#') {
        continue;
      }
      let cols: Vec<&str> = line.split('\t').collect();
      assert_eq!(cols.len(), 3, "{line}");
      let got = match srv.handle(cols[0], cols[1]) {
        Ok(_) => "ok",
        Err(SyncReject::Route) => "route",
        Err(SyncReject::KeyedFetch) => "keyed",
        Err(SyncReject::Range) => "range",
        Err(other) => panic!("{line} {other:?}"),
      };
      assert_eq!(got, cols[2], "{line}");
      seen += 1;
    }
    assert!(seen >= 20, "{seen}");
  }

  #[test]
  fn every_keyed_name_is_banned_through_the_server() {
    let srv = server();
    for name in KEYED_PARAMS {
      let query = format!("from=0&to=64&{name}=1");
      assert_eq!(srv.handle("/sync", &query), Err(SyncReject::KeyedFetch), "{name}");
      let upper = format!("from=0&to=64&{}=1", name.to_ascii_uppercase());
      assert_eq!(srv.handle("/sync", &upper), Err(SyncReject::KeyedFetch), "{name}");
    }
  }
}
